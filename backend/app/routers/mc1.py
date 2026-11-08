"""MC1 决策与先兆接口（S4）。

- GET /api/events/{id}/context：单条消息的显式父引用、回复（valid/future）、同 actor/同频道邻接与环境上下文。
- GET /api/mc1/activity：7 个 agent × 天/小时/轮次矩阵，公开/内部渠道分开计数。
- GET /api/mc1/context：决策泳道（环境/约束/消息/发布 + 人工标记）与先兆候选。
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import mc1_context
from ..query import filters
from ..query.filters import FilterError, RawFilter
from .events import load_annotations, summarize

router = APIRouter(prefix="/api", tags=["mc1"])

# 回复网络是唯一需要 event 级 reply_to 边上卷到 agent 的视图；/api/graph 只聚合
# target_kind='entity' 的边，不能拿它冒充回复网络。口径见 NOTES。
REPLY_NETWORK_NOTES = [
    "reply_to 边按“源消息 actor → 目标消息 actor”上卷，同一对 agent 按 reply_class 分开计数。",
    "reply_class=reply_future_reference 表示正文引用了晚于本身的记录：保留原始关系，默认不进入历史传播主链。",
    "mention 只统计文本点名落到 agent 实体的边，与 reply_to 不合并；两者语义不同。",
    "计数均为当前筛选条件下 DISTINCT event_id，不是消息条数加总。",
]


def _prepare(conn, dataset: str, raw: RawFilter):
    try:
        dataset_row = require_dataset(conn, dataset)
    except KeyError:
        raise HTTPException(404, f"未知数据集 {dataset}") from None
    if dataset != "MC1":
        raise HTTPException(400, "unsupported_dataset: 决策与先兆当前仅 MC1 支持")
    try:
        selection = filters.build_selection(raw.to_context(dataset))
    except FilterError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc
    return dataset_row, selection


@router.get("/events/{event_id}/context")
def event_context(
    event_id: str,
    dataset: str = Query("MC1"),
    raw: RawFilter = Depends(filters.filter_params),
):
    with get_conn() as conn:
        dataset_row, selection = _prepare(conn, dataset, raw)
        views = mc1_context.views_for(conn)
        try:
            payload = mc1_context.event_context(conn, event_id, views)
        except KeyError:
            raise HTTPException(404, f"未知事件 {event_id}") from None
        matched = filters.count_events(conn, selection)
    return {
        "meta": filters.build_meta(
            selection,
            scope="mc1_event_context",
            data_version=dataset_row["data_version"],
            matched_events=matched,
        ),
        **payload,
        "views_available": views is not None,
    }


@router.get("/mc1/activity")
def activity(
    dataset: str = Query("MC1"),
    granularity: Literal["day", "hour", "round"] = Query("day"),
    raw: RawFilter = Depends(filters.filter_params),
):
    with get_conn() as conn:
        dataset_row, selection = _prepare(conn, dataset, raw)
        views = mc1_context.views_for(conn)
        payload = mc1_context.activity(conn, selection, granularity, views)
        matched = filters.count_events(conn, selection)
    return {
        "meta": filters.build_meta(
            selection,
            scope="mc1_activity",
            data_version=dataset_row["data_version"],
            matched_events=matched,
        ),
        "dataset_id": dataset,
        **payload,
        "views_available": views is not None,
    }


@router.get("/mc1/context")
def decision_context(
    dataset: str = Query("MC1"),
    raw: RawFilter = Depends(filters.filter_params),
):
    with get_conn() as conn:
        dataset_row, selection = _prepare(conn, dataset, raw)
        views = mc1_context.views_for(conn)
        payload = mc1_context.decision_context(conn, selection, views)
        matched = filters.count_events(conn, selection)
    return {
        "meta": filters.build_meta(
            selection,
            scope="mc1_decision_context",
            data_version=dataset_row["data_version"],
            matched_events=matched,
            truncated=bool(payload.get("truncated")),
        ),
        **payload,
        "views_available": views is not None,
    }


PUBLIC_CHANNEL_SUFFIXES = ("personal_post", "official_post", "anonymous_post")

REPLY_EDGE_SQL = """
SELECT r.src_id AS source_agent,
       te.actor_id AS target_agent,
       COALESCE(e.reply_class, '') AS reply_class,
       COUNT(DISTINCT e.event_id) AS evidence_count,
       MIN(e.time_sort_us) AS first_us,
       MAX(e.time_sort_us) AS last_us
FROM relations r
JOIN events e ON e.dataset_id = r.dataset_id AND e.event_id = r.event_id
JOIN events te ON te.dataset_id = r.dataset_id AND te.event_id = r.dst_id
WHERE ({where}) AND r.dataset_id = :f_dataset
  AND r.relation = 'reply_to' AND r.target_kind = 'event'
GROUP BY r.src_id, te.actor_id, COALESCE(e.reply_class, '')
ORDER BY evidence_count DESC
"""

MENTION_EDGE_SQL = """
SELECT r.src_id AS source_agent,
       r.dst_id AS target_agent,
       COUNT(DISTINCT r.event_id) AS evidence_count,
       MIN(e.time_sort_us) AS first_us,
       MAX(e.time_sort_us) AS last_us
FROM relations r
JOIN events e ON e.dataset_id = r.dataset_id AND e.event_id = r.event_id
WHERE ({where}) AND r.dataset_id = :f_dataset
  AND r.relation = 'mention' AND r.target_kind = 'entity'
GROUP BY r.src_id, r.dst_id
ORDER BY evidence_count DESC
"""

AGENT_TOTAL_SQL = """
SELECT e.actor_id AS agent_id,
       COUNT(*) AS messages,
       COALESCE(SUM(e.has_deliberation), 0) AS with_deliberation,
       COALESCE(SUM(CASE WHEN e.channel_id LIKE '%:personal_post'
                           OR e.channel_id LIKE '%:official_post'
                           OR e.channel_id LIKE '%:anonymous_post' THEN 1 ELSE 0 END), 0) AS public_messages
FROM events e
WHERE {where}
GROUP BY e.actor_id
"""


@router.get("/mc1/reply-network")
def reply_network(
    dataset: str = Query("MC1"),
    raw: RawFilter = Depends(filters.filter_params),
):
    """MC1 agent 级回复/点名称网络：reply_to 边上卷 + mention 边，按筛选条件计数。"""
    with get_conn() as conn:
        dataset_row, selection = _prepare(conn, dataset, raw)
        params = dict(selection.params)
        reply_rows = conn.execute(REPLY_EDGE_SQL.format(where=selection.where_sql), params).fetchall()
        mention_rows = conn.execute(
            MENTION_EDGE_SQL.format(where=selection.where_sql), params
        ).fetchall()
        total_rows = conn.execute(AGENT_TOTAL_SQL.format(where=selection.where_sql), params).fetchall()
        agent_rows = conn.execute(
            "SELECT entity_id, label FROM entities WHERE dataset_id=? AND entity_type='agent' "
            "ORDER BY entity_id",
            (dataset,),
        ).fetchall()
        matched = filters.count_events(conn, selection)

    nodes = {
        row["entity_id"]: {
            "id": row["entity_id"],
            "label": row["label"] or row["entity_id"].split(":")[-1],
            "messages": 0,
            "with_deliberation": 0,
            "public_messages": 0,
            "reply_out": 0,
            "reply_in": 0,
            "mention_out": 0,
            "mention_in": 0,
        }
        for row in agent_rows
    }
    totals = {row["agent_id"]: row for row in total_rows}
    for agent_id, node in nodes.items():
        row = totals.get(agent_id)
        if row is None:
            continue
        node["messages"] = int(row["messages"])
        node["with_deliberation"] = int(row["with_deliberation"])
        node["public_messages"] = int(row["public_messages"])

    edges: list[dict] = []
    by_class: dict[str, int] = {}
    for row in reply_rows:
        if not row["source_agent"] or not row["target_agent"]:
            continue
        edge = {
            "source": row["source_agent"],
            "target": row["target_agent"],
            "kind": "reply",
            "reply_class": row["reply_class"] or "unknown",
            "evidence_count": int(row["evidence_count"]),
            "first_us": row["first_us"],
            "last_us": row["last_us"],
        }
        edges.append(edge)
        by_class[edge["reply_class"]] = by_class.get(edge["reply_class"], 0) + edge["evidence_count"]
        if edge["source"] in nodes:
            nodes[edge["source"]]["reply_out"] += edge["evidence_count"]
        if edge["target"] in nodes:
            nodes[edge["target"]]["reply_in"] += edge["evidence_count"]

    for row in mention_rows:
        if row["source_agent"] not in nodes or row["target_agent"] not in nodes:
            continue
        edge = {
            "source": row["source_agent"],
            "target": row["target_agent"],
            "kind": "mention",
            "reply_class": "mention",
            "evidence_count": int(row["evidence_count"]),
            "first_us": row["first_us"],
            "last_us": row["last_us"],
        }
        edges.append(edge)
        nodes[edge["source"]]["mention_out"] += edge["evidence_count"]
        nodes[edge["target"]]["mention_in"] += edge["evidence_count"]

    return {
        "meta": filters.build_meta(
            selection,
            scope="mc1_reply_network",
            data_version=dataset_row["data_version"],
            matched_events=matched,
        ),
        "dataset_id": dataset,
        "nodes": sorted(nodes.values(), key=lambda item: item["id"]),
        "edges": edges,
        "counts": {
            "reply_edges": sum(1 for edge in edges if edge["kind"] == "reply"),
            "mention_edges": sum(1 for edge in edges if edge["kind"] == "mention"),
            "by_reply_class": by_class,
        },
        "notes": REPLY_NETWORK_NOTES,
    }


REPLY_EVIDENCE_SQL = """
SELECT {columns}
FROM relations r
JOIN events e ON e.dataset_id = r.dataset_id AND e.event_id = r.event_id
JOIN events te ON te.dataset_id = r.dataset_id AND te.event_id = r.dst_id
LEFT JOIN entities en ON en.dataset_id = e.dataset_id AND en.entity_id = e.actor_id
WHERE ({where}) AND r.dataset_id = :f_dataset
  AND r.relation = 'reply_to' AND r.target_kind = 'event'
  AND r.src_id = :e_src AND te.actor_id = :e_dst
"""

MENTION_EVIDENCE_SQL = """
SELECT {columns}
FROM relations r
JOIN events e ON e.dataset_id = r.dataset_id AND e.event_id = r.event_id
LEFT JOIN entities en ON en.dataset_id = e.dataset_id AND en.entity_id = e.actor_id
WHERE ({where}) AND r.dataset_id = :f_dataset
  AND r.relation = 'mention' AND r.target_kind = 'entity'
  AND r.src_id = :e_src AND r.dst_id = :e_dst
"""


@router.get("/mc1/reply-network/evidence")
def reply_network_evidence(
    source_agent: str,
    target_agent: str,
    dataset: str = Query("MC1"),
    kind: str = Query("reply", pattern="^(reply|mention)$"),
    reply_class: str | None = Query(None, description="reply 边按 reply_class 细分，如 reply_valid"),
    limit: int = Query(50, ge=1, le=200),
    raw: RawFilter = Depends(filters.filter_params),
):
    """单条聚合边的真实消息；端点与筛选条件和网络聚合一致。"""
    with get_conn() as conn:
        dataset_row, selection = _prepare(conn, dataset, raw)
        params = dict(selection.params)
        params["e_src"] = source_agent
        params["e_dst"] = target_agent
        if kind == "reply":
            sql = REPLY_EVIDENCE_SQL.format(
                columns=filters.SUMMARY_COLUMNS, where=selection.where_sql
            )
            if reply_class:
                sql += " AND COALESCE(e.reply_class, '') = :e_class"
                params["e_class"] = reply_class
        else:
            sql = MENTION_EVIDENCE_SQL.format(
                columns=filters.SUMMARY_COLUMNS, where=selection.where_sql
            )
        matched_row = conn.execute(
            "SELECT COUNT(DISTINCT event_id) AS c, MIN(time_sort_us) AS first_us, "
            "MAX(time_sort_us) AS last_us FROM (" + sql + ") AS edge_events",
            params,
        ).fetchone()
        rows = conn.execute(
            "SELECT * FROM (" + sql + ") AS edge_events "
            "ORDER BY time_sort_us DESC, event_id DESC LIMIT :e_limit",
            {**params, "e_limit": limit},
        ).fetchall()
        annotations = {}
        if kind == "mention":
            annotations = load_annotations(conn, dataset, [row["event_id"] for row in rows])
        matched = int(matched_row["c"] or 0)

    items = [
        summarize(row, dataset, annotations.get(row["event_id"], []) if annotations else [])
        for row in rows
    ]
    return {
        "meta": filters.build_meta(
            selection,
            scope="mc1_reply_network_evidence",
            data_version=dataset_row["data_version"],
            matched_events=matched,
            truncated=matched > len(items),
        ),
        "dataset_id": dataset,
        "edge": {
            "source": source_agent,
            "target": target_agent,
            "kind": kind,
            "reply_class": reply_class,
        },
        "first_us": matched_row["first_us"],
        "last_us": matched_row["last_us"],
        "items": items,
    }
