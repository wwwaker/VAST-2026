"""数据集元信息、能力清单与概览聚合。

概览同时返回：
- global_context：忽略局部时间窗与非时间筛选的全库背景，但仍服从回放游标；
- filtered：当前筛选下的前景。
类别聚合发生在字典映射之后，不再先取 Top N 再分类，避免“公开发布”被并入“其他”。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import event_types
from ..ingest.loader import parse_epoch_us
from ..ingest.manifest import ALL
from ..query import filters
from ..query.filters import EventSelection, FilterError, RawFilter

router = APIRouter(prefix="/api", tags=["datasets"])

GRANULARITY_US = {"hour": filters.HOUR_US, "day": filters.DAY_US}


@router.get("/datasets")
def list_datasets():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM datasets ORDER BY dataset_id").fetchall()

    out = []
    for row in rows:
        manifest = ALL.get(row["dataset_id"])
        out.append(
            {
                "dataset_id": row["dataset_id"],
                "name": row["name"],
                "question": row["question"],
                "timezone_status": row["timezone_status"],
                "event_count": row["event_count"],
                "entity_count": row["entity_count"],
                "deliberation_count": row["deliberation_count"],
                "ts_min": row["ts_min"],
                "ts_max": row["ts_max"],
                "start_us": parse_epoch_us(row["ts_min"]) if row["ts_min"] else None,
                "end_us": parse_epoch_us(row["ts_max"]) if row["ts_max"] else None,
                "data_version": row["data_version"],
                "schema_version": row["schema_version"],
                "anchors": [
                    {
                        "key": a.key,
                        "label": a.label,
                        "time_raw": a.time_raw,
                        "timezone": a.timezone,
                        "time_us": parse_epoch_us(a.time_raw),
                        "note": a.note,
                        "primary": a.primary,
                    }
                    for a in (manifest.anchor_list if manifest else [])
                ],
                "intervention": manifest.intervention if manifest else None,
            }
        )
    return out


@router.get("/datasets/{dataset_id}/capabilities")
def capabilities(dataset_id: str):
    with get_conn() as conn:
        try:
            dataset = require_dataset(conn, dataset_id)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset_id}")

        counts = {
            r["key"]: r["cnt"]
            for r in conn.execute(
                "SELECT key, cnt FROM stat_counts WHERE dataset_id=? AND kind='type'", (dataset_id,)
            )
        }

    payload = event_types.capabilities(dataset_id)
    unknown = event_types.unknown_types(dataset_id, list(counts))
    types = [
        {**item, "count": counts.get(item["type"], 0)} for item in payload["types"]
    ]
    return {
        "contract_version": filters.CONTRACT_VERSION,
        "dataset_id": dataset_id,
        "name": dataset["name"],
        "timezone_status": dataset["timezone_status"],
        "data_version": dataset["data_version"],
        "schema_version": dataset["schema_version"],
        "event_count": dataset["event_count"],
        "entity_count": dataset["entity_count"],
        "start_us": parse_epoch_us(dataset["ts_min"]) if dataset["ts_min"] else None,
        "end_us": parse_epoch_us(dataset["ts_max"]) if dataset["ts_max"] else None,
        "categories": payload["categories"],
        "types": types,
        "unknown_type_count": sum(counts.get(name, 0) for name in unknown),
        "unknown_types": unknown,
        "supports": {
            "run_id": dataset_id == "CUSTOM",
            "channel": dataset_id == "MC1",
            "participant": True,
            "masking": True,
            "compare": dataset_id != "CUSTOM",
            "run_compare": dataset_id == "CUSTOM",
        },
        "artifact_status": "not_configured",
    }


def _series(conn, selection: EventSelection, div_us: int) -> dict:
    """按真实时间桶聚合到语义类别；桶起点是微秒时间戳，缺失桶不补零。"""
    if selection.zero:
        return {"buckets": [], "points": [], "matched_events": 0, "category_counts": {}}
    rows = conn.execute(
        "SELECT (e.time_sort_us / :f_div) * :f_div AS bucket_us, e.event_type, COUNT(*) AS c "
        "FROM events e WHERE " + selection.where_sql + " GROUP BY bucket_us, e.event_type "
        "ORDER BY bucket_us",
        {**selection.params, "f_div": div_us},
    ).fetchall()

    buckets: list[int] = []
    bucket_index: dict[int, int] = {}
    points: list[list[int]] = []
    category_counts: dict[int, int] = {}
    for row in rows:
        bucket = int(row["bucket_us"])
        index = bucket_index.get(bucket)
        if index is None:
            index = len(buckets)
            bucket_index[bucket] = index
            buckets.append(bucket)
        category = event_types.category_of(selection.dataset, row["event_type"]) - 1
        points.append([index, category, int(row["c"])])
        category_counts[category] = category_counts.get(category, 0) + int(row["c"])

    return {
        "buckets": buckets,
        "points": points,
        "matched_events": sum(category_counts.values()),
        "category_counts": category_counts,
    }


def _global_selection(selection: EventSelection) -> EventSelection:
    """背景概览：丢弃局部时间窗与非时间筛选，保留回放截止。"""
    ctx = selection.context.model_copy(
        update={
            "start_us": None,
            "end_us": None,
            "categories": [],
            "event_types": [],
            "actor_id": None,
            "participant_id": None,
            "run_id": None,
            "keyword": "",
        }
    )
    try:
        return filters.build_selection(ctx)
    except FilterError:
        return selection


@router.get("/datasets/{dataset_id}/overview")
def overview(
    dataset_id: str,
    raw: RawFilter = Depends(filters.filter_params),
    granularity: str = Query("day", pattern="^(hour|day)$"),
):
    div_us = GRANULARITY_US[granularity]
    with get_conn() as conn:
        try:
            dataset = require_dataset(conn, dataset_id)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset_id}")

        try:
            selection = filters.build_selection(raw.to_context(dataset_id))
        except FilterError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

        filtered = _series(conn, selection, div_us)
        global_sel = _global_selection(selection)
        if global_sel.filter_hash == selection.filter_hash:
            global_series = filtered
        else:
            global_series = _series(conn, global_sel, div_us)

        type_counts = [
            {"type": r["key"], "count": r["cnt"]}
            for r in conn.execute(
                "SELECT key, cnt FROM stat_counts WHERE dataset_id=? AND kind='type' ORDER BY cnt DESC",
                (dataset_id,),
            )
        ]

        actors = [
            {
                "entity_id": r["key"],
                "label": r["label"] or r["key"],
                "count": r["cnt"],
            }
            for r in conn.execute(
                "SELECT sc.key, sc.cnt, en.label FROM stat_counts sc "
                "LEFT JOIN entities en ON en.dataset_id=sc.dataset_id AND en.entity_id=sc.key "
                "WHERE sc.dataset_id=? AND sc.kind='actor' ORDER BY sc.cnt DESC LIMIT 50",
                (dataset_id,),
            )
        ]

    start_us = parse_epoch_us(dataset["ts_min"]) if dataset["ts_min"] else None
    end_us = parse_epoch_us(dataset["ts_max"]) if dataset["ts_max"] else None

    categories = []
    for category in event_types.CATEGORIES:
        index = category["id"] - 1
        categories.append(
            {
                **category,
                "count_global": global_series["category_counts"].get(index, 0),
                "count_filtered": filtered["category_counts"].get(index, 0),
            }
        )

    types = [
        {
            "type": item["type"],
            "display_label": item["display_label"],
            "category": item["category"],
            "is_action": item["is_action"],
            "is_receipt": item["is_receipt"],
            "count": next((t["count"] for t in type_counts if t["type"] == item["type"]), 0),
        }
        for item in event_types.capabilities(dataset_id)["types"]
    ]

    meta = filters.build_meta(
        selection,
        scope="filtered",
        data_version=dataset["data_version"],
        matched_events=filtered["matched_events"],
    )
    return {
        "meta": meta,
        "dataset_id": dataset_id,
        "name": dataset["name"],
        "timezone_status": dataset["timezone_status"],
        "granularity": granularity,
        "total_events": dataset["event_count"],
        "entity_count": dataset["entity_count"],
        "deliberation_count": dataset["deliberation_count"],
        "time_range": {
            "start_us": start_us,
            "end_us": end_us,
            "ts_min": dataset["ts_min"],
            "ts_max": dataset["ts_max"],
        },
        "categories": categories,
        "types": types,
        "filtered": {
            "series": {
                "buckets": filtered["buckets"],
                "points": filtered["points"],
            },
            "matched_events": filtered["matched_events"],
            "coverage": filters.coverage(selection.start_us, selection.end_us, start_us, end_us, len(filtered["buckets"])),
        },
        "global_context": {
            "series": {
                "buckets": global_series["buckets"],
                "points": global_series["points"],
            },
            "matched_events": global_series["matched_events"],
            "scope": "global_context",
            "coverage": filters.coverage(
                global_sel.start_us, global_sel.end_us, start_us, end_us, len(global_series["buckets"])
            ),
        },
        "actors": actors,
        "actors_scope": "global",
    }
