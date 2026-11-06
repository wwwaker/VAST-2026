"""派生数据（final-data/process/views）接入与版本核验。

派生数据不是源事实：manifest 里的 SHA-256 与当前 data/processed 源事件不一致时，
只能关闭该能力，不能沿用旧结论。路径一律相对 MAS_ARTIFACT_ROOT（默认项目根/final-data）。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone

from ..config import ARTIFACT_ROOT

MANIFEST_REL = "process/views/manifest.json"
MANIFEST_KEY = {"MC1": "mc1", "MC2": "mc2", "CUSTOM": "custom"}
METHOD_VERSION = "views-1.0"


@dataclass
class ArtifactBundle:
    dataset_id: str
    status: str  # ok / missing / hash_mismatch / stale_source
    detail: str
    artifact_id: str | None = None
    relative_path: str | None = None
    sha256: str | None = None
    views: dict | None = None


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve(relative: str) -> str:
    """把 manifest 路径限制在 artifact root 内，阻止 ../ 逃逸。"""
    root = os.path.abspath(ARTIFACT_ROOT)
    path = os.path.abspath(os.path.join(root, relative))
    if os.path.commonpath([root, path]) != root:
        raise ValueError(f"派生文件路径越界：{relative}")
    return path


def read_manifest() -> dict | None:
    path = os.path.join(ARTIFACT_ROOT, MANIFEST_REL)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def verify_all() -> dict:
    """健康检查用：只做 manifest 内声明的文件哈希，不加载大 JSON。"""
    manifest = read_manifest()
    if manifest is None:
        return {"status": "missing", "detail": f"缺少 {MANIFEST_REL}", "files": []}
    files = []
    for entry in manifest.get("files", []):
        relative = entry.get("path")
        expected = entry.get("sha256")
        try:
            path = _resolve(relative)
        except ValueError as exc:
            files.append({"path": relative, "status": "outside_root", "detail": str(exc)})
            continue
        if not os.path.exists(path):
            files.append({"path": relative, "status": "missing", "expected": expected})
            continue
        actual = _sha256(path)
        files.append(
            {
                "path": relative,
                "status": "ok" if actual == expected else "hash_mismatch",
                "expected": expected,
                "actual": actual,
            }
        )
    status = "ok" if all(item["status"] == "ok" for item in files) else "stale"
    return {"status": status, "files": files}


def load_bundle(dataset_id: str, source_events_sha256: str | None) -> ArtifactBundle:
    manifest = read_manifest()
    if manifest is None:
        return ArtifactBundle(dataset_id, "missing", f"缺少 {MANIFEST_REL}")

    key = MANIFEST_KEY.get(dataset_id)
    entry = (manifest.get("datasets") or {}).get(key or "")
    if not entry or not entry.get("views"):
        return ArtifactBundle(dataset_id, "missing", f"manifest 没有 {key} 的 views 条目")

    expected_source = entry.get("source_sha256")
    if source_events_sha256 and expected_source and source_events_sha256 != expected_source:
        return ArtifactBundle(
            dataset_id,
            "stale_source",
            "源事件哈希与派生 manifest 不一致，已关闭该派生能力",
        )

    relative = entry["views"]
    try:
        path = _resolve(relative)
    except ValueError as exc:
        return ArtifactBundle(dataset_id, "hash_mismatch", str(exc), relative_path=relative)

    if not os.path.exists(path):
        return ArtifactBundle(dataset_id, "missing", f"缺少派生文件 {relative}", relative_path=relative)

    declared = next(
        (item.get("sha256") for item in manifest.get("files", []) if item.get("path") == relative),
        None,
    )
    actual = _sha256(path)
    if declared and declared != actual:
        return ArtifactBundle(
            dataset_id,
            "hash_mismatch",
            f"{relative} 哈希与 manifest 不一致",
            relative_path=relative,
            sha256=actual,
        )

    try:
        with open(path, "r", encoding="utf-8") as handle:
            views = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        return ArtifactBundle(
            dataset_id, "hash_mismatch", f"读取派生文件失败：{exc}", relative_path=relative
        )

    return ArtifactBundle(
        dataset_id=dataset_id,
        status="ok",
        detail=f"{relative} 哈希核验通过",
        artifact_id=f"{dataset_id}:{relative}",
        relative_path=relative,
        sha256=actual,
        views=views,
    )


def persist(conn, bundle: ArtifactBundle) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO artifact_sources "
        "(artifact_id, dataset_id, relative_path, sha256, method_version, status, verified_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (
            bundle.artifact_id or f"{bundle.dataset_id}:{bundle.relative_path or 'missing'}",
            bundle.dataset_id,
            bundle.relative_path or "",
            bundle.sha256 or "",
            METHOD_VERSION,
            bundle.status,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ),
    )


def status_of(conn, dataset_id: str) -> dict:
    row = conn.execute(
        "SELECT status, relative_path, sha256, verified_at FROM artifact_sources "
        "WHERE dataset_id=? ORDER BY verified_at DESC LIMIT 1",
        (dataset_id,),
    ).fetchone()
    if row is None:
        return {"status": "not_configured", "relative_path": None, "sha256": None, "verified_at": None}
    return {
        "status": row["status"],
        "relative_path": row["relative_path"],
        "sha256": row["sha256"],
        "verified_at": row["verified_at"],
    }
