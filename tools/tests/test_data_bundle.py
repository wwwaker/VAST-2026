"""Integrity and preservation checks for the data distribution commands."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "data_bundle.py"
SPEC = importlib.util.spec_from_file_location("data_bundle", SCRIPT)
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


class DataBundleTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.target = self.root / "target"
        self.manifest_path = self.root / "package" / "manifest.json"
        self.files = {
            "process/events.jsonl": '{"text":"中文","event_id":1}\r\n'.encode("utf-8"),
            "process/views.json": b'{"offset":29}\n',
            "raw/package.zip": b"original bytes\x00\xff",
        }
        for relative, content in self.files.items():
            path = self.source / "data" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        with contextlib.redirect_stdout(io.StringIO()):
            self.manifest = bundle.pack(self.source, self.manifest_path)
        self.archive = self.manifest_path.parent / "data-snapshot.zip"

    def restore(self):
        with contextlib.redirect_stdout(io.StringIO()):
            bundle.restore(self.target, self.manifest_path)

    def write_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_round_trip_preserves_bytes_and_is_idempotent(self):
        self.restore()
        for relative, content in self.files.items():
            self.assertEqual((self.target / "data" / relative).read_bytes(), content)
        timestamps = {p: p.stat().st_mtime_ns for p in (self.target / "data").rglob("*") if p.is_file()}
        self.archive.unlink()
        self.restore()  # Matching data does not need the archive or network.
        self.assertEqual(timestamps, {p: p.stat().st_mtime_ns for p in timestamps})

    def test_pack_is_reproducible(self):
        original = self.archive.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            again = bundle.pack(self.source, self.manifest_path)
        self.assertEqual(original, self.archive.read_bytes())
        self.assertEqual(self.manifest, again)

    def test_conflicting_file_prevents_any_restore(self):
        conflict = self.target / "data/process/views.json"
        conflict.parent.mkdir(parents=True)
        conflict.write_text("local edits", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Existing data differs"):
            self.restore()
        self.assertEqual(conflict.read_text(), "local edits")
        self.assertFalse((self.target / "data/process/events.jsonl").exists())

    def test_corrupt_archive_is_rejected_before_extraction(self):
        self.archive.write_bytes(b"invalid archive")
        with self.assertRaisesRegex(ValueError, "Snapshot size or SHA-256"):
            self.restore()
        self.assertFalse((self.target / "data").exists())

    def test_incorrect_member_hash_leaves_destination_untouched(self):
        self.manifest["files"][-1]["sha256"] = "0" * 64
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "Unpacked SHA-256"):
            self.restore()
        self.assertFalse((self.target / "data").exists())

    def test_unexpected_archive_member_is_rejected(self):
        with zipfile.ZipFile(self.archive, "a") as archive:
            archive.writestr("../outside.txt", "unexpected")
        self.manifest["archive"]["bytes"] = self.archive.stat().st_size
        self.manifest["archive"]["sha256"] = bundle.sha256(self.archive)
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "Snapshot members differ"):
            self.restore()
        self.assertFalse((self.target / "outside.txt").exists())

    def test_manifest_paths_cannot_escape_data_directory(self):
        for relative in ("../outside", "/absolute", "C:/absolute", "nested\\file", "a/../file"):
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                bundle.data_path(self.target, relative)

    def test_missing_files_restore_without_changing_existing_matches(self):
        existing = self.target / "data/process/views.json"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(self.files["process/views.json"])
        timestamp = existing.stat().st_mtime_ns
        self.restore()
        self.assertEqual(existing.stat().st_mtime_ns, timestamp)
        with contextlib.redirect_stdout(io.StringIO()):
            bundle.verify(self.target, self.manifest)

    def test_verify_detects_changed_source_bytes(self):
        self.restore()
        (self.target / "data/process/events.jsonl").write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Missing or different data files"):
            bundle.verify(self.target, self.manifest)

    def test_download_rejects_insecure_url_and_conflicting_file(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            bundle.download("http://example.com/file.zip", self.archive, self.manifest["archive"])
        self.archive.write_bytes(b"local version")
        with self.assertRaisesRegex(ValueError, "Existing file differs"):
            bundle.download("https://example.com/file.zip", self.archive, self.manifest["archive"])
        self.assertEqual(self.archive.read_bytes(), b"local version")

    def test_restore_downloads_and_verifies_missing_snapshot(self):
        payload = self.archive.read_bytes()
        self.archive.unlink()
        response = io.BytesIO(payload)
        response.geturl = lambda: "https://example.com/data-snapshot.zip"
        with mock.patch.object(bundle, "urlopen", return_value=response) as request:
            with contextlib.redirect_stdout(io.StringIO()):
                bundle.restore(self.target, self.manifest_path, response.geturl())
                bundle.download(response.geturl(), self.archive, self.manifest["archive"])
            request.assert_called_once()  # A verified local file does not download again.
        self.assertEqual(self.archive.read_bytes(), payload)
        for relative, content in self.files.items():
            self.assertEqual((self.target / "data" / relative).read_bytes(), content)

    def test_download_rejects_wrong_bytes_without_publishing(self):
        original = self.archive.read_bytes()
        payloads = (original[:-1], original + b"extra", b"x" * len(original))
        for index, payload in enumerate(payloads):
            with self.subTest(index=index):
                target = self.root / f"download-{index}.zip"
                response = io.BytesIO(payload)
                response.geturl = lambda: "https://example.com/file.zip"
                with mock.patch.object(bundle, "urlopen", return_value=response):
                    with self.assertRaises(ValueError):
                        bundle.download(response.geturl(), target, self.manifest["archive"])
                self.assertFalse(target.exists())
                self.assertFalse(list(self.root.glob("data-download-*")))

    def test_download_rejects_redirect_to_insecure_url(self):
        response = io.BytesIO(self.archive.read_bytes())
        response.geturl = lambda: "http://example.com/file.zip"
        target = self.root / "redirect.zip"
        with mock.patch.object(bundle, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "redirected away from HTTPS"):
                bundle.download("https://example.com/file.zip", target, self.manifest["archive"])
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
