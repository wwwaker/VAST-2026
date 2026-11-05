"""聚焦关系子图与边证据。

关键修正（对应审查文档 P0-02）：
- 边以 (src, dst, relation, derivation) 为唯一键，遍历中重复遇到时不再累加计数；
- evidence_count 定义为筛选后 DISTINCT event_id 数，而不是 relations 行数；
- 组织边（event_id IS NULL）单独返回，不计入日志事件数；
- 节点度数改名为 visible_degree，任何一处裁剪都返回具体原因。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..query import filters
from ..query.filters import EventSelection, FilterError, RawFilter
from .events import load_annotations, summarize

router = APIRouter(prefix="/api/graph", tags=["graph"])

MAX_NODES = 80
MAX_EDGES = 300
SEED_PER_HOP = 12
EDGES_PER_SEED = 25


def _display_name(source_value: str | None) -> str | None:
    """MC2 的实体只有 source_value（如 Agent/person:zoey_drydock），点开是一串 ID。
    取最后一段并还原下划线，让图上能读。"""
    if not source_value:
        return None
    tail = source_value.replace("/", ":").split(":")[-1].strip()
    return tail.replace("_", " ") or None


def _edge_rows(conn, selection: EventSelection, seed: str, direction: str, per_dir: int):
    """按稳定边键聚合。SQLite 的裸列 + MIN() 会取到最早时间那一行的 event_id。"""
    seed_clause = "r.src_id = :e_seed" if direction == "out" else "r.dst_id = :e_seed"
    params = {**selection.params, "e_seed": seed, "e_per_dir": per_dir + 1}
    return conn.execute(
        "SELECT r.src_id AS src, r.dst_id AS dst, r.relation, r.derivation, "
        "COUNT(DISTINCT r.event_id) AS evidence_count, "
        "MIN(e.time_sort_us) AS first_us, r.event_id AS first_event_id "
        "FROM relations r JOIN events e "
        "ON e.dataset_id = r.dataset_id AND e.event_id = r.event_id "
        f"WHERE {selection.where_sql} AND r.dataset_id = :f_dataset "
        f"AND r.target_kind = 'entity' AND {seed_clause} "
        "GROUP BY r.src_id, r.dst_id, r.relation, r.derivation "
        "ORDER BY evidence_count DESC, r.relation, r.dst_id LIMIT :e_per_dir",
        params,
    ).fetchall()


@router.get("")
def graph(
    dataset: str,
    center: str,
    raw: RawFilter = Depends(filters.filter_params),
    depth: int = Query(2, ge=1, le=3),
    node_limit: int = Query(MAX_NODES, ge=5, le=MAX_NODES),
    edge_limit: int = Query(MAX_EDGES, ge=10, le=MAX_EDGES),
):
    with get_conn() as conn:
        try:
            dataset_row = require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        exists = conn.execute(
            "SELECT 1 FROM entities WHERE dataset_id=? AND entity_id=?", (dataset, center)
        ).fetchone()
        if not exists:
            raise HTTPException(404, f"未知实体 {center}")

        try:
            selection = filters.build_selection(raw.to_context(dataset))
        except FilterError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

        matched = filters.count_events(conn, selection)

        node_ids: set[str] = {center}
        levels: dict[str, int] = {center: 0}
        edges: dict[tuple[str, str, str, str], dict] = {}
        reasons: set[str] = set()
        frontier = [center]

        for hop in range(depth):
            if not frontier:
                break
            candidates = frontier if hop == 0 else sorted(frontier)[:SEED_PER_HOP]
            if hop > 0 and len(frontier) > SEED_PER_HOP:
                reasons.add("seed_per_hop")
            next_frontier: list[str] = []

            for seed in candidates:
                rows = _edge_rows(conn, selection, seed, "out", EDGES_PER_SEED)
                rows += _edge_rows(conn, selection, seed, "in", EDGES_PER_SEED)
                if len(rows) > EDGES_PER_SEED * 2:
                    reasons.add("edges_per_seed")

                for row in rows:
                    src = row["src"] or ""
                    dst = row["dst"]
                    endpoints = [endpoint for endpoint in (src, dst) if endpoint]
                    new_endpoints = [endpoint for endpoint in endpoints if endpoint not in node_ids]
                    if len(node_ids) + len(new_endpoints) > node_limit:
                        reasons.add("node_limit")
                        continue

                    key = (src, dst, row["relation"], row["derivation"])
                    if key in edges:
                        # 同一聚合边可能由多个种子命中；只接受一次，不重复累加
                        continue
                    if len(edges) >= edge_limit:
                        reasons.add("edge_limit")
                        break

                    for endpoint in new_endpoints:
                        node_ids.add(endpoint)
                        levels[endpoint] = hop + 1
                        if endpoint != seed:
                            next_frontier.append(endpoint)

                    edges[key] = {
                        "source": src,
                        "target": dst,
                        "relation": row["relation"],
                        "derivation": row["derivation"],
                        "kind": "dynamic",
                        "provenance_kind": "recorded"
                        if str(row["derivation"]).startswith("source:")
                        else "derived",
                        "evidence_count": int(row["evidence_count"]),
                        "first_us": row["first_us"],
                        "first_event_id": row["first_event_id"],
                    }
                if len(edges) >= edge_limit:
                    reasons.add("edge_limit")
                    break
            if len(edges) >= edge_limit:
                break
            frontier = list(dict.fromkeys(n for n in next_frontier if n))

        ids = sorted(node_ids)
        meta_rows = {
            r["entity_id"]: dict(r)
            for r in conn.execute(
                "SELECT entity_id, entity_type, label, source_value FROM entities "
                "WHERE dataset_id=? AND entity_id IN (" + ",".join("?" * len(ids)) + ")",
                [dataset, *ids],
            )
        }

        # 静态组织边：没有 event_id，只表示“记录中存在的组织关系”，不参与日志计数
        static_rows = conn.execute(
            "SELECT src_id, dst_id, relation, derivation FROM relations "
            "WHERE dataset_id=? AND event_id IS NULL AND target_kind='entity' "
            "AND (src_id IN (" + ",".join("?" * len(ids)) + ") OR dst_id IN ("
            + ",".join("?" * len(ids)) + "))",
            [dataset, *ids, *ids],
        ).fetchall()
        static_edges = []
        seen_static: set[tuple[str, str, str, str]] = set()
        for row in static_rows:
            key = (row["src_id"], row["dst_id"], row["relation"], row["derivation"])
            if key in seen_static:
                continue
            seen_static.add(key)
            static_edges.append(
                {
                    "source": row["src_id"],
                    "target": row["dst_id"],
                    "relation": row["relation"],
                    "derivation": row["derivation"],
                    "kind": "static",
                    "provenance_kind": "recorded",
                    "evidence_count": 0,
                    "observation_count": 1,
                }
            )

    visible_degree: dict[str, int] = {nid: 0 for nid in node_ids}
    for edge in edges.values():
        if edge["source"]:
            visible_degree[edge["source"]] = visible_degree.get(edge["source"], 0) + 1
        visible_degree[edge["target"]] = visible_degree.get(edge["target"], 0) + 1

    nodes = []
    for nid in ids:
        if not nid:
            continue
        info = meta_rows.get(nid) or {}
        nodes.append(
            {
                "id": nid,
                "label": info.get("label") or _display_name(info.get("source_value")) or nid,
                "entity_type": info.get("entity_type") or "unknown",
                "visible_degree": visible_degree.get(nid, 0),
                "is_center": nid == center,
                "level": levels.get(nid, 1),
            }
        )

    truncated = bool(reasons)
    return {
        "meta": filters.build_meta(
            selection,
            scope="filtered",
            data_version=dataset_row["data_version"],
            matched_events=matched,
            truncated=truncated,
        ),
        "dataset_id": dataset,
        "center": center,
        "depth": depth,
        "truncated": truncated,
        "truncation_reasons": sorted(reasons),
        "node_limit": node_limit,
        "edge_limit": edge_limit,
        "nodes": nodes,
        "edges": list(edges.values()),
        "static_edges": static_edges,
    }


@router.get("/evidence")
def graph_evidence(
    dataset: str,
    src: str,
    dst: str,
    relation: str,
    derivation: str,
    raw: RawFilter = Depends(filters.filter_params),
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
    direction: str = Query("asc", pattern="^(asc|desc)$"),
):
    """以边键 + 同一筛选上下文打开完整证据列表。"""
    with get_conn() as conn:
        try:
            dataset_row = require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        try:
            base = filters.build_selection(raw.to_context(dataset))
            selection = base.extend(
                "e.event_id IN (SELECT r.event_id FROM relations r "
                "WHERE r.dataset_id = :g_dataset AND r.src_id = :g_src AND r.dst_id = :g_dst "
                "AND r.relation = :g_relation AND r.derivation = :g_derivation "
                "AND r.event_id IS NOT NULL)",
                {
                    "g_dataset": dataset,
                    "g_src": src,
                    "g_dst": dst,
                    "g_relation": relation,
                    "g_derivation": derivation,
                },
                salt=f"edge:{src}|{dst}|{relation}|{derivation}",
            )
            matched = filters.count_events(conn, selection)
            rows, next_cursor = filters.page_events(conn, selection, limit, cursor, direction)
        except FilterError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

        annotations = load_annotations(conn, dataset, [r["event_id"] for r in rows])
        items = [summarize(row, dataset, annotations.get(row["event_id"], [])) for row in rows]

    return {
        "meta": filters.build_meta(
            selection,
            scope="edge_evidence",
            data_version=dataset_row["data_version"],
            matched_events=matched,
            next_cursor=next_cursor,
        ),
        "edge": {
            "source": src,
            "target": dst,
            "relation": relation,
            "derivation": derivation,
        },
        "items": items,
        "next_cursor": next_cursor,
    }
