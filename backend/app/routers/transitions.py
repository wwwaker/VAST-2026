"""MC2 转移矩阵接口。

- GET /api/transitions：矩阵、支持对数、actor 覆盖与被排除样本说明。
- GET /api/transitions/evidence：单个类型对的相邻对分页，两条事件都可回查。
两个接口都复用 filters.build_selection，并同时对源与后继两条事件施加筛选。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import event_types, transitions
from ..query import filters
from ..query.filters import FilterError, RawFilter

router = APIRouter(prefix="/api", tags=["transitions"])


def _selection(conn, dataset: str, raw: RawFilter) -> tuple:
    try:
        dataset_row = require_dataset(conn, dataset)
    except KeyError:
        raise HTTPException(404, f"未知数据集 {dataset}") from None
    if dataset != "MC2":
        raise HTTPException(400, "unsupported_dataset: 转移矩阵当前仅 MC2 支持")
    try:
        selection = filters.build_selection(raw.to_context(dataset))
    except FilterError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc
    return dataset_row, selection


def _validate_window(window_minutes: int) -> int:
    if window_minutes not in transitions.WINDOW_CHOICES:
        raise HTTPException(400, "window_minutes 只能是 5 或 30")
    return window_minutes


@router.get("/transitions")
def transition_matrix(
    dataset: str = Query("MC2"),
    window_minutes: int = Query(5, description="5 或 30 分钟子集"),
    raw: RawFilter = Depends(filters.filter_params),
):
    window_minutes = _validate_window(window_minutes)
    with get_conn() as conn:
        dataset_row, selection = _selection(conn, dataset, raw)
        matched_events = filters.count_events(conn, selection)
        payload = transitions.matrix(conn, selection, window_minutes)
    return {
        "meta": filters.build_meta(
            selection,
            scope="transition_matrix",
            data_version=dataset_row["data_version"],
            matched_events=matched_events,
        ),
        "dataset_id": dataset,
        "available": payload["totals"]["installed_pairs"] > 0,
        **payload,
        "legend": {
            "support": "满足两侧筛选且 lag 在窗口内的相邻对数",
            "actor_count": "该类型对涉及的执行者去重数",
            "low_sample": f"支持数 < {transitions.LOW_SAMPLE_THRESHOLD} 只显示具体 n，不用颜色暗示强度",
        },
    }


@router.get("/transitions/evidence")
def transition_evidence(
    dataset: str = Query("MC2"),
    window_minutes: int = Query(5),
    source_type: str = Query(..., description="源事件类型"),
    next_type: str = Query(..., description="后继事件类型"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    raw: RawFilter = Depends(filters.filter_params),
):
    window_minutes = _validate_window(window_minutes)
    known = set(event_types.TYPES.get("MC2", {}))
    if source_type not in known:
        raise HTTPException(400, f"unknown_event_type: {source_type}")
    if next_type not in known:
        raise HTTPException(400, f"unknown_event_type: {next_type}")
    with get_conn() as conn:
        dataset_row, selection = _selection(conn, dataset, raw)
        payload = transitions.evidence(
            conn, selection, window_minutes, source_type, next_type, limit, offset
        )
        matched_events = filters.count_events(conn, selection)
    return {
        "meta": filters.build_meta(
            selection,
            scope="transition_evidence",
            data_version=dataset_row["data_version"],
            matched_events=matched_events,
            truncated=payload["has_more"],
        ),
        "dataset_id": dataset,
        **payload,
        "cell": {
            "source_type": source_type,
            "next_type": next_type,
            "total": payload["total"],
        },
    }
