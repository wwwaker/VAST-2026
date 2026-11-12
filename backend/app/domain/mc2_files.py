"""MC2 文件实体与内容来源审计（S3A）。

数据边界（与审查文档 §11 一致）：
- 只处理 MC2：只有它带 ``file_path`` 实体。
- ``relations`` 里的 ``file_path`` / ``queued_file_path`` / ``post_content_source`` 是记录层事实；
  文件名相似（例如 ``SwiftWren.txt`` 与 ``SwiftWren_further_instructions.md``）只能生成
  *候选*，必须带 rule_id 与解释，不计入已证实传播，也不加进 matched_events。
- 日志没有提供帖子正文：本模块只回答“来源文件名可追踪”，不臆测“内容含义”。
  内容状态用 available / metadata_only / unresolved 三态，available 必须给出具体字段与事件。
"""

from __future__ import annotations

import json
from typing import Any

FILE_RELATIONS = ("file_path", "queued_file_path", "post_content_source")
# 可能承载正文的字段名；命中后仍需给出事件与字段指针，不能只凭字段名宣布“已解码”
CONTENT_KEYS = ("content", "body", "text", "content_text", "post_content", "message")
MIN_CONTENT_LEN = 40


def _json(value: str | None) -> dict:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def file_row(conn, dataset: str, file_id: str):
    return conn.execute(
        "SELECT entity_id, entity_type, source_value, label FROM entities "
        "WHERE dataset_id=? AND entity_id=? AND entity_type='file_path'",
        (dataset, file_id),
    ).fetchone()


def search_files(conn, dataset: str, query: str, limit: int = 20) -> list[dict]:
    """按完整路径精确匹配优先，其次子串匹配；不同路径即使同名也不合并。"""
    query = (query or "").strip()
    if not query:
        return []
    like = f"%{query}%"
    rows = conn.execute(
        "SELECT en.entity_id, en.source_value, "
        "  (SELECT COUNT(*) FROM relations r WHERE r.dataset_id=en.dataset_id "
        "     AND r.dst_id=en.entity_id AND r.relation IN ('file_path','queued_file_path','post_content_source')) AS ops, "
        "  (SELECT MIN(e.time_sort_us) FROM relations r JOIN events e "
        "     ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
        "     WHERE r.dataset_id=en.dataset_id AND r.dst_id=en.entity_id) AS first_us, "
        "  (SELECT MAX(e.time_sort_us) FROM relations r JOIN events e "
        "     ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
        "     WHERE r.dataset_id=en.dataset_id AND r.dst_id=en.entity_id) AS last_us "
        "FROM entities en WHERE en.dataset_id=? AND en.entity_type='file_path' "
        "AND en.source_value LIKE ? "
        "ORDER BY (en.source_value = ?) DESC, ops DESC, en.source_value "
        "LIMIT ?",
        (dataset, like, query, limit),
    ).fetchall()
    return [
        {
            "file_id": row["entity_id"],
            "path": row["source_value"],
            "event_count": int(row["ops"] or 0),
            "first_us": row["first_us"],
            "last_us": row["last_us"],
            "exact": row["source_value"] == query,
        }
        for row in rows
    ]


def _file_events(conn, dataset: str, file_id: str, limit: int = 500) -> tuple[list[dict], bool]:
    rows = conn.execute(
        "SELECT e.event_id, e.event_type, e.time_sort_us, e.actor_id, e.details_json, "
        "       r.relation, en.label AS actor_label "
        "FROM relations r JOIN events e "
        "  ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
        "LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
        "WHERE r.dataset_id=? AND r.dst_id=? AND r.event_id IS NOT NULL "
        "  AND r.relation IN ('file_path','queued_file_path','post_content_source') "
        "ORDER BY e.time_sort_us, e.event_id LIMIT ?",
        (dataset, file_id, limit + 1),
    ).fetchall()
    truncated = len(rows) > limit
    items = [
        {
            "event_id": row["event_id"],
            "event_type": row["event_type"],
            "time_us": row["time_sort_us"],
            "actor_id": row["actor_id"],
            "actor_label": row["actor_label"],
            "relation": row["relation"],
            "details": _json(row["details_json"]),
        }
        for row in rows[:limit]
    ]
    return items, truncated


def content_status(conn, dataset: str, file_id: str) -> dict:
    """回答“能否看到文件正文”，三态且必须给出依据。"""
    row = file_row(conn, dataset, file_id)
    if row is None:
        raise KeyError(file_id)

    events, truncated = _file_events(conn, dataset, file_id)
    # The inspection sample is bounded; aggregate counts must cover distinct
    # source events, including those beyond that sample and multiple relations.
    totals = conn.execute(
        "SELECT e.event_type, COUNT(*) AS cnt, MIN(e.time_sort_us) AS first_us, "
        "MAX(e.time_sort_us) AS last_us FROM events e JOIN "
        "(SELECT DISTINCT event_id FROM relations WHERE dataset_id=? AND dst_id=? "
        "AND relation IN ('file_path','queued_file_path','post_content_source')) r "
        "ON e.event_id=r.event_id WHERE e.dataset_id=? "
        "GROUP BY e.event_type", (dataset, file_id, dataset)
    ).fetchall()
    type_counts = {r['event_type']: int(r['cnt']) for r in totals}
    size_hint: int | None = None
    content_hits: list[dict] = []
    for item in events:
        details = item["details"]
        if isinstance(details.get("size_hint"), int):
            size_hint = details["size_hint"]
        for key in CONTENT_KEYS:
            value = details.get(key)
            if isinstance(value, str) and len(value) >= MIN_CONTENT_LEN:
                content_hits.append(
                    {"event_id": item["event_id"], "field": f"details.{key}", "length": len(value)}
                )

    event_ids = [item["event_id"] for item in events]
    first_us = min((r['first_us'] for r in totals), default=None)
    last_us = max((r['last_us'] for r in totals), default=None)

    if content_hits:
        status = "available"
        reason = "至少一条关联事件的 details 含正文级文本字段"
        missing: list[str] = []
        supports = ["文件来源可追踪", "正文文本可定位到具体事件字段"]
        cannot: list[str] = []
    elif events and (size_hint is not None or any(item["details"] for item in events)):
        status = "metadata_only"
        reason = "日志记录了文件名、动作或 size_hint，但没有正文文本"
        missing = ["文件正文", "编码或格式说明"]
        supports = ["文件名/路径可追踪", "创建、读取、删除等操作可按时间排序"]
        cannot = ["帖子正文含义", "文件内容的真伪或完整性"]
    else:
        status = "unresolved"
        reason = "该文件实体没有任何可解析的事件记录"
        missing = ["关联事件", "文件正文"]
        supports = ["实体在源文件中存在"]
        cannot = ["任何操作或内容结论"]

    return {
        "file_id": row["entity_id"],
        "path": row["source_value"],
        "label": row["label"],
        "content_status": status,
        "reason": reason,
        "size_hint": size_hint,
        "event_count": sum(type_counts.values()),
        "summary_scope": "global",
        "content_inspection_limit": 500,
        "event_type_counts": type_counts,
        "first_us": first_us,
        "last_us": last_us,
        "content_sources": content_hits,
        "checked_sources": [
            "events.details_json",
            "event_raw.raw_json",
            f"relations.relation ∈ {list(FILE_RELATIONS)}",
        ],
        "missing_fields": missing,
        "supports": supports,
        "cannot_support": cannot,
        "event_ids": event_ids[:50],
        "events_truncated": truncated,
    }


def shared_prefix_candidates(conn, dataset: str, file_id: str, limit: int = 5) -> list[dict]:
    """同名前缀只作检索提示。返回候选文件及其接力事件数，不生成“已证实传播”。"""
    row = file_row(conn, dataset, file_id)
    if row is None:
        return []
    name = row["source_value"] or ""
    prefix = name.split(".")[0].split("_")[0].strip()
    if len(prefix) < 4:
        return []
    rows = conn.execute(
        "SELECT en.entity_id, en.source_value, "
        "  (SELECT COUNT(*) FROM relations r WHERE r.dataset_id=en.dataset_id "
        "     AND r.dst_id=en.entity_id AND r.relation='queued_file_path') AS relays "
        "FROM entities en WHERE en.dataset_id=? AND en.entity_type='file_path' "
        "AND en.entity_id<>? AND en.source_value LIKE ? "
        "ORDER BY relays DESC, en.source_value LIMIT ?",
        (dataset, file_id, f"{prefix}%", limit),
    ).fetchall()
    return [
        {
            "file_id": item["entity_id"],
            "path": item["source_value"],
            "relay_event_count": int(item["relays"] or 0),
        }
        for item in rows
    ]


def trace(conn, selection, root_event_id: str, max_events: int = 100) -> dict:
    """来源链：记录层（post→内容文件→文件操作）+ 候选层（同名前缀提示）。

    只使用显式关系；时间先后与同文件共现不生成记录边。
    """
    root = conn.execute(
        "SELECT e.event_id, e.event_type, e.time_sort_us, e.actor_id, e.details_json, "
        "       en.label AS actor_label "
        "FROM events e LEFT JOIN entities en "
        "  ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
        "WHERE e.dataset_id=? AND e.event_id=?",
        (selection.dataset, root_event_id),
    ).fetchone()
    if root is None:
        raise KeyError(root_event_id)

    nodes: dict[str, dict] = {}
    edges: dict[str, dict] = {}
    reasons: set[str] = set()
    unresolved: list[str] = []

    nodes[root["event_id"]] = {
        "id": root["event_id"],
        "kind": "event",
        "role": "root",
        "event_id": root["event_id"],
        "event_type": root["event_type"],
        "time_us": root["time_sort_us"],
        "actor_id": root["actor_id"],
        "actor_label": root["actor_label"],
        "details": _json(root["details_json"]),
        "label": root["event_id"],
    }

    def add_edge(source: str, target: str, relation: str, provenance: str, **extra) -> None:
        key = f"{source}|{target}|{relation}|{provenance}"
        if key in edges:
            return
        edges[key] = {
            "id": key,
            "sourceId": source,
            "targetId": target,
            "relation": relation,
            "provenanceKind": provenance,
            "temporalStatus": extra.pop("temporal_status", "valid"),
            "evidenceEventIds": extra.pop("evidence_event_ids", []),
            "ruleId": extra.pop("rule_id", None),
            "explanation": extra.pop("explanation", ""),
            **extra,
        }

    # ---- 记录层：根事件直接引用的文件
    file_links = conn.execute(
        "SELECT dst_id, relation FROM relations WHERE dataset_id=? AND event_id=? "
        "AND relation IN ('file_path','queued_file_path','post_content_source') "
        "ORDER BY relation",
        (selection.dataset, root_event_id),
    ).fetchall()

    file_ids: list[str] = []
    for link in file_links:
        file_id = link["dst_id"]
        info = file_row(conn, selection.dataset, file_id)
        if info is None:
            unresolved.append(file_id)
            continue
        if file_id not in file_ids:
            file_ids.append(file_id)
        nodes.setdefault(
            file_id,
            {
                "id": file_id,
                "kind": "entity",
                "role": "file",
                "entity_type": "file_path",
                "path": info["source_value"],
                "label": info["source_value"],
                "details": {},
            },
        )
        add_edge(
            root_event_id,
            file_id,
            link["relation"],
            "recorded",
            evidence_event_ids=[root_event_id],
            explanation="事件载荷直接给出该文件字段",
        )

    # ---- 记录层：文件上的操作（同一筛选、同一回放截止）
    budget = {"events": max_events, "used": 0, "truncated": False, "reasons": []}
    for file_id in file_ids:
        rows = conn.execute(
            "SELECT DISTINCT e.event_id, e.event_type, e.time_sort_us, e.actor_id, "
            "       e.details_json, en.label AS actor_label, r.relation "
            "FROM events e JOIN relations r "
            "  ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
            "LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
            f"WHERE {selection.where_sql} AND r.dst_id = :t_file "
            "  AND r.relation IN ('file_path','queued_file_path','post_content_source') "
            "ORDER BY e.time_sort_us, e.event_id LIMIT :t_limit",
            {**selection.params, "t_file": file_id, "t_limit": max_events + 1},
        ).fetchall()
        if len(rows) > max_events:
            reasons.add("event_budget")
        for row in rows[:max_events]:
            # 根事件已经用 root→file 的边表示，不再重复画 file→root，避免出现两节点环
            if row["event_id"] == root_event_id:
                continue
            if budget["used"] >= max_events:
                reasons.add("event_budget")
                break
            budget["used"] += 1
            nid = row["event_id"]
            nodes.setdefault(
                nid,
                {
                    "id": nid,
                    "kind": "event",
                    "role": "file_operation",
                    "event_id": nid,
                    "event_type": row["event_type"],
                    "time_us": row["time_sort_us"],
                    "actor_id": row["actor_id"],
                    "actor_label": row["actor_label"],
                    "details": _json(row["details_json"]),
                    "label": nid,
                },
            )
            add_edge(
                file_id,
                nid,
                row["relation"],
                "recorded",
                evidence_event_ids=[nid],
                explanation="该事件的载荷或关系字段指向此文件",
            )

    # ---- 候选层：同名前缀只能作为检索提示（没有支持事件）
    candidates: list[dict] = []
    for file_id in file_ids:
        for item in shared_prefix_candidates(conn, selection.dataset, file_id):
            nodes.setdefault(
                item["file_id"],
                {
                    "id": item["file_id"],
                    "kind": "entity",
                    "role": "candidate_file",
                    "entity_type": "file_path",
                    "path": item["path"],
                    "label": item["path"],
                    "relay_event_count": item["relay_event_count"],
                    "details": {},
                },
            )
            add_edge(
                file_id,
                item["file_id"],
                "name_hint",
                "candidate",
                rule_id="shared_prefix_hint",
                explanation=(
                    "两条路径共享文件名前缀，仅作检索提示；日志没有记录该文件被转交给发布者，"
                    "因此不构成已证实传播"
                ),
                evidence_event_ids=[],
                temporal_status="unknown",
            )
            candidates.append(item)

    budget["truncated"] = bool(reasons)
    budget["reasons"] = sorted(reasons)

    return {
        "root_event_id": root_event_id,
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "files": [
            {
                **content_status(conn, selection.dataset, file_id),
            }
            for file_id in file_ids
        ],
        "candidates": candidates,
        "unresolved": {"count": len(unresolved), "ids": unresolved[:10]},
        "budget": budget,
    }
