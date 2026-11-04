"""基线比较。

窗口长度不同必须按「每小时速率」比较，否则长窗口永远显得更异常。
所有阈值只用来排序和提示"值得看一眼"，不产出任何结论。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..db import get_conn, require_dataset

router = APIRouter(prefix="/api/compare", tags=["compare"])

DIMENSIONS = {
    "actor": ("e.actor_id", "en.label"),
    "event_type": ("e.event_type", None),
}


def _window_stats(conn, dataset: str, start: int, end: int, column: str, label_col: str | None):
    label_join = (
        f"LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id={column}"
        if label_col
        else ""
    )
    label_select = f", {label_col} AS label" if label_col else ", NULL AS label"
    rows = conn.execute(
        f"SELECT {column} AS key, COUNT(*) AS c{label_select} FROM events e {label_join} "
        f"WHERE e.dataset_id=? AND e.time_sort_key>=? AND e.time_sort_key<=? "
        f"AND {column} IS NOT NULL GROUP BY {column}",
        (dataset, start, end),
    ).fetchall()
    counts = {r["key"]: r["c"] for r in rows}
    labels = {r["key"]: r["label"] for r in rows if r["label"]}
    total = sum(counts.values())
    return counts, labels, total


@router.get("")
def compare(
    dataset: str,
    start: int = Query(..., description="当前窗口起点，epoch 秒"),
    end: int = Query(..., description="当前窗口终点，epoch 秒"),
    baseline_start: int | None = Query(None, description="留空则自动取等长的前一个窗口"),
    baseline_end: int | None = None,
    dimension: str = Query("event_type", pattern="^(actor|event_type)$"),
    limit: int = Query(20, ge=1, le=100),
):
    if end <= start:
        raise HTTPException(400, "当前窗口的终点必须晚于起点")

    auto_baseline = baseline_start is None or baseline_end is None
    if auto_baseline:
        span = end - start
        baseline_start = start - span
        baseline_end = start
    assert baseline_start is not None and baseline_end is not None
    if baseline_end <= baseline_start:
        raise HTTPException(400, "基线窗口的终点必须晚于起点")

    column, label_col = DIMENSIONS[dimension]

    with get_conn() as conn:
        try:
            dataset_row = require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")

        ts_min, ts_max = dataset_row["ts_min"], dataset_row["ts_max"]
        win_counts, win_labels, win_total = _window_stats(conn, dataset, start, end, column, label_col)
        base_counts, base_labels, base_total = _window_stats(
            conn, dataset, baseline_start, baseline_end, column, label_col
        )

    win_hours = max(1e-6, (end - start) / 3600)
    base_hours = max(1e-6, (baseline_end - baseline_start) / 3600)

    keys = set(win_counts) | set(base_counts)
    rows = []
    for key in keys:
        w = win_counts.get(key, 0)
        b = base_counts.get(key, 0)
        rate_w = w / win_hours
        rate_b = b / base_hours
        if rate_b > 0:
            ratio = rate_w / rate_b
        else:
            # 基线为 0：只在当前窗口出现，用"新增"表示，不给无限大的比值
            ratio = None
        rows.append(
            {
                "key": key,
                "label": win_labels.get(key) or base_labels.get(key) or key,
                "window_count": w,
                "baseline_count": b,
                "window_rate": round(rate_w, 3),
                "baseline_rate": round(rate_b, 3),
                "delta": round(rate_w - rate_b, 3),
                "ratio": round(ratio, 2) if ratio is not None else None,
                "is_new": b == 0 and w > 0,
                "is_absent": w == 0 and b > 0,
            }
        )

    # 按变化绝对值排序；ratio 为 None（基线为 0）时用当前速率占位
    rows.sort(key=lambda r: abs(r["delta"]) if r["ratio"] is not None else max(r["window_rate"], 1), reverse=True)
    rows = rows[:limit]

    return {
        "dataset_id": dataset,
        "dimension": dimension,
        "window": {
            "start": start,
            "end": end,
            "hours": round(win_hours, 2),
            "events": win_total,
        },
        "baseline": {
            "start": baseline_start,
            "end": baseline_end,
            "hours": round(base_hours, 2),
            "events": base_total,
            "auto": auto_baseline,
        },
        "dataset_range": {"ts_min": ts_min, "ts_max": ts_max},
        "rows": rows,
        "metric_note": "计数已折算为每小时速率；ratio=null 表示基线窗口内该类事件为 0。",
    }
