"""CUSTOM 冻结案例（S2 剩余项）。

案例文件把 run_id、配对 ID 与期望审计结果一起写死；导入后如果数据版本变了，
整组标 stale，页面显式提示，不会静默换一组运行来“凑”案例。
期望值对照的是**重算结果**，不是源标签。
"""

from __future__ import annotations

import json
import os
from typing import Any

from . import custom_audit

CASES_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cases", "custom.json")

STATUS_LABELS = {
    "ok": "可用",
    "stale": "数据版本已变",
    "mismatch": "与重算结果不一致",
    "missing_run": "运行不存在",
}


def load_presets(path: str | None = None) -> dict:
    with open(path or CASES_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def _run_events(conn, run_id: str) -> list[dict]:
    out = []
    for row in conn.execute(
        "SELECT * FROM events WHERE dataset_id='CUSTOM' AND run_id=? ORDER BY time_sort_us, event_id",
        (run_id,),
    ).fetchall():
        item = dict(row)
        item["details"] = json.loads(item["details_json"]) if item["details_json"] else {}
        out.append(item)
    return out


def _run_row(conn, run_id: str):
    return conn.execute(
        "SELECT run_id, model, fixture, scenario, observed, event_count, start_us, end_us "
        "FROM runs WHERE dataset_id='CUSTOM' AND run_id=?",
        (run_id,),
    ).fetchone()


def evaluate_case(conn, case: dict) -> dict:
    """单条案例：运行/配对/期望值三项分别判定，任何一项不符都保留差异明细。"""
    run = _run_row(conn, case["run_id"])
    base: dict[str, Any] = {
        "case_id": case["case_id"],
        "title": case["title"],
        "scenario": case.get("scenario"),
        "note": case.get("note"),
        "run_id": case["run_id"],
        "baseline_run_id": case.get("baseline_run_id"),
        "model": case.get("model"),
        "fixture": case.get("fixture"),
        "expected": case.get("expect", {}),
        "evidence": case.get("evidence", {}),
    }

    if run is None:
        base.update({"status": "missing_run", "status_label": STATUS_LABELS["missing_run"], "diffs": []})
        return base

    base.update(
        {
            "run": {
                "run_id": run["run_id"],
                "model": run["model"],
                "fixture": run["fixture"],
                "scenario": run["scenario"],
                "observed": bool(run["observed"]),
                "event_count": run["event_count"],
                "start_us": run["start_us"],
                "end_us": run["end_us"],
            }
        }
    )

    diffs: list[dict] = []
    if case.get("model") and case["model"] != run["model"]:
        diffs.append({"field": "model", "expected": case["model"], "actual": run["model"]})
    if case.get("fixture") and case["fixture"] != run["fixture"]:
        diffs.append({"field": "fixture", "expected": case["fixture"], "actual": run["fixture"]})

    baseline_id = case.get("baseline_run_id")
    if baseline_id:
        baseline = _run_row(conn, baseline_id)
        if baseline is None:
            diffs.append({"field": "baseline_run_id", "expected": baseline_id, "actual": None})
        else:
            base["baseline"] = {
                "run_id": baseline["run_id"],
                "model": baseline["model"],
                "fixture": baseline["fixture"],
                "scenario": baseline["scenario"],
                "event_count": baseline["event_count"],
            }
            pair = conn.execute(
                "SELECT 1 FROM run_pairs WHERE dataset_id='CUSTOM' AND run_id=? AND normal_run_id=?",
                (case["run_id"], baseline_id),
            ).fetchone()
            if pair is None:
                diffs.append(
                    {
                        "field": "run_pairs",
                        "expected": f"{case['run_id']} ↔ {baseline_id}",
                        "actual": "配对表里没有这条组合",
                    }
                )

    audit = custom_audit.audit_run(_run_events(conn, case["run_id"]))
    summary = audit["summary"]
    base["audit"] = summary
    base["loops"] = audit["handoff"]["loops"]
    for field, expected in (case.get("expect") or {}).items():
        actual = summary.get(field)
        if actual != expected:
            diffs.append({"field": field, "expected": expected, "actual": actual})

    status = "ok" if not diffs else "mismatch"
    base.update({"status": status, "status_label": STATUS_LABELS[status], "diffs": diffs})
    return base


def list_cases(conn, data_version: str, path: str | None = None) -> dict:
    payload = load_presets(path)
    file_version = payload.get("data_version")
    stale = bool(file_version and data_version and file_version != data_version)
    items = []
    for case in payload.get("cases", []):
        item = evaluate_case(conn, case)
        if stale:
            item["computed_status"] = item["status"]
            item["status"] = "stale"
            item["status_label"] = STATUS_LABELS["stale"]
        items.append(item)
    return {
        "dataset_id": payload.get("dataset_id", "CUSTOM"),
        "file_data_version": file_version,
        "data_version": data_version,
        "stale": stale,
        "schema_version": payload.get("schema_version"),
        "note": payload.get("note"),
        "items": items,
        "total": len(items),
        "status_counts": {
            key: sum(1 for item in items if item["status"] == key)
            for key in ("ok", "stale", "mismatch", "missing_run")
        },
    }


def get_case(conn, case_id: str, data_version: str, path: str | None = None) -> dict:
    payload = load_presets(path)
    for case in payload.get("cases", []):
        if case["case_id"] != case_id:
            continue
        item = evaluate_case(conn, case)
        if payload.get("data_version") and data_version and payload["data_version"] != data_version:
            item["computed_status"] = item["status"]
            item["status"] = "stale"
            item["status_label"] = STATUS_LABELS["stale"]
        item["evidence_events"] = _evidence_events(conn, case.get("evidence", {}))
        return item
    raise KeyError(case_id)


def _evidence_events(conn, evidence: dict) -> list[dict]:
    ids = [value for value in evidence.values() if isinstance(value, str)]
    if not ids:
        return []
    placeholders = ",".join("?" * len(ids))
    rows = {
        row["event_id"]: row
        for row in conn.execute(
            "SELECT event_id, event_type, time_sort_us, actor_id, version, target_id, details_json "
            f"FROM events WHERE dataset_id='CUSTOM' AND event_id IN ({placeholders})",
            ids,
        )
    }
    items = []
    for role, event_id in evidence.items():
        row = rows.get(event_id)
        if row is None:
            items.append({"role": role, "event_id": event_id, "missing": True})
            continue
        items.append(
            {
                "role": role,
                "event_id": event_id,
                "event_type": row["event_type"],
                "time_us": row["time_sort_us"],
                "actor_id": row["actor_id"],
                "version": row["version"],
                "missing": False,
            }
        )
    return items
