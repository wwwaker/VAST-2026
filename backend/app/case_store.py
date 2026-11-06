"""案例快照与结构化结论（S5）。

与笔记共用 notes.db：主库会被 --fresh 重建，人工结论不能被冲掉。
快照只存“恢复分析所需的状态”，不存 DOM 坐标、tooltip 或播放中间态。
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone

from .notes_store import notes_conn

SCHEMA_VERSION = 1
FINDING_STATUS = ("hypothesis", "supported", "inconclusive")
EVIDENCE_ROLES = ("support", "counter", "uncertain")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def evidence_hash(dataset_id: str, event_id: str, timestamp_raw: str | None, details_json: str | None) -> str:
    payload = f"{dataset_id}|{event_id}|{timestamp_raw or ''}|{details_json or ''}"
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def create_case(dataset_id: str, title: str, snapshot: dict, data_version: str) -> dict:
    case_id = _new_id("case")
    now = _now()
    body = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
    with notes_conn() as conn:
        conn.execute(
            "INSERT INTO case_snapshots "
            "(case_id, dataset_id, title, schema_version, data_version, snapshot_json, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (case_id, dataset_id, title, SCHEMA_VERSION, data_version, body, now, now),
        )
    return get_case(case_id) or {}


def get_case(case_id: str) -> dict | None:
    with notes_conn() as conn:
        row = conn.execute("SELECT * FROM case_snapshots WHERE case_id=?", (case_id,)).fetchone()
    if row is None:
        return None
    item = dict(row)
    item["snapshot"] = json.loads(item.pop("snapshot_json"))
    return item


def list_cases(dataset_id: str, limit: int = 100) -> list[dict]:
    with notes_conn() as conn:
        rows = conn.execute(
            "SELECT case_id, dataset_id, title, schema_version, data_version, created_at, updated_at "
            "FROM case_snapshots WHERE dataset_id=? ORDER BY updated_at DESC LIMIT ?",
            (dataset_id, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def delete_case(case_id: str) -> bool:
    with notes_conn() as conn:
        conn.execute("DELETE FROM finding_evidence WHERE finding_id IN "
                     "(SELECT finding_id FROM findings WHERE case_id=?)", (case_id,))
        conn.execute("DELETE FROM findings WHERE case_id=?", (case_id,))
        cur = conn.execute("DELETE FROM case_snapshots WHERE case_id=?", (case_id,))
    return cur.rowcount > 0


def create_finding(
    case_id: str,
    claim: str,
    status: str,
    explanation: str,
    limitations: str | None,
    evidence: list[dict],
) -> dict:
    finding_id = _new_id("finding")
    now = _now()
    with notes_conn() as conn:
        conn.execute(
            "INSERT INTO findings (finding_id, case_id, claim, status, explanation, limitations, "
            "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (finding_id, case_id, claim, status, explanation, limitations, now, now),
        )
        for item in evidence:
            conn.execute(
                "INSERT OR REPLACE INTO finding_evidence "
                "(finding_id, dataset_id, reference_kind, reference_id, role, field_pointer, excerpt, source_hash) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    finding_id,
                    item["dataset_id"],
                    item.get("reference_kind", "event"),
                    item["reference_id"],
                    item["role"],
                    item.get("field_pointer"),
                    item.get("excerpt"),
                    item["source_hash"],
                ),
            )
    return get_finding(finding_id) or {}


def get_finding(finding_id: str) -> dict | None:
    with notes_conn() as conn:
        row = conn.execute("SELECT * FROM findings WHERE finding_id=?", (finding_id,)).fetchone()
        if row is None:
            return None
        evidence = conn.execute(
            "SELECT dataset_id, reference_kind, reference_id, role, field_pointer, excerpt, source_hash "
            "FROM finding_evidence WHERE finding_id=? ORDER BY role, reference_id",
            (finding_id,),
        ).fetchall()
    item = dict(row)
    item["evidence"] = [dict(e) for e in evidence]
    return item


def list_findings(case_id: str) -> list[dict]:
    with notes_conn() as conn:
        rows = conn.execute(
            "SELECT finding_id FROM findings WHERE case_id=? ORDER BY created_at, finding_id",
            (case_id,),
        ).fetchall()
    return [f for f in (get_finding(row["finding_id"]) for row in rows) if f]


def delete_finding(finding_id: str) -> bool:
    with notes_conn() as conn:
        conn.execute("DELETE FROM finding_evidence WHERE finding_id=?", (finding_id,))
        cur = conn.execute("DELETE FROM findings WHERE finding_id=?", (finding_id,))
    return cur.rowcount > 0
