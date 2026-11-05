"""基线比较（半开窗口）。

修正（对应审查文档 3.5 / 13）：
- 窗口统一为 [start_us, end_us)，边界事件只属于右侧窗口；
- 基线自动取“等长的前一窗口”，与当前窗口不相交；
- 展示有效观察时长、覆盖率与样本量，数据范围之外不按真实零活动参与速率计算；
- 当前窗口与基线继承同一组非时间筛选（actor / participant / 类别 / 关键词）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import event_types
from ..ingest.loader import parse_epoch_us
from ..query import filters
from ..query.filters import EventSelection, FilterError, RawFilter

router = APIRouter(prefix="/api/compare", tags=["compare"])

DIMENSIONS = {
    "actor": ("e.actor_id", True),
    "event_type": ("e.event_type", False),
}

UNKNOWN_KEY = "__unknown__"
SMALL_SAMPLE = 5


def _group_counts(conn, selection: EventSelection, column: str, with_label: bool):
    if selection.zero:
        return {}, {}
    label_select = ", en.label AS label" if with_label else ", NULL AS label"
    label_join = (
        "LEFT JOIN entities en ON en.dataset_id = e.dataset_id AND en.entity_id = e.actor_id"
        if with_label
        else ""
    )
    rows = conn.execute(
        f"SELECT {column} AS key{label_select}, COUNT(*) AS c FROM events e {label_join} "
        "WHERE " + selection.where_sql + " GROUP BY " + column,
        selection.params,
    ).fetchall()
    counts: dict[str, int] = {}
    labels: dict[str, str] = {}
    for row in rows:
        key = row["key"] if row["key"] is not None else UNKNOWN_KEY
        counts[key] = int(row["c"])
        if row["label"]:
            labels[key] = row["label"]
    return counts, labels


def _rate(count: int, duration_us: int | None) -> float | None:
    if not duration_us or duration_us <= 0:
        return None
    return count / (duration_us / filters.HOUR_US)


def _observed_buckets(conn, selection: EventSelection) -> int:
    """有记录出现的小时桶数；用于区分“没有活动”和“没有观测”。"""
    if selection.zero:
        return 0
    row = conn.execute(
        "SELECT COUNT(DISTINCT (e.time_sort_us / :f_hour) * :f_hour) FROM events e WHERE "
        + selection.where_sql,
        {**selection.params, "f_hour": filters.HOUR_US},
    ).fetchone()
    return int(row[0])


def _window_payload(selection: EventSelection, coverage: dict, total: int) -> dict:
    in_range = coverage.get("in_range_duration_us")
    return {
        "start_us": selection.start_us,
        "end_us": selection.end_us,
        "events": total,
        "requested_duration_us": coverage.get("requested_duration_us"),
        "in_range_duration_us": in_range,
        "coverage_ratio": coverage.get("coverage_ratio"),
        "coverage_status": coverage.get("coverage_status"),
        "observed_bucket_count": coverage.get("observed_bucket_count"),
    }


@router.get("")
def compare(
    dataset: str,
    raw: RawFilter = Depends(filters.filter_params),
    baseline_start_us: int | None = None,
    baseline_end_us: int | None = None,
    dimension: str = Query("event_type", pattern="^(actor|event_type)$"),
    limit: int = Query(20, ge=1, le=100),
):
    start, end = raw.start_us, raw.end_us
    if start is None or end is None:
        raise HTTPException(400, "比较需要当前窗口：请同时提供 start_us 与 end_us")
    if end <= start:
        raise HTTPException(400, "当前窗口的终点必须晚于起点（半开区间 [start, end)）")

    auto_baseline = baseline_start_us is None or baseline_end_us is None
    if auto_baseline:
        span = end - start
        baseline_start_us = start - span
        baseline_end_us = start
    assert baseline_start_us is not None and baseline_end_us is not None
    if baseline_end_us <= baseline_start_us:
        raise HTTPException(400, "基线窗口的终点必须晚于起点")

    column, with_label = DIMENSIONS[dimension]

    with get_conn() as conn:
        try:
            dataset_row = require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        try:
            base_ctx = raw.to_context(dataset)
            window_sel = filters.build_selection(
                base_ctx.model_copy(update={"start_us": start, "end_us": end})
            )
            baseline_sel = filters.build_selection(
                base_ctx.model_copy(update={"start_us": baseline_start_us, "end_us": baseline_end_us})
            )
        except FilterError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

        win_counts, win_labels = _group_counts(conn, window_sel, column, with_label)
        base_counts, base_labels = _group_counts(conn, baseline_sel, column, with_label)
        win_buckets = _observed_buckets(conn, window_sel)
        base_buckets = _observed_buckets(conn, baseline_sel)

    data_start = parse_epoch_us(dataset_row["ts_min"]) if dataset_row["ts_min"] else None
    data_end = parse_epoch_us(dataset_row["ts_max"]) if dataset_row["ts_max"] else None

    win_cov = filters.coverage(window_sel.start_us, window_sel.end_us, data_start, data_end, win_buckets)
    base_cov = filters.coverage(
        baseline_sel.start_us, baseline_sel.end_us, data_start, data_end, base_buckets
    )

    win_total = sum(win_counts.values())
    base_total = sum(base_counts.values())
    win_rate = _rate(win_total, win_cov.get("in_range_duration_us"))
    base_rate = _rate(base_total, base_cov.get("in_range_duration_us"))

    keys = set(win_counts) | set(base_counts)
    rows = []
    for key in keys:
        w = win_counts.get(key, 0)
        b = base_counts.get(key, 0)
        rate_w = _rate(w, win_cov.get("in_range_duration_us"))
        rate_b = _rate(b, base_cov.get("in_range_duration_us"))
        ratio = None
        if rate_w is not None and rate_b is not None and rate_b > 0:
            ratio = round(rate_w / rate_b, 2)
        delta = round(rate_w - rate_b, 3) if rate_w is not None and rate_b is not None else None

        if dimension == "actor":
            label = (
                "执行者未知（源记录未提供）"
                if key == UNKNOWN_KEY
                else (win_labels.get(key) or base_labels.get(key) or key)
            )
        else:
            definition = event_types.type_def(dataset, key)
            label = definition.display_label if definition else key

        rows.append(
            {
                "key": key,
                "label": label,
                "window_count": w,
                "baseline_count": b,
                "window_share": round(w / win_total, 4) if win_total else 0.0,
                "baseline_share": round(b / base_total, 4) if base_total else 0.0,
                "window_rate": round(rate_w, 3) if rate_w is not None else None,
                "baseline_rate": round(rate_b, 3) if rate_b is not None else None,
                "delta": delta,
                "ratio": ratio,
                "is_new": b == 0 and w > 0,
                "is_absent": w == 0 and b > 0,
                "small_sample": (w + b) < SMALL_SAMPLE,
                "evidence_filter": {
                    "start_us": window_sel.start_us,
                    "end_us": window_sel.end_us,
                    "dimension": dimension,
                    "key": key,
                },
            }
        )

    rows.sort(
        key=lambda r: (
            abs(r["delta"]) if r["delta"] is not None else (r["window_rate"] or 0),
            r["window_count"] + r["baseline_count"],
        ),
        reverse=True,
    )
    rows = rows[:limit]

    overlap = max(0, min(end, baseline_end_us) - max(start, baseline_start_us)) if not auto_baseline else 0

    return {
        "meta": filters.build_meta(
            window_sel,
            scope="comparison",
            data_version=dataset_row["data_version"],
            matched_events=win_total,
        ),
        "dataset_id": dataset,
        "dimension": dimension,
        "window": _window_payload(window_sel, win_cov, win_total),
        "baseline": {**_window_payload(baseline_sel, base_cov, base_total), "auto": auto_baseline},
        "dataset_range": {
            "start_us": data_start,
            "end_us": data_end,
            "ts_min": dataset_row["ts_min"],
            "ts_max": dataset_row["ts_max"],
        },
        "window_total_rate": round(win_rate, 3) if win_rate is not None else None,
        "baseline_total_rate": round(base_rate, 3) if base_rate is not None else None,
        "overlap_us": overlap,
        "small_sample_threshold": SMALL_SAMPLE,
        "rows": rows,
        "metric_note": (
            "速率按窗口与数据范围的实际交集计算；覆盖不足时 rate 为 null，不把数据缺口当成零活动。"
            "ratio=null 表示基线窗口内该主体/类型为 0。"
        ),
    }
