"""Package or restore the exact project data without changing source bytes.

Uses only the Python standard library. The snapshot includes normalized events,
derived views, CUSTOM runs and raw sources; the official download contains only
the original MC1/MC2 packages and cannot replace the project snapshot.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import zipfile

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = PROJECT_ROOT / "datasets" / "manifest.json"
CHUNK_BYTES = 1024 * 1024
OFFICIAL_REVISION = "450c2b1414bde06be45e9f409b255297b0aac7f8"
OFFICIAL_FILES = (
    ("MC1", 195336, "364e1d31cc59337f25a0b2c62d1cb59c1252efa82c617327919468c1457b6de8"),
    ("MC2", 3512803, "15d5599ad25de5119b76c3b393699763988023350b6997a3ba90ace8a87c959b"),
)


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def publish_file(source: Path, target: Path) -> None:
    """Publish atomically with permissions inherited from the destination.

    Moving a file straight out of TemporaryDirectory preserves that private
    directory's Windows ACL and can make generated data unreadable to the user.
    A sibling temporary file inherits the destination directory's permissions.
    """
    sibling = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".data-publish-", dir=target.parent, delete=False) as output:
            sibling = Path(output.name)
            with source.open("rb") as handle:
                shutil.copyfileobj(handle, output, CHUNK_BYTES)
        os.replace(sibling, target)
    finally:
        if sibling is not None:
            sibling.unlink(missing_ok=True)


def data_path(root: Path, relative: str) -> Path:
    """Accept portable paths only and keep symlink resolution inside data/."""
    parts = PurePosixPath(relative)
    if (
        not relative
        or "\\" in relative
        or ":" in relative
        or parts.is_absolute()
        or any(part in (".", "..") for part in relative.split("/"))
    ):
        raise ValueError(f"Invalid data path: {relative!r}")
    data_root = (root / "data").resolve()
    target = data_root.joinpath(*parts.parts)
    if not target.resolve().is_relative_to(data_root):
        raise ValueError(f"Data path escapes data/: {relative}")
    return target


def read_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1 or not manifest.get("files"):
        raise ValueError("Unsupported or empty data manifest")
    archive_name = manifest["archive"]["filename"]
    if Path(archive_name).name != archive_name or "/" in archive_name or "\\" in archive_name:
        raise ValueError("Archive filename must be a basename")
    names = [entry["path"] for entry in manifest["files"]]
    if len(set(names)) != len(names):
        raise ValueError("Duplicate data paths in manifest")
    for name in names:
        data_path(path.parent, name)
    return manifest


def matches(path: Path, entry: dict) -> bool:
    return path.is_file() and path.stat().st_size == entry["bytes"] and sha256(path) == entry["sha256"]


def pack(root: Path, manifest_path: Path) -> dict:
    source_root = root / "data"
    paths = sorted(source_root.rglob("*"))
    if any(path.is_symlink() for path in paths) or source_root.is_symlink():
        raise ValueError("Snapshot source must not contain symlinks")
    paths = [path for path in paths if path.is_file()]
    if not paths:
        raise ValueError(f"No data files found: {source_root}")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    archive_path = manifest_path.parent / "data-snapshot.zip"
    entries = []

    # Fixed member metadata makes unchanged snapshots byte-for-byte repeatable.
    with tempfile.TemporaryDirectory(prefix="data-pack-", dir=manifest_path.parent) as temporary:
        staged = Path(temporary) / archive_path.name
        with zipfile.ZipFile(staged, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in paths:
                relative = path.relative_to(source_root).as_posix()
                info = zipfile.ZipInfo(f"data/{relative}", date_time=(2026, 1, 1, 0, 0, 0))
                info.create_system = 3  # Normalize ZIP platform metadata across Windows and Unix.
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                digest = hashlib.sha256()
                size = 0
                with path.open("rb") as source, archive.open(info, "w") as target:
                    while chunk := source.read(CHUNK_BYTES):
                        digest.update(chunk)
                        size += len(chunk)
                        target.write(chunk)
                entries.append({"path": relative, "bytes": size, "sha256": digest.hexdigest()})
        manifest = {
            "schema_version": 1,
            "archive": {
                "filename": archive_path.name,
                "bytes": staged.stat().st_size,
                "sha256": sha256(staged),
            },
            "unpacked_bytes": sum(entry["bytes"] for entry in entries),
            "files": entries,
            "official_sources": [
                {
                    "dataset": dataset,
                    "path": f"raw/official_data/{dataset}/VAST_Challenge_2026_{dataset}.zip",
                    "url": (
                        "https://raw.githubusercontent.com/vast-challenge/2026-data/"
                        f"{OFFICIAL_REVISION}/VAST_Challenge_2026_{dataset}.zip"
                    ),
                    "bytes": size,
                    "sha256": checksum,
                }
                for dataset, size, checksum in OFFICIAL_FILES
            ],
        }
        staged_manifest = Path(temporary) / "manifest.json"
        staged_manifest.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        publish_file(staged, archive_path)
        publish_file(staged_manifest, manifest_path)
    print(f"Packed {len(entries)} files: {archive_path.stat().st_size / 1024**2:.2f} MiB -> {archive_path}")
    return manifest


def download(url: str, target: Path, expected: dict) -> None:
    """Download once, bound the byte count and verify before publishing a file."""
    if urlparse(url).scheme != "https":
        raise ValueError("Downloads require an HTTPS URL")
    if target.exists():
        if matches(target, expected):
            print(f"Already verified: {target}")
            return
        raise ValueError(f"Existing file differs; leaving it unchanged: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="data-download-", dir=target.parent) as temporary:
        partial = Path(temporary) / "download.part"
        request = Request(url, headers={"User-Agent": "VAST-2026-data-setup/1"})
        with urlopen(request, timeout=30) as response, partial.open("wb") as handle:
            if urlparse(response.geturl()).scheme != "https":
                raise ValueError("Download redirected away from HTTPS")
            total = 0
            while chunk := response.read(CHUNK_BYTES):
                total += len(chunk)
                if total > expected["bytes"]:
                    raise ValueError("Download is larger than the pinned manifest size")
                handle.write(chunk)
        if not matches(partial, expected):
            raise ValueError("Download size or SHA-256 does not match the manifest")
        publish_file(partial, target)
    print(f"Downloaded and verified: {target}")


def verify(root: Path, manifest: dict) -> None:
    invalid = [entry["path"] for entry in manifest["files"] if not matches(data_path(root, entry["path"]), entry)]
    if invalid:
        raise ValueError("Missing or different data files:\n  " + "\n  ".join(invalid))
    print(f"Verified {len(manifest['files'])} files, including source bytes and derived views")


def restore(root: Path, manifest_path: Path, url: str | None = None) -> None:
    manifest = read_manifest(manifest_path)
    missing = []
    # Check every existing destination first; never partially restore over a conflict.
    for entry in manifest["files"]:
        target = data_path(root, entry["path"])
        if target.exists():
            if not matches(target, entry):
                raise ValueError(f"Existing data differs; leaving data/ unchanged: {target}")
        else:
            missing.append(entry)
    if not missing:
        print(f"All {len(manifest['files'])} data files already match; no download or extraction needed")
        return
    archive_path = manifest_path.parent / manifest["archive"]["filename"]
    if not archive_path.exists() and url:
        download(url, archive_path, manifest["archive"])
    if not archive_path.exists():
        raise ValueError(f"Snapshot missing: {archive_path}; provide --url for a published snapshot")
    if not matches(archive_path, manifest["archive"]):
        raise ValueError("Snapshot size or SHA-256 does not match the manifest")
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="data-restore-", dir=root) as temporary:
        staged_root = Path(temporary)
        with zipfile.ZipFile(archive_path) as archive:
            expected_names = {f"data/{entry['path']}" for entry in manifest["files"]}
            members = archive.infolist()
            if len(members) != len(expected_names) or {member.filename for member in members} != expected_names:
                raise ValueError("Snapshot members differ from the manifest")
            # Only extract declared paths; the per-file byte count bounds decompression.
            for entry in missing:
                member = archive.getinfo(f"data/{entry['path']}")
                if member.file_size != entry["bytes"]:
                    raise ValueError(f"Unpacked size differs: {entry['path']}")
                staged = data_path(staged_root, entry["path"])
                staged.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, staged.open("wb") as target:
                    shutil.copyfileobj(source, target, CHUNK_BYTES)
                if not matches(staged, entry):
                    raise ValueError(f"Unpacked SHA-256 differs: {entry['path']}")
        # All new files are verified before any enter the destination data directory.
        for entry in missing:
            target = data_path(root, entry["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            publish_file(data_path(staged_root, entry["path"]), target)
    print(f"Restored {len(missing)} files; existing matching files were preserved")
    verify(root, manifest)


def download_official(root: Path, manifest: dict) -> None:
    for entry in manifest["official_sources"]:
        download(entry["url"], data_path(root, entry["path"]), entry)
    print("Official raw packages only. Use restore for project-ready events, CUSTOM and derived views.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("pack", "restore", "verify", "download-official"))
    parser.add_argument("--root", type=Path, default=PROJECT_ROOT, help="Project root containing data/")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--url", help="HTTPS location of the exact snapshot when the local ZIP is absent")
    args = parser.parse_args()
    root = args.root.resolve()
    manifest_path = args.manifest.resolve()
    try:
        if args.url and args.command != "restore":
            raise ValueError("--url is only supported with restore")
        if args.command == "pack":
            pack(root, manifest_path)
        elif args.command == "restore":
            restore(root, manifest_path, args.url)
        elif args.command == "verify":
            verify(root, read_manifest(manifest_path))
        else:
            download_official(root, read_manifest(manifest_path))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"Data setup failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
