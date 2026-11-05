"""事件列表与事件详情。

列表走 v2 版本化游标（微秒 + event_id 稳定排序），详情才读取 raw。
所有筛选条件由 query.filters 统一生成，不在本文件另写一套。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import event_types
from ..query import filters
from ..query.filters import EventSelection, FilterError, RawFilter

router = APIRouter(prefix="/api/events", tags=["events"])

PREVIEW_KEYS = ("content", "subject", "title", "reason", "feedback", "purpose")


def _preview(details_json: str | None, limit: int = 180) -> str:
    """事件流摘要。先按已知语义取值，取不到再用键值对回落，避免整列都是“无摘要”。"""
    if not details_json:
        return ""
    try:
        details = json.loads(details_json)
    except json.JSONDecodeError:
        return ""
    if not isinstance(details, dict) or not details:
        return ""

    def clip(text: str) -> str:
        text = " ".join(str(text).split())
        return text[:limit] + ("…" if len(text) > limit else "")

    for key in PREVIEW_KEYS:
        value = details.get(key)
        if isinstance(value, str) and value:
            return clip(value)

    # 委派型：{target_agent, task, args:{path}}
    if isinstance(details.get("task"), str):
        agent = details.get("target_agent") or details.get("task_agent")
        args = details.get("args")
        path = args.get("path") if isinstance(args, dict) else None
        tail = f" → {path}" if isinstance(path, str) and path else ""
        return clip(f"[任务] {details['task']}{' → ' + str(agent) if agent else ''}{tail}")

    if isinstance(details.get("content_source"), str):
        return clip(f"[内容源] {details['content_source']}")

    if isinstance(details.get("action"), str):
        return clip(f"[动作] {details['action']} → {details.get('target', '—')}")

    # 回落：拼前若干个短标量（跳过哈希、长路径这类占满整行的值）
    parts: list[str] = []
    for key, value in details.items():
        if isinstance(value, (str, int, float, bool)):
            text = str(value)
            if text and len(text) <= 48:
                parts.append(f"{key}={text}")
        if len(parts) >= 3:
            break
    return clip(" · ".join(parts)) if parts else ""


def summarize(row, dataset: str, annotations: list[dict]) -> dict:
    return {
        "event_id": row["event_id"],
        "timestamp": row["timestamp_normalized"],
        "timestamp_raw": row["timestamp_raw"],
        "time_us": row["time_sort_us"],
        "timezone_status": row["timezone_status"],
        "event_type": row["event_type"],
        "category": event_types.category_of(dataset, row["event_type"]),
        "actor_id": row["actor_id"],
        "actor_label": row["actor_label"],
        "actor_rule": row["actor_rule"],
        "run_id": row["run_id"],
        "version": row["version"],
        "document_id": row["document_id"],
        "channel_id": row["channel_id"],
        "preview": _preview(row["details_json"]),
        "has_deliberation": bool(row["has_deliberation"]),
        "source_missing_id": bool(row["source_missing_id"]),
        "annotations": annotations,
    }


def load_annotations(conn, dataset: str, event_ids: list[str]) -> dict[str, list[dict]]:
    annotations: dict[str, list[dict]] = {}
    if not event_ids:
        return annotations
    placeholders = ",".join("?" * len(event_ids))
    for anno in conn.execute(
        "SELECT ae.event_id, a.scenario, a.anomaly_type, a.observed, a.reason, a.run_id "
        f"FROM annotation_events ae JOIN annotations a ON a.annotation_id=ae.annotation_id "
        f"WHERE ae.dataset_id=? AND ae.event_id IN ({placeholders})",
        [dataset, *event_ids],
    ):
        annotations.setdefault(anno["event_id"], []).append(
            {
                "scenario": anno["scenario"],
                "anomaly_type": anno["anomaly_type"],
                "observed": bool(anno["observed"]),
                "reason": anno["reason"],
                "run_id": anno["run_id"],
            }
        )
    return annotations


def _selection(conn, dataset: str, raw: RawFilter) -> tuple[EventSelection, object]:
    try:
        dataset_row = require_dataset(conn, dataset)
    except KeyError:
        raise HTTPException(404, f"未知数据集 {dataset}")
    try:
        selection = filters.build_selection(raw.to_context(dataset))
    except FilterError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc
    return selection, dataset_row


@router.get("")
def list_events(
    dataset: str,
    raw: RawFilter = Depends(filters.filter_params),
    has_deliberation: bool | None = Query(
        None, description="true 只返回含内部审议的事件（MC1 双声道用）"
    ),
    limit: int = Query(100, ge=1, le=500),
    cursor: str | None = Query(None, description="上一页返回的 next_cursor"),
    direction: str = Query("desc", pattern="^(asc|desc)$"),
):
    with get_conn() as conn:
        selection, dataset_row = _selection(conn, dataset, raw)
        if has_deliberation is not None:
            selection = selection.extend(
                "e.has_deliberation = :f_delib",
                {"f_delib": 1 if has_deliberation else 0},
                salt="has_deliberation",
            )

        try:
            matched = filters.count_events(conn, selection)
            rows, next_cursor = filters.page_events(conn, selection, limit, cursor, direction)
        except FilterError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

        annotations = load_annotations(conn, dataset, [r["event_id"] for r in rows])

        items = [summarize(row, dataset, annotations.get(row["event_id"], [])) for row in rows]

    return {
        "meta": filters.build_meta(
            selection,
            scope="filtered",
            data_version=dataset_row["data_version"],
            matched_events=matched,
            next_cursor=next_cursor,
        ),
        "dataset_id": dataset,
        "timezone_status": dataset_row["timezone_status"],
        "items": items,
        "next_cursor": next_cursor,
    }


@router.get("/{event_id}")
def event_detail(event_id: str, dataset: str):
    with get_conn() as conn:
        try:
            dataset_row = require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        row = conn.execute(
            "SELECT * FROM events WHERE dataset_id=? AND event_id=?", (dataset, event_id)
        ).fetchone()
        if row is None:
            # 允许用源记录 ID 反查：MC1 的 responding_to 与官方记录 ID 都是这个口径
            row = conn.execute(
                "SELECT * FROM events WHERE dataset_id=? AND source_record_id=? LIMIT 1",
                (dataset, event_id),
            ).fetchone()
        if row is None:
            raise HTTPException(404, f"未知事件 {event_id}")

        event_id = row["event_id"]

        raw = conn.execute(
            "SELECT raw_json FROM event_raw WHERE dataset_id=? AND event_id=?", (dataset, event_id)
        ).fetchone()
        raw_obj = json.loads(raw["raw_json"]) if raw and raw["raw_json"] else None

        participants = [
            {
                "entity_id": p["entity_id"],
                "role": p["role"],
                "derivation": p["derivation"],
                "label": p["label"],
                "entity_type": p["entity_type"],
            }
            for p in conn.execute(
                "SELECT p.entity_id, p.role, p.derivation, en.label, en.entity_type FROM participants p "
                "LEFT JOIN entities en ON en.dataset_id=p.dataset_id AND en.entity_id=p.entity_id "
                "WHERE p.dataset_id=? AND p.event_id=? ORDER BY p.role",
                (dataset, event_id),
            )
        ]

        relations = [
            {
                "src_id": r["src_id"],
                "dst_id": r["dst_id"],
                "relation": r["relation"],
                "derivation": r["derivation"],
                "target_kind": r["target_kind"],
                "direction": "out" if r["src_id"] == row["actor_id"] else "in",
            }
            for r in conn.execute(
                "SELECT * FROM relations WHERE dataset_id=? AND event_id=?",
                (dataset, event_id),
            )
        ]

        annotations = load_annotations(conn, dataset, [event_id]).get(event_id, [])

    # MC1 双声道：外发文本来自 details.content，内部审议来自 raw.internal_state
    deliberation = None
    if isinstance(raw_obj, dict):
        state = raw_obj.get("internal_state")
        if isinstance(state, dict):
            parsed = {k: v.strip() for k, v in state.items() if isinstance(v, str) and v.strip()}
            deliberation = parsed or None
    details_obj = json.loads(row["details_json"]) if row["details_json"] else None
    outgoing_text = details_obj.get("content") if isinstance(details_obj, dict) else None

    return {
        "meta": {
            "contract_version": filters.CONTRACT_VERSION,
            "dataset_id": dataset,
            "data_version": dataset_row["data_version"],
            "scope": "single",
        },
        "dataset_id": dataset,
        "event_id": row["event_id"],
        "source_record_id": row["source_record_id"],
        "source_missing_id": bool(row["source_missing_id"]),
        "timestamp": row["timestamp_normalized"],
        "timestamp_raw": row["timestamp_raw"],
        "time_us": row["time_sort_us"],
        "timezone_status": row["timezone_status"],
        "event_type": row["event_type"],
        "category": event_types.category_of(dataset, row["event_type"]),
        "actor_id": row["actor_id"],
        "actor_rule": row["actor_rule"],
        "task_id": row["task_id"],
        "run_id": row["run_id"],
        "document_id": row["document_id"],
        "target_id": row["target_id"],
        "version": row["version"],
        "channel_id": row["channel_id"],
        "parent_event_id": row["parent_event_id"],
        "details": details_obj,
        "has_deliberation": bool(row["has_deliberation"]),
        # 双声道：左声道是外发文本，右声道是模型生成的内部审议
        "outgoing_text": outgoing_text if isinstance(outgoing_text, str) else None,
        "deliberation": deliberation,
        "deliberation_source": "raw.internal_state" if deliberation else None,
        "source_file": row["source_file"],
        "source_ordinal": row["source_ordinal"],
        "source_json_pointer": row["source_json_pointer"],
        "raw": raw_obj,
        "participants": participants,
        "relations": relations,
        "annotations": annotations,
    }
