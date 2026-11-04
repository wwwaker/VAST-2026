"""事件列表与事件详情。列表走时间+ID 稳定游标分页，详情才读取 raw。"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query

from ..db import get_conn, require_dataset

router = APIRouter(prefix="/api/events", tags=["events"])

PREVIEW_KEYS = ("content", "subject", "title", "reason", "feedback", "purpose")


def _preview(details_json: str | None, limit: int = 180) -> str:
    """事件流摘要。先按已知语义取值，取不到再用键值对回落，避免整列都是"无摘要"。"""
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


@router.get("")
def list_events(
    dataset: str,
    start: int | None = None,
    end: int | None = None,
    types: str | None = Query(None, description="逗号分隔的事件类型"),
    actor: str | None = None,
    q: str | None = Query(None, description="关键词，走 FTS5"),
    has_deliberation: bool | None = Query(
        None, description="true 只返回含内部审议的事件（MC1 双声道用）"
    ),
    limit: int = Query(100, ge=1, le=500),
    cursor: str | None = Query(None, description="上一页返回的 next_cursor"),
    direction: str = Query("desc", pattern="^(asc|desc)$"),
):
    where = ["e.dataset_id=?"]
    params: list = [dataset]

    if start is not None:
        where.append("e.time_sort_key>=?")
        params.append(start)
    if end is not None:
        where.append("e.time_sort_key<=?")
        params.append(end)
    if types:
        names = [t for t in types.split(",") if t]
        if names:
            where.append("e.event_type IN (" + ",".join("?" * len(names)) + ")")
            params.extend(names)
    if actor:
        where.append("e.actor_id=?")
        params.append(actor)
    if q:
        where.append(
            "e.event_id IN (SELECT f.event_id FROM event_fts f WHERE f.rowid IN "
            "(SELECT rowid FROM event_fts_idx WHERE event_fts_idx MATCH ?))"
        )
        params.append(q)
    if has_deliberation is not None:
        where.append("e.has_deliberation=?")
        params.append(1 if has_deliberation else 0)

    if cursor:
        try:
            cts, cid = cursor.rsplit("|", 1)
            cmp_ts, cmp_id = int(cts), cid
        except (ValueError, AttributeError):
            raise HTTPException(400, "cursor 格式无效")
        op = "<" if direction == "desc" else ">"
        where.append(f"(e.time_sort_key, e.event_id) {op} (?, ?)")
        params.extend([cmp_ts, cmp_id])

    order = "DESC" if direction == "desc" else "ASC"
    sql = (
        "SELECT e.event_id, e.timestamp_raw, e.timestamp_normalized, e.time_sort_key, e.timezone_status, "
        "e.event_type, e.actor_id, e.actor_rule, e.details_json, e.has_deliberation, e.source_missing_id, "
        "en.label AS actor_label "
        "FROM events e LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
        "WHERE " + " AND ".join(where) + f" ORDER BY e.time_sort_key {order}, e.event_id {order} LIMIT ?"
    )
    params.append(limit + 1)

    with get_conn() as conn:
        try:
            dataset_row = require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        rows = conn.execute(sql, params).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]

        ids = [r["event_id"] for r in rows]
        annotations: dict[str, list[dict]] = {}
        if ids:
            for anno in conn.execute(
                "SELECT ae.event_id, a.scenario, a.anomaly_type, a.observed, a.reason "
                "FROM annotation_events ae JOIN annotations a ON a.annotation_id=ae.annotation_id "
                "WHERE ae.dataset_id=? AND ae.event_id IN (" + ",".join("?" * len(ids)) + ")",
                [dataset, *ids],
            ):
                annotations.setdefault(anno["event_id"], []).append(
                    {
                        "scenario": anno["scenario"],
                        "anomaly_type": anno["anomaly_type"],
                        "observed": bool(anno["observed"]),
                        "reason": anno["reason"],
                    }
                )

    items = [
        {
            "event_id": r["event_id"],
            "timestamp": r["timestamp_normalized"],
            "timestamp_raw": r["timestamp_raw"],
            "time_sort_key": r["time_sort_key"],
            "timezone_status": r["timezone_status"],
            "event_type": r["event_type"],
            "actor_id": r["actor_id"],
            "actor_label": r["actor_label"],
            "actor_rule": r["actor_rule"],
            "preview": _preview(r["details_json"]),
            "has_deliberation": bool(r["has_deliberation"]),
            "source_missing_id": bool(r["source_missing_id"]),
            "annotations": annotations.get(r["event_id"], []),
        }
        for r in rows
    ]

    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        next_cursor = f"{last['time_sort_key']}|{last['event_id']}"

    return {
        "dataset_id": dataset,
        "timezone_status": dataset_row["timezone_status"],
        "items": items,
        "next_cursor": next_cursor,
    }


@router.get("/{event_id}")
def event_detail(event_id: str, dataset: str):
    with get_conn() as conn:
        try:
            require_dataset(conn, dataset)
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

        annotations = [
            {
                "scenario": a["scenario"],
                "anomaly_type": a["anomaly_type"],
                "observed": bool(a["observed"]),
                "reason": a["reason"],
                "run_id": a["run_id"],
            }
            for a in conn.execute(
                "SELECT a.* FROM annotation_events ae JOIN annotations a ON a.annotation_id=ae.annotation_id "
                "WHERE ae.dataset_id=? AND ae.event_id=?",
                (dataset, event_id),
            )
        ]

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
        "dataset_id": dataset,
        "event_id": row["event_id"],
        "source_record_id": row["source_record_id"],
        "source_missing_id": bool(row["source_missing_id"]),
        "timestamp": row["timestamp_normalized"],
        "timestamp_raw": row["timestamp_raw"],
        "timezone_status": row["timezone_status"],
        "event_type": row["event_type"],
        "actor_id": row["actor_id"],
        "actor_rule": row["actor_rule"],
        "task_id": row["task_id"],
        "document_id": row["document_id"],
        "parent_event_id": row["parent_event_id"],
        "details": details_obj,
        "has_deliberation": bool(row["has_deliberation"]),
        # 双声道：左声道是外发文本，右声道是模型生成的内部审议
        "outgoing_text": outgoing_text if isinstance(outgoing_text, str) else None,
        "deliberation": deliberation,
        "deliberation_source": "raw.internal_state" if deliberation else None,
        "source_json_pointer": row["source_json_pointer"],
        "raw": raw_obj,
        "participants": participants,
        "relations": relations,
        "annotations": annotations,
    }
