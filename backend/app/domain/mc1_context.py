"""MC1 消息上下文、回复分类、角色活动矩阵与决策泳道（S4 / M1-01、M1-02）。

数据边界：
- 事件事实来自主库 events / relations；事件时间一律整数微秒。
- 环境叙事、人工 event_markers、reply_threads 来自经 manifest 哈希核验的 views.json，
  在响应中保留 context_id、source_pointer 与 provenanceKind，不制造 event_id。
- reply_class 在导入时回填：future reference 保留原始关系，但默认不进入历史传播主链。
"""

from __future__ import annotations

import re

from ..ingest import artifacts
from ..ingest.loader import parse_epoch_us
from ..query.filters import EventSelection
from ..routers.events import _preview

DATASET = "MC1"
DEFAULT_AGENT_ORDER = [
    "legal_agent",
    "social_media_agent",
    "quality_agent",
    "pr_agent",
    "pr_intern_agent",
    "intern_agent",
    "judge_agent",
]

INTERNAL_CHANNELS = {"comms_huddle", "side_huddle", "one_on_one_chat"}
PUBLIC_CHANNELS = {"personal_post", "official_post", "anonymous_post"}

DEFAULT_WINDOW_HALF_US = 2 * 60 * 60 * 1_000_000
DEFAULT_RADIUS_US = 30 * 60 * 1_000_000
MAX_LIST = 40
# 事件轨单窗口记录上限；超出时返回 messages_total / truncated，并补入关键事件
LANE_LIMIT = 800

_ROUND_RE = re.compile(r"_(\d{2})_\d{3}$")
_VIEWS_CACHE: dict[tuple, dict] = {}


# ------------------------------------------------------------------ 基础工具


def channel_name(channel_id: str | None) -> str:
    if not channel_id:
        return "unknown"
    return channel_id.split(":")[-1]


def channel_scope(channel_id: str | None) -> str:
    name = channel_name(channel_id)
    if name in PUBLIC_CHANNELS:
        return "public"
    if name in INTERNAL_CHANNELS:
        return "internal"
    return "other"


def round_index(event_id: str, source_record_id: str | None = None) -> int | None:
    token = source_record_id or (event_id.split(":")[-1] if event_id else None)
    if not token:
        return None
    match = _ROUND_RE.search(str(token))
    return int(match.group(1)) if match else None


def views_for(conn, dataset: str = DATASET) -> dict | None:
    """读取并缓存 MC1 派生视图；哈希不符时返回 None，调用方必须显式降级。"""
    row = conn.execute(
        "SELECT data_version FROM datasets WHERE dataset_id=?", (dataset,)
    ).fetchone()
    version = row["data_version"] if row else ""
    bundle = artifacts.load_bundle(dataset, version)
    if bundle.status != "ok" or not bundle.views:
        return None
    key = (version, bundle.sha256)
    if key not in _VIEWS_CACHE:
        _VIEWS_CACHE.clear()
        _VIEWS_CACHE[key] = bundle.views
    return _VIEWS_CACHE[key]


def clear_cache() -> None:
    _VIEWS_CACHE.clear()


def _round_bounds(views: dict | None) -> list[dict]:
    if not views:
        return []
    timeline = sorted(views.get("timeline") or [], key=lambda item: item.get("round_index", 0))
    bounds = []
    for index, item in enumerate(timeline):
        start = parse_epoch_us(item["timestamp"])
        if index + 1 < len(timeline):
            end = parse_epoch_us(timeline[index + 1]["timestamp"])
        else:
            end = start + 60 * 60 * 1_000_000
        bounds.append(
            {
                "round_index": item.get("round_index"),
                "start_us": start,
                "end_us": end,
                "label": item.get("headline") or item.get("timestamp"),
                "timestamp_raw": item.get("timestamp"),
            }
        )
    return bounds


def round_window(views: dict | None, index: int | None) -> dict | None:
    if index is None:
        return None
    for item in _round_bounds(views):
        if item["round_index"] == index:
            return item
    return None


def _event_summary(conn, event_id: str) -> dict | None:
    row = conn.execute(
        "SELECT e.event_id, e.source_record_id, e.time_sort_us, e.timestamp_raw, e.event_type, "
        "       e.actor_id, e.channel_id, e.details_json, e.reply_class, e.reply_target_event_id, "
        "       en.label AS actor_label "
        "FROM events e LEFT JOIN entities en "
        "  ON en.dataset_id = e.dataset_id AND en.entity_id = e.actor_id "
        "WHERE e.dataset_id=? AND e.event_id=?",
        (DATASET, event_id),
    ).fetchone()
    if row is None:
        return None
    return {
        "event_id": row["event_id"],
        "source_record_id": row["source_record_id"],
        "time_us": int(row["time_sort_us"]),
        "timestamp_raw": row["timestamp_raw"],
        "event_type": row["event_type"],
        "actor_id": row["actor_id"],
        "actor_label": row["actor_label"],
        "channel_id": row["channel_id"],
        "channel": channel_name(row["channel_id"]),
        "channel_scope": channel_scope(row["channel_id"]),
        "reply_class": row["reply_class"],
        "reply_target_event_id": row["reply_target_event_id"],
        "preview": _preview(row["details_json"]),
    }


def _neighbors(conn, column: str, value: str, center_us: int, exclude_id: str, limit: int) -> list[dict]:
    rows = conn.execute(
        "SELECT event_id FROM events WHERE dataset_id=? AND " + column + "=? "
        "AND event_id<>? AND time_sort_us BETWEEN ? AND ? "
        "ORDER BY ABS(time_sort_us - ?), time_sort_us LIMIT ?",
        (
            DATASET,
            value,
            exclude_id,
            center_us - DEFAULT_RADIUS_US,
            center_us + DEFAULT_RADIUS_US,
            center_us,
            limit,
        ),
    ).fetchall()
    items = []
    for row in rows:
        summary = _event_summary(conn, row["event_id"])
        if summary:
            summary["delta_us"] = summary["time_us"] - center_us
            items.append(summary)
    return items


# ------------------------------------------------------------------ 回复分类


def reply_audit(conn, views: dict | None = None) -> dict:
    counts = {
        row["reply_class"] or "unknown": int(row["cnt"])
        for row in conn.execute(
            "SELECT reply_class, COUNT(*) AS cnt FROM events WHERE dataset_id=? GROUP BY reply_class",
            (DATASET,),
        )
    }
    mention_edges = int(
        conn.execute(
            "SELECT COUNT(*) FROM relations WHERE dataset_id=? AND relation='mention'",
            (DATASET,),
        ).fetchone()[0]
    )
    reply_edges = int(
        conn.execute(
            "SELECT COUNT(*) FROM relations WHERE dataset_id=? AND relation='reply_to'",
            (DATASET,),
        ).fetchone()[0]
    )
    baseline = None
    if views:
        baseline = (views.get("additional_stats") or {}).get("reply_reference_status")
    text_total = counts.get("mention", 0) + counts.get("unresolved_reference", 0)
    compatible = None
    if baseline:
        compatible = (
            counts.get("reply_valid", 0) == baseline.get("valid_reply")
            and counts.get("reply_future_reference", 0) == baseline.get("future_reference")
            and counts.get("empty_reference", 0) == baseline.get("empty_reference")
            and text_total == baseline.get("unresolved_text")
        )
    return {
        "counts": counts,
        "reply_edges": reply_edges,
        "mention_edges": mention_edges,
        "text_reference_total": text_total,
        "derived_baseline": baseline,
        "baseline_compatible": compatible,
        "mapping_note": (
            "派生视图把全部文本式引用记作 unresolved_text；本接口进一步区分为可命名映射的 "
            "mention 与无法解析的 unresolved_reference，两者之和与派生总数一致。"
        ),
    }


# ------------------------------------------------------------------ 单事件上下文


def event_context(conn, event_id: str, views: dict | None = None) -> dict:
    event = _event_summary(conn, event_id)
    if event is None:
        raise KeyError(event_id)
    views = views if views is not None else views_for(conn)

    explicit_parent = None
    parent_row = conn.execute(
        "SELECT parent_event_id FROM events WHERE dataset_id=? AND event_id=?",
        (DATASET, event_id),
    ).fetchone()
    parent_id = parent_row["parent_event_id"] if parent_row else None
    if parent_id:
        explicit_parent = _event_summary(conn, parent_id)
        if explicit_parent:
            usable = explicit_parent["time_us"] <= event["time_us"]
            explicit_parent["relation_reason"] = (
                "source:parent_event_id（记录中的父事件）"
                if usable
                else "source:parent_event_id；父事件时间晚于本消息，默认不进入历史传播主链"
            )
            explicit_parent["usable_as_history"] = usable
    if explicit_parent is None:
        parent_link = conn.execute(
            "SELECT dst_id FROM relations WHERE dataset_id=? AND event_id=? AND relation='reply_to'",
            (DATASET, event_id),
        ).fetchone()
        if parent_link:
            explicit_parent = _event_summary(conn, parent_link["dst_id"])
            if explicit_parent:
                is_future = event["reply_class"] == "reply_future_reference"
                explicit_parent["relation_reason"] = (
                    "记录中的回应指向；目标时间晚于本消息，默认不进入历史传播主链"
                    if is_future
                    else "记录中的回应指向（目标时间不晚于本消息）"
                )
                explicit_parent["usable_as_history"] = not is_future

    replies_rows = conn.execute(
        "SELECT r.event_id FROM relations r JOIN events e "
        "  ON e.dataset_id = r.dataset_id AND e.event_id = r.event_id "
        "WHERE r.dataset_id=? AND r.relation='reply_to' AND r.dst_id=? "
        "ORDER BY e.time_sort_us LIMIT ?",
        (DATASET, event_id, MAX_LIST * 2),
    ).fetchall()
    valid, future = [], []
    for row in replies_rows:
        summary = _event_summary(conn, row["event_id"])
        if not summary:
            continue
        is_valid = summary["time_us"] >= event["time_us"] and summary["reply_class"] == "reply_valid"
        summary["relation_reason"] = (
            "本消息之后的合法回复" if is_valid else "指向未来的引用，不作为历史回复"
        )
        (valid if is_valid else future).append(summary)

    mentions = [
        {"entity_id": row["dst_id"], "label": row["label"], "relation_reason": "文本 @ 称呼映射到实体"}
        for row in conn.execute(
            "SELECT r.dst_id, en.label FROM relations r LEFT JOIN entities en "
            "  ON en.dataset_id = r.dataset_id AND en.entity_id = r.dst_id "
            "WHERE r.dataset_id=? AND r.event_id=? AND r.relation='mention'",
            (DATASET, event_id),
        )
    ]

    same_actor = _neighbors(conn, "actor_id", event["actor_id"], event["time_us"], event_id, 8) if event["actor_id"] else []
    same_channel = _neighbors(conn, "channel_id", event["channel_id"], event["time_us"], event_id, 8) if event["channel_id"] else []

    env_items = []
    index = round_index(event_id, event["source_record_id"])
    if views and index is not None:
        for item in views.get("environment_events") or []:
            if item.get("round_index") == index:
                env_items.append(
                    {
                        "context_id": item.get("event_id"),
                        "round_index": index,
                        "kind": item.get("kind"),
                        "time_us": parse_epoch_us(item["timestamp"]),
                        "time_precision": item.get("time_precision"),
                        "value": item.get("value"),
                        "source_pointer": item.get("source_pointer"),
                        "provenanceKind": "recorded",
                        "relation_reason": "同轮环境叙事；轮次精度，不表示精确发生时刻",
                    }
                )

    derived_neighbors = None
    if views:
        context = (views.get("message_context_by_id") or {}).get(event["source_record_id"] or "")
        if context:
            record_to_event = {
                row["source_record_id"]: row["event_id"]
                for row in conn.execute(
                    "SELECT event_id, source_record_id FROM events WHERE dataset_id=? "
                    "AND source_record_id IS NOT NULL",
                    (DATASET,),
                )
            }

            def map_ids(ids):
                return [
                    {"event_id": record_to_event.get(str(item)), "source_record_id": str(item)}
                    for item in (ids or [])
                    if record_to_event.get(str(item))
                ]

            derived_neighbors = {
                "parent_message_id": context.get("parent_message_id"),
                "reply_message_ids": map_ids(context.get("reply_message_ids")),
                "same_round_neighbor_ids": map_ids(context.get("same_round_neighbor_ids")),
                "same_agent_neighbor_ids": map_ids(context.get("same_agent_neighbor_ids")),
                "same_channel_neighbor_ids": map_ids(context.get("same_channel_neighbor_ids")),
                "thread_id": context.get("thread_id"),
                "provenanceKind": "derived",
                "relation_reason": "派生分析的同轮/同 agent/同频道邻接；不是已证实因果",
            }

    return {
        "dataset_id": DATASET,
        "event": event,
        "round": round_window(views, index),
        "explicit_parent": explicit_parent,
        "replies": {
            "valid": valid[:MAX_LIST],
            "future_reference": future[:MAX_LIST],
            "counts": {"valid": len(valid), "future_reference": len(future)},
            "note": "future_reference 指向本消息之后的记录，默认不进入历史传播主链。",
        },
        "mentions": mentions,
        "same_actor": same_actor,
        "same_channel": same_channel,
        "environment_context": env_items[:MAX_LIST],
        "derived_neighbors": derived_neighbors,
        "notes": [
            "explicit_parent 只表示记录中的指向，不等于“上游原因”。",
            "same_actor / same_channel 是按 ±30 分钟窗口计算的时间邻接。",
            "环境叙事为轮次精度，不能当作精确时刻。",
        ],
    }


# ------------------------------------------------------------------ 活动矩阵


def _bucket_key(time_us: int, granularity: str, event_id: str, source_record: str | None) -> int:
    if granularity == "day":
        return time_us // 86_400_000_000
    if granularity == "hour":
        return time_us // 3_600_000_000
    index = round_index(event_id, source_record)
    return index if index is not None else -1


def activity(conn, selection: EventSelection, granularity: str, views: dict | None = None) -> dict:
    views = views if views is not None else views_for(conn)
    rounds = _round_bounds(views)
    rows = conn.execute(
        "SELECT event_id, source_record_id, time_sort_us, actor_id, channel_id, event_type "
        "FROM events e WHERE " + selection.where_sql + " ORDER BY time_sort_us",
        selection.params,
    ).fetchall()

    agents = [
        row["entity_id"]
        for row in conn.execute(
            "SELECT entity_id FROM entities WHERE dataset_id=? AND entity_type='agent' "
            "ORDER BY entity_id",
            (DATASET,),
        )
    ]
    order = {name: index for index, name in enumerate(DEFAULT_AGENT_ORDER)}
    agents.sort(key=lambda item: (order.get(item.split(":")[-1], 99), item))
    labels = {
        row["entity_id"]: row["label"]
        for row in conn.execute(
            "SELECT entity_id, label FROM entities WHERE dataset_id=?", (DATASET,)
        )
    }

    buckets: dict[int, int] = {}
    for row in rows:
        key = _bucket_key(row["time_sort_us"], granularity, row["event_id"], row["source_record_id"])
        buckets[key] = buckets.get(key, 0) + 1

    columns = []
    for key in sorted(buckets):
        if granularity == "round":
            window = next((item for item in rounds if item["round_index"] == key), None)
            columns.append(
                {
                    "key": str(key),
                    "label": f"R{key}",
                    "start_us": window["start_us"] if window else None,
                    "end_us": window["end_us"] if window else None,
                    "matched_events": buckets[key],
                }
            )
        else:
            unit = 86_400_000_000 if granularity == "day" else 3_600_000_000
            start = key * unit
            columns.append(
                {
                    "key": str(key),
                    "label": str(key),
                    "start_us": start,
                    "end_us": start + unit,
                    "matched_events": buckets[key],
                }
            )
    keys = {column["key"] for column in columns}

    cells = {
        (agent, column["key"]): {"public": 0, "internal": 0, "other": 0, "channels": {}}
        for agent in agents
        for column in columns
    }
    for row in rows:
        column_key = str(
            _bucket_key(row["time_sort_us"], granularity, row["event_id"], row["source_record_id"])
        )
        agent = row["actor_id"]
        if agent not in agents or column_key not in keys:
            continue
        cell = cells[(agent, column_key)]
        scope = channel_scope(row["channel_id"])
        name = channel_name(row["channel_id"])
        cell[scope] += 1
        cell["channels"][name] = cell["channels"].get(name, 0) + 1

    flat = []
    for agent in agents:
        for column in columns:
            cell = cells[(agent, column["key"])]
            flat.append(
                {
                    "agent_id": agent,
                    "agent_label": labels.get(agent),
                    "bucket": column["key"],
                    "public": cell["public"],
                    "internal": cell["internal"],
                    "other": cell["other"],
                    "channels": cell["channels"],
                    "empty": cell["public"] + cell["internal"] + cell["other"] == 0,
                }
            )

    channel_totals: dict[str, int] = {}
    for row in rows:
        name = channel_name(row["channel_id"])
        channel_totals[name] = channel_totals.get(name, 0) + 1

    return {
        "granularity": granularity,
        "agents": [
            {"agent_id": agent, "label": labels.get(agent), "scope": "agent"} for agent in agents
        ],
        "columns": columns,
        "cells": flat,
        "channel_totals": channel_totals,
        "matched_messages": len(rows),
        "public_messages": sum(1 for row in rows if channel_scope(row["channel_id"]) == "public"),
        "internal_messages": sum(1 for row in rows if channel_scope(row["channel_id"]) == "internal"),
        "notes": [
            "计数是记录消息数，不是职责执行证明；空格表示该时段没有记录。",
            "公开渠道：personal_post / official_post / anonymous_post；内部渠道：comms_huddle / side_huddle / one_on_one_chat。",
        ],
    }


# ------------------------------------------------------------------ 决策泳道


def _default_window(conn) -> dict:
    row = conn.execute(
        "SELECT MIN(time_sort_us) AS lo, MAX(time_sort_us) AS hi FROM events WHERE dataset_id=?",
        (DATASET,),
    ).fetchone()
    anchor = conn.execute(
        "SELECT time_sort_us FROM events WHERE dataset_id=? AND event_id LIKE '%20460605_21_026'",
        (DATASET,),
    ).fetchone()
    if anchor is None:
        return {"start_us": int(row["lo"]), "end_us": int(row["hi"]) + 1, "source": "data_range"}
    center = int(anchor["time_sort_us"])
    return {
        "start_us": center - DEFAULT_WINDOW_HALF_US,
        "end_us": center + DEFAULT_WINDOW_HALF_US,
        "source": "anchor_20460605_21_026",
    }


def _env_item(item: dict, rounds: list[dict]) -> dict:
    index = item.get("round_index")
    window = next((entry for entry in rounds if entry["round_index"] == index), None)
    return {
        "context_id": item.get("event_id"),
        "kind": item.get("kind"),
        "round_index": index,
        "time_us": parse_epoch_us(item["timestamp"]),
        "round_start_us": window["start_us"] if window else None,
        "round_end_us": window["end_us"] if window else None,
        "time_precision": item.get("time_precision"),
        "value": item.get("value"),
        "source_pointer": item.get("source_pointer"),
        "provenanceKind": "recorded",
    }


CONSTRAINT_KEYWORDS = ("embargo", "hold the line", "禁发", "解禁", "6 pm", "6pm", "6:00")


def _is_constraint(item: dict) -> bool:
    if item.get("kind") == "critical_deadlines":
        return True
    value = str(item.get("value") or "").lower()
    return any(keyword in value for keyword in CONSTRAINT_KEYWORDS)


def decision_context(conn, selection: EventSelection, views: dict | None = None) -> dict:
    views = views if views is not None else views_for(conn)
    rounds = _round_bounds(views)
    start_us = selection.start_us
    end_us = selection.end_us
    window_source = "requested"
    if start_us is None or end_us is None:
        fallback = _default_window(conn)
        start_us = start_us if start_us is not None else fallback["start_us"]
        end_us = end_us if end_us is not None else fallback["end_us"]
        window_source = "default" if fallback["source"].startswith("anchor") else "data_range"
    start_us, end_us = int(start_us), int(end_us)

    environment = []
    constraints = []
    markers = []
    if views:
        for item in views.get("environment_events") or []:
            entry = _env_item(item, rounds)
            if entry["time_us"] < end_us and (entry["round_end_us"] or entry["time_us"]) > start_us:
                environment.append(entry)
                if _is_constraint(item):
                    constraints.append(
                        {**entry, "track": "constraint", "constraint_basis": "environment_narrative"}
                    )
        for item in views.get("event_markers") or []:
            entry = {
                "context_id": item.get("event_id"),
                "kind": item.get("kind"),
                "time_us": parse_epoch_us(item["timestamp"]),
                "time_precision": item.get("time_precision"),
                "label": item.get("label"),
                "message_ids": item.get("message_ids") or [],
                "evidence_agent_ids": item.get("evidence_agent_ids") or [],
                "source_pointers": item.get("source_pointers") or [],
                "provenanceKind": "analyst",
            }
            if start_us <= entry["time_us"] < end_us:
                markers.append(entry)
                label = str(item.get("label") or "").lower()
                if item.get("kind") == "result" and any(
                    token in label for token in ("解禁", "解除", "embargo", "lift")
                ):
                    constraints.append(
                        {**entry, "track": "constraint", "constraint_basis": "event_marker"}
                    )

    lane_params = {**selection.params, "lane_start": start_us, "lane_end": end_us}
    # 先数真实总量，再取前 LANE_LIMIT 条；截断必须显式返回，不能静默
    lane_total = int(
        conn.execute(
            "SELECT COUNT(*) AS n FROM events e WHERE "
            + selection.where_sql
            + " AND e.time_sort_us >= :lane_start AND e.time_sort_us < :lane_end",
            lane_params,
        ).fetchone()["n"]
    )
    message_rows = conn.execute(
        "SELECT event_id, source_record_id, time_sort_us, timestamp_raw, event_type, actor_id, "
        "       channel_id, details_json, reply_class, reply_target_event_id "
        "FROM events e WHERE " + selection.where_sql + " AND e.time_sort_us >= :lane_start "
        "AND e.time_sort_us < :lane_end ORDER BY e.time_sort_us LIMIT :lane_limit",
        {**lane_params, "lane_limit": LANE_LIMIT},
    ).fetchall()
    messages = []
    releases = []
    for row in message_rows:
        entry = {
            "event_id": row["event_id"],
            "time_us": int(row["time_sort_us"]),
            "timestamp_raw": row["timestamp_raw"],
            "event_type": row["event_type"],
            "actor_id": row["actor_id"],
            "channel": channel_name(row["channel_id"]),
            "channel_scope": channel_scope(row["channel_id"]),
            "reply_class": row["reply_class"],
            "reply_target_event_id": row["reply_target_event_id"],
            "preview": _preview(row["details_json"]),
            "provenanceKind": "recorded",
        }
        messages.append(entry)
        if entry["channel_scope"] == "public":
            releases.append(entry)

    target = _event_summary(conn, "MC1:event:20460605_21_026")
    lift_event = _event_summary(conn, "MC1:event:20460605_22_001")
    external_context = next(
        (
            entry
            for entry in environment
            if entry.get("round_index") == 21 and entry.get("kind") == "media_events"
        ),
        None,
    )

    # 截断时补回"本来满足筛选、只是被行数上限挤掉"的关键事件。
    # 补入候选必须仍满足同一个 EventSelection，不能被角色/渠道/关键词筛掉的记录混进成员轨。
    pinned_events: list[str] = []
    if lane_total > LANE_LIMIT:
        for anchor in (target, lift_event):
            if not anchor:
                continue
            anchor_us = int(anchor["time_us"])
            if not (start_us <= anchor_us < end_us):
                continue
            if any(entry["event_id"] == anchor["event_id"] for entry in messages):
                continue
            matched = conn.execute(
                "SELECT 1 FROM events e WHERE "
                + selection.where_sql
                + " AND e.event_id = :pinned_event_id LIMIT 1",
                {**selection.params, "pinned_event_id": anchor["event_id"]},
            ).fetchone()
            if matched is None:
                continue
            entry = {**anchor, "provenanceKind": "recorded", "pinned": True}
            messages.append(entry)
            if entry.get("channel_scope") == "public":
                releases.append(entry)
            pinned_events.append(anchor["event_id"])
    if pinned_events:
        messages.sort(key=lambda item: item["time_us"])
        releases.sort(key=lambda item: item["time_us"])

    from . import mc1_rules

    indicators = mc1_rules.leading_indicators(
        conn,
        views,
        target_us=target["time_us"] if target else None,
        context=selection.context,
    )

    return {
        "dataset_id": DATASET,
        "window": {"start_us": start_us, "end_us": end_us, "source": window_source},
        "anchors": {
            "external_report": external_context,
            "first_internal_confirmation": target,
            "formal_lift": lift_event,
            "note": "17:00 外部报道以 context_id 表示；没有对应内部发帖事件时不制造 event_id。",
        },
        "tracks": {
            "environment": environment,
            "constraints": constraints,
            "messages": messages,
            "releases": releases,
            "markers": markers,
        },
        "counts": {
            "environment_records": len(environment),
            "constraint_records": len(constraints),
            "messages": len(messages),
            "public_releases": len(releases),
            "analyst_markers": len(markers),
        },
        "lane_limit": LANE_LIMIT,
        "messages_total": lane_total,
        # 判断依据是"窗口内真实总数 > 实际绘制条数（不含补入的关键事件）"
        "truncated": lane_total > (len(messages) - len(pinned_events)),
        "pinned_events": pinned_events,
        "reply_audit": reply_audit(conn, views),
        "leading_indicators": indicators,
        "notes": [
            "环境轨与消息轨严格分层，计数不能相加冒充事件总量。",
            "同轮共现与人工 event_markers 不构成已证实因果。",
            "轮次精度记录以轮次区间显示，不伪装成精确时刻。",
            f"消息轨单窗口最多 {LANE_LIMIT} 条；超出时 truncated=true，并补入窗口内的关键事件（pinned_events）。",
        ],
    }
