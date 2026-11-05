"""关键词检索：FTS5 + 两段式取数。

踩过的坑（见 docs/后端接口说明.md）：
1. `snippet()` 会对每个命中行重新切词，实测 1000 ms，已弃用，改为在应用层截取上下文。
2. `event_fts_idx` 直接 JOIN `events` 时，规划器会退化成 `SCAN events`（每次命中扫 18 万行），
   实测 2.5 s。因此先只取 rowid，再用主键批量回表，总耗时 1–2 ms。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import event_types
from ..query import filters

router = APIRouter(prefix="/api/search", tags=["search"])


def _excerpt(body: str, query: str, width: int = 60) -> str:
    """在命中文本里截取关键词附近的一段，做不了词形还原，只按小写匹配定位。"""
    if not body:
        return ""
    lowered = body.lower()
    for term in query.replace('"', " ").split():
        if len(term) < 2:
            continue
        index = lowered.find(term.lower())
        if index >= 0:
            start = max(0, index - width // 2)
            end = min(len(body), index + width // 2)
            prefix = "…" if start > 0 else ""
            suffix = "…" if end < len(body) else ""
            return prefix + " ".join(body[start:end].split()) + suffix
    return " ".join(body[:width].split())


@router.get("")
def search(
    dataset: str,
    q: str = Query(..., min_length=1),
    limit: int = Query(50, ge=1, le=200),
):
    with get_conn() as conn:
        try:
            require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        try:
            match_query = filters.fts_match_query(q)
            hits = conn.execute(
                "SELECT f.rowid AS rid, f.event_id FROM event_fts_idx i "
                "JOIN event_fts f ON f.rowid = i.rowid "
                "WHERE event_fts_idx MATCH ? AND f.dataset_id = ? LIMIT ?",
                (match_query, dataset, limit),
            ).fetchall()
        except Exception as exc:  # FTS 语法错误
            raise HTTPException(400, f"检索语法错误：{exc}")

        if not hits:
            return {"dataset_id": dataset, "query": q, "items": []}

        rowids = [h["rid"] for h in hits]
        bodies = {
            r["rowid"]: r["body"]
            for r in conn.execute(
                "SELECT rowid, body FROM event_fts WHERE rowid IN ("
                + ",".join("?" * len(rowids))
                + ")",
                rowids,
            )
        }
        event_ids = [h["event_id"] for h in hits]
        meta = {
            r["event_id"]: r
            for r in conn.execute(
                "SELECT event_id, timestamp_normalized, time_sort_us, event_type, actor_id, details_json FROM events "
                "WHERE dataset_id=? AND event_id IN (" + ",".join("?" * len(event_ids)) + ")",
                [dataset, *event_ids],
            )
        }

    items = []
    for hit in hits:
        row = meta.get(hit["event_id"])
        if row is None:
            continue
        items.append(
            {
                "event_id": hit["event_id"],
                "timestamp": row["timestamp_normalized"],
                "time_us": row["time_sort_us"],
                "event_type": row["event_type"],
                "category": event_types.category_of(dataset, row["event_type"]),
                "actor_id": row["actor_id"],
                "excerpt": _excerpt(bodies.get(hit["rid"], ""), q),
            }
        )

    return {
        "dataset_id": dataset,
        "query": q,
        "ordered_by": "index_hit_order",
        "items": items,
    }
