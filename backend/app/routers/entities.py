"""实体查询、实体时间线与一跳邻接。

邻接查询刻意不在 SQL 里做 GROUP BY：hub 节点上万条边，聚合发生在 LIMIT 之前会退化。
正确做法是各分支先限流，再在应用层合并（见《SQLite 基准报告》§4.4）。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import event_types
from .events import _preview

router = APIRouter(prefix="/api/entities", tags=["entities"])


@router.get("")
def list_entities(
    dataset: str,
    q: str | None = None,
    type: str | None = None,
    limit: int = Query(100, ge=1, le=500),
):
    where = ["dataset_id=?"]
    params: list = [dataset]
    if type:
        where.append("entity_type=?")
        params.append(type)
    if q:
        where.append("(entity_id LIKE ? OR label LIKE ? OR source_value LIKE ?)")
        params.extend([f"%{q}%"] * 3)

    with get_conn() as conn:
        try:
            require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        rows = conn.execute(
            "SELECT entity_id, entity_type, source_value, label, roles_json "
            "FROM entities WHERE " + " AND ".join(where) + " ORDER BY entity_id LIMIT ?",
            [*params, limit],
        ).fetchall()

        counts = {
            r["entity_type"]: r["c"]
            for r in conn.execute(
                "SELECT entity_type, COUNT(*) c FROM entities WHERE dataset_id=? GROUP BY entity_type",
                (dataset,),
            )
        }

    return {
        "dataset_id": dataset,
        "type_counts": counts,
        "items": [
            {
                "entity_id": r["entity_id"],
                "entity_type": r["entity_type"],
                "source_value": r["source_value"],
                "label": r["label"],
                "roles": json.loads(r["roles_json"]) if r["roles_json"] else [],
            }
            for r in rows
        ],
    }


@router.get("/{entity_id:path}/events")
def entity_events(
    entity_id: str,
    dataset: str,
    limit: int = Query(300, ge=1, le=1000),
    start_us: int | None = Query(None, ge=0),
    end_us: int | None = Query(None, ge=0),
):
    where = ["p.dataset_id=?", "p.entity_id=?"]
    params: list = [dataset, entity_id]
    if start_us is not None:
        where.append("p.time_sort_us>=?")
        params.append(start_us)
    if end_us is not None:
        where.append("p.time_sort_us<?")
        params.append(end_us)

    with get_conn() as conn:
        try:
            require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        # 用 participants 的去规格化时间键排序，避免回表排序；v2 使用微秒列
        rows = conn.execute(
            "SELECT e.event_id, e.timestamp_normalized, e.time_sort_us, e.event_type, e.actor_id, "
            "e.details_json, p.role "
            "FROM participants p JOIN events e "
            "ON e.dataset_id=p.dataset_id AND e.event_id=p.event_id "
            "WHERE " + " AND ".join(where)
            + " ORDER BY p.time_sort_us, e.event_id LIMIT ?",
            [*params, limit],
        ).fetchall()

    return {
        "dataset_id": dataset,
        "entity_id": entity_id,
        "items": [
            {
                "event_id": r["event_id"],
                "timestamp": r["timestamp_normalized"],
                "time_us": r["time_sort_us"],
                "event_type": r["event_type"],
                "category": event_types.category_of(dataset, r["event_type"]),
                "actor_id": r["actor_id"],
                "role": r["role"],
                "preview": _preview(r["details_json"]),
            }
            for r in rows
        ],
    }


@router.get("/{entity_id:path}/neighbors")
def neighbors(entity_id: str, dataset: str, limit: int = Query(150, ge=1, le=500)):
    with get_conn() as conn:
        try:
            require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        out_rows = conn.execute(
            "SELECT dst_id AS other, relation, 'out' AS direction FROM relations "
            "WHERE dataset_id=? AND src_id=? AND target_kind='entity' LIMIT ?",
            (dataset, entity_id, limit),
        ).fetchall()
        in_rows = conn.execute(
            "SELECT src_id AS other, relation, 'in' AS direction FROM relations "
            "WHERE dataset_id=? AND dst_id=? AND target_kind='entity' LIMIT ?",
            (dataset, entity_id, limit),
        ).fetchall()

        merged: dict[tuple[str, str], dict] = {}
        for row in [*out_rows, *in_rows]:
            other = row["other"]
            if not other:
                continue
            key = (other, row["direction"])
            node = merged.setdefault(
                key, {"entity_id": other, "direction": row["direction"], "relations": {}, "count": 0}
            )
            node["relations"][row["relation"]] = node["relations"].get(row["relation"], 0) + 1
            node["count"] += 1

        labels = {
            r["entity_id"]: (r["label"], r["entity_type"])
            for r in conn.execute(
                "SELECT entity_id, label, entity_type FROM entities WHERE dataset_id=? AND entity_id IN ("
                + ",".join("?" * max(1, len(merged)))
                + ")",
                [dataset, *[k[0] for k in merged]] if merged else [dataset, ""],
            )
        }

    nodes = []
    for node in merged.values():
        label, etype = labels.get(node["entity_id"], (None, None))
        nodes.append({**node, "label": label, "entity_type": etype})
    nodes.sort(key=lambda n: n["count"], reverse=True)

    return {
        "dataset_id": dataset,
        "entity_id": entity_id,
        "truncated": len(nodes) >= limit * 2,
        "nodes": nodes,
    }
