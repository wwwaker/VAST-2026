"""MC2 文件检索与文件轨迹。

- 文件按实体 ``file_path`` 的完整路径区分，不同路径即使同名也不合并。
- 轨迹只取记录层的三条文件关系（file_path / queued_file_path / post_content_source），
  同一事件在同一文件上只计一次；时间先后与同文件共现不升级为因果。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import mc2_files
from ..query import filters
from ..query.filters import FilterError, RawFilter
from .events import load_annotations, summarize

router = APIRouter(prefix="/api", tags=["files"])


def _require_mc2(conn, dataset: str):
    try:
        row = require_dataset(conn, dataset)
    except KeyError:
        raise HTTPException(404, f"未知数据集 {dataset}")
    if dataset != "MC2":
        raise HTTPException(400, "unsupported_dataset: 文件轨迹仅 MC2 支持（只有它带 file_path 实体）")
    return row


@router.get("/files")
def list_files(
    dataset: str = Query("MC2"),
    q: str = Query("", description="文件名或路径片段"),
    limit: int = Query(20, ge=1, le=50),
):
    with get_conn() as conn:
        _require_mc2(conn, dataset)
        query = q.strip()
        items = mc2_files.search_files(conn, dataset, query, limit) if query else []
    return {
        "dataset_id": dataset,
        "query": query,
        "items": items,
        "count": len(items),
        "note": "按完整路径区分文件；同名不同路径会分别列出，不按 basename 合并。",
    }


@router.get("/file-track")
def file_track(
    dataset: str = Query("MC2"),
    file_id: str = Query(..., description="文件实体 ID，例如 MC2:file_path:SwiftWren.txt"),
    raw: RawFilter = Depends(filters.filter_params),
    limit: int = Query(100, ge=1, le=500),
    cursor: str | None = None,
    direction: str = Query("asc", pattern="^(asc|desc)$"),
):
    with get_conn() as conn:
        dataset_row = _require_mc2(conn, dataset)
        try:
            info = mc2_files.content_status(conn, dataset, file_id)
        except KeyError:
            raise HTTPException(404, f"未知文件实体 {file_id}")

        try:
            base = filters.build_selection(raw.to_context(dataset))
            selection = base.extend(
                "e.event_id IN (SELECT r.event_id FROM relations r "
                "WHERE r.dataset_id = :ft_dataset AND r.dst_id = :ft_file "
                "AND r.relation IN ('file_path','queued_file_path','post_content_source') "
                "AND r.event_id IS NOT NULL)",
                {"ft_dataset": dataset, "ft_file": file_id},
                salt=f"file:{file_id}",
            )
            matched = filters.count_events(conn, selection)
            rows, next_cursor = filters.page_events(conn, selection, limit, cursor, direction)

            relation_counts = {
                r["relation"]: int(r["cnt"])
                for r in conn.execute(
                    "SELECT r.relation, COUNT(DISTINCT r.event_id) AS cnt FROM relations r "
                    "JOIN events e ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
                    f"WHERE {selection.where_sql} AND r.dst_id = :ft_file "
                    "AND r.relation IN ('file_path','queued_file_path','post_content_source') "
                    "GROUP BY r.relation",
                    {**selection.params, "ft_file": file_id},
                )
            }
            role_map: dict[str, list[str]] = {}
            if rows:
                for item in conn.execute(
                    "SELECT DISTINCT event_id, relation FROM relations "
                    "WHERE dataset_id=? AND dst_id=? AND event_id IN ("
                    + ",".join("?" * len(rows))
                    + ")",
                    [dataset, file_id, *[row["event_id"] for row in rows]],
                ):
                    role_map.setdefault(item["event_id"], []).append(item["relation"])
        except FilterError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

        annotations = load_annotations(conn, dataset, [r["event_id"] for r in rows])
        items = []
        for row in rows:
            item = summarize(row, dataset, annotations.get(row["event_id"], []))
            item["file_relations"] = sorted(role_map.get(row["event_id"], []))
            items.append(item)

    return {
        "meta": filters.build_meta(
            selection,
            scope="file_track",
            data_version=dataset_row["data_version"],
            matched_events=matched,
            truncated=bool(info.get("events_truncated")),
            next_cursor=next_cursor,
        ),
        "file": info,
        "relation_counts": relation_counts,
        "items": items,
        "next_cursor": next_cursor,
        "naming_note": "同名不同路径的文件不会合并；文件名相同不代表同一份内容。",
    }
