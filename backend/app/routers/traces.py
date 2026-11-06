"""来源链（trace）：记录层 + 候选层。

记录层只包含显式引用：post → post_content_source 文件、文件 → 具体操作事件。
候选层只包含“同名前缀提示”，没有支持事件，不能计入已证实传播。
回放遮蔽下，根事件晚于游标时直接拒绝，避免把未来信息当作当前已知。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import mc2_files
from ..query import filters
from ..query.filters import FilterError, RawFilter
from .events import _preview

router = APIRouter(prefix="/api", tags=["traces"])

DEFAULT_MAX_EVENTS = 100
MAX_MAX_EVENTS = 500


@router.get("/traces/roots")
def trace_roots(
    dataset: str = Query("MC2"),
    limit: int = Query(20, ge=1, le=100),
):
    """可作链根的发布事件（带 post_content_source 的那些）。

    这是“历史实例”的候选入口：每条都明确指向一个内容文件，而不是按文件名猜测。
    """
    with get_conn() as conn:
        try:
            require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")
        if dataset != "MC2":
            raise HTTPException(400, "unsupported_dataset: 来源链当前仅 MC2 支持")
        rows = conn.execute(
            "SELECT r.event_id, r.dst_id AS file_id, f.source_value AS file_path, "
            "       e.time_sort_us, e.actor_id, en.label AS actor_label "
            "FROM relations r JOIN events e "
            "  ON e.dataset_id = r.dataset_id AND e.event_id = r.event_id "
            "LEFT JOIN entities f "
            "  ON f.dataset_id = r.dataset_id AND f.entity_id = r.dst_id "
            "LEFT JOIN entities en "
            "  ON en.dataset_id = e.dataset_id AND en.entity_id = e.actor_id "
            "WHERE r.dataset_id=? AND r.relation='post_content_source' "
            "ORDER BY e.time_sort_us DESC LIMIT ?",
            (dataset, limit),
        ).fetchall()
    return {
        "dataset_id": dataset,
        "items": [
            {
                "event_id": row["event_id"],
                "file_id": row["file_id"],
                "file_path": row["file_path"],
                "time_us": row["time_sort_us"],
                "actor_id": row["actor_id"],
                "actor_label": row["actor_label"],
            }
            for row in rows
        ],
        "note": "仅列出日志明确记录 content_source 的发布事件；不代表这些是全部异常发布。",
    }


@router.get("/traces")
def traces(
    dataset: str = Query("MC2"),
    root_event_id: str = Query(..., description="链根事件，例如 MC2:event:373902"),
    raw: RawFilter = Depends(filters.filter_params),
    max_events: int = Query(DEFAULT_MAX_EVENTS, ge=10, le=MAX_MAX_EVENTS),
):
    with get_conn() as conn:
        try:
            dataset_row = require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")
        if dataset != "MC2":
            raise HTTPException(400, "unsupported_dataset: 来源链当前仅 MC2 支持")

        try:
            selection = filters.build_selection(raw.to_context(dataset))
        except FilterError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

        try:
            payload = mc2_files.trace(conn, selection, root_event_id, max_events)
        except KeyError:
            raise HTTPException(404, f"未知事件 {root_event_id}")

        root_node = next((n for n in payload["nodes"] if n["id"] == root_event_id), None)
        root_time = root_node["time_us"] if root_node else None
        if root_time is not None and selection.end_us is not None and root_time >= selection.end_us:
            raise HTTPException(
                409,
                "root_after_cursor: 根事件晚于当前回放截止时间，不能作为当前已知信息展开",
            )
        if root_time is not None and selection.start_us is not None and root_time < selection.start_us:
            raise HTTPException(409, "root_outside_window: 根事件早于当前观察窗口")

        matched = filters.count_events(conn, selection)

    for node in payload["nodes"]:
        if node["kind"] == "event":
            node["preview"] = _preview(json.dumps(node.get("details") or {}, ensure_ascii=False))
        node.pop("details", None)

    recorded = [e for e in payload["edges"] if e["provenanceKind"] == "recorded"]
    candidates = [e for e in payload["edges"] if e["provenanceKind"] == "candidate"]
    return {
        "meta": filters.build_meta(
            selection,
            scope="trace",
            data_version=dataset_row["data_version"],
            matched_events=matched,
            truncated=bool(payload["budget"]["truncated"]),
        ),
        "dataset_id": dataset,
        "root_event_id": root_event_id,
        "nodes": payload["nodes"],
        "edges": payload["edges"],
        "recorded_edge_count": len(recorded),
        "candidate_edge_count": len(candidates),
        "files": payload["files"],
        "candidates": payload["candidates"],
        "unresolved": payload["unresolved"],
        "budget": payload["budget"],
        "legend": {
            "recorded": "事件载荷或关系字段直接给出",
            "candidate": "仅文件名前缀提示，没有支持事件",
        },
    }
