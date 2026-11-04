"""聚焦关系子图。

节点上限、每跳扩展种子数都在服务端硬限流：MC2 有 98.5% 的实体是 file_path，
不裁剪的话一次请求就能拖回上万个节点。裁剪结果会显式返回 truncated=true。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..db import get_conn, require_dataset

router = APIRouter(prefix="/api/graph", tags=["graph"])

MAX_NODES = 80
MAX_EDGES = 300
SEED_PER_HOP = 10
EDGES_PER_SEED = 25


def _display_name(source_value: str | None) -> str | None:
    """MC2 的实体只有 source_value（如 Agent/person:zoey_drydock），点开是一串 ID。
    取最后一段并还原下划线，让图上能读。"""
    if not source_value:
        return None
    tail = source_value.replace("/", ":").split(":")[-1].strip()
    return tail.replace("_", " ") or None


def _edges_of(conn, dataset: str, entity_id: str, per_dir: int):
    # 只取实体关系：reply_to 指向的是另一条事件，端点不是实体，不能进图
    out = conn.execute(
        "SELECT src_id, dst_id, relation, derivation, event_id FROM relations "
        "WHERE dataset_id=? AND src_id=? AND target_kind='entity' LIMIT ?",
        (dataset, entity_id, per_dir),
    ).fetchall()
    inn = conn.execute(
        "SELECT src_id, dst_id, relation, derivation, event_id FROM relations "
        "WHERE dataset_id=? AND dst_id=? AND target_kind='entity' LIMIT ?",
        (dataset, entity_id, per_dir),
    ).fetchall()
    return [*out, *inn]


@router.get("")
def graph(
    dataset: str,
    center: str,
    depth: int = Query(1, ge=1, le=2),
    node_limit: int = Query(MAX_NODES, ge=5, le=MAX_NODES),
):
    with get_conn() as conn:
        try:
            require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        exists = conn.execute(
            "SELECT 1 FROM entities WHERE dataset_id=? AND entity_id=?", (dataset, center)
        ).fetchone()
        if not exists:
            raise HTTPException(404, f"未知实体 {center}")

        node_ids: set[str] = {center}
        raw_edges: dict[tuple[str, str, str], dict] = {}
        frontier = [center]
        truncated = False

        for hop in range(depth):
            next_frontier: list[str] = []
            # 每跳只扩展有限个种子，按节点 ID 排序保证结果可复现
            for seed in sorted(frontier)[:SEED_PER_HOP if hop > 0 else len(frontier)]:
                rows = _edges_of(conn, dataset, seed, EDGES_PER_SEED * (1 if hop == 0 else 1))
                for row in rows:
                    src, dst = row["src_id"], row["dst_id"]
                    # src 为 null 的边（源 actor 缺失）仍然保留，用 dst 一端呈现
                    if src is None:
                        src = ""
                    if src not in node_ids and len(node_ids) >= node_limit:
                        truncated = True
                        continue
                    if dst not in node_ids and len(node_ids) >= node_limit:
                        truncated = True
                        continue
                    if src:
                        node_ids.add(src)
                        if src != seed:
                            next_frontier.append(src)
                    node_ids.add(dst)
                    if dst != seed:
                        next_frontier.append(dst)

                    key = (src, dst, row["relation"])
                    entry = raw_edges.get(key)
                    if entry is None:
                        raw_edges[key] = {
                            "source": src,
                            "target": dst,
                            "relation": row["relation"],
                            "derivation": row["derivation"],
                            "evidence_count": 1,
                            "evidence_event_id": row["event_id"],
                        }
                    else:
                        entry["evidence_count"] += 1

                if len(raw_edges) >= MAX_EDGES:
                    truncated = True
                    break
            if len(raw_edges) >= MAX_EDGES or len(node_ids) >= node_limit:
                break
            frontier = [n for n in next_frontier if n]

        if len(raw_edges) > MAX_EDGES:
            raw_edges = dict(list(sorted(raw_edges.items()))[:MAX_EDGES])
            truncated = True

        ids = sorted(node_ids)
        meta = {
            # sqlite3.Row 没有 .get，先转 dict
            r["entity_id"]: dict(r)
            for r in conn.execute(
                "SELECT entity_id, entity_type, label, source_value FROM entities "
                "WHERE dataset_id=? AND entity_id IN (" + ",".join("?" * len(ids)) + ")",
                [dataset, *ids],
            )
        }

    degree: dict[str, int] = {i: 0 for i in node_ids}
    for edge in raw_edges.values():
        if edge["source"]:
            degree[edge["source"]] = degree.get(edge["source"], 0) + 1
        degree[edge["target"]] = degree.get(edge["target"], 0) + 1

    nodes = []
    for nid in ids:
        if not nid:
            continue
        info = meta.get(nid) or {}
        nodes.append(
            {
                "id": nid,
                "label": info.get("label") or _display_name(info.get("source_value")) or nid,
                "entity_type": info.get("entity_type") or "unknown",
                "degree": degree.get(nid, 0),
                "is_center": nid == center,
            }
        )

    return {
        "dataset_id": dataset,
        "center": center,
        "depth": depth,
        "truncated": truncated,
        "node_limit": node_limit,
        "nodes": nodes,
        "edges": list(raw_edges.values()),
    }
