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

router = APIRouter(prefix="/api", tags=["mc1"])


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
