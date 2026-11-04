"""数据集概览与聚合查询。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..db import get_conn, require_dataset
from ..ingest.loader import parse_epoch
from ..ingest.manifest import ALL

router = APIRouter(prefix="/api", tags=["datasets"])

OTHER_TYPE = "__other__"


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
                "anchors": [
                    {
                        "key": a.key,
                        "label": a.label,
                        "time_raw": a.time_raw,
                        "timezone": a.timezone,
                        "sort_key": parse_epoch(a.time_raw),
                        "note": a.note,
                        "primary": a.primary,
                    }
                    for a in (manifest.anchor_list if manifest else [])
                ],
                "intervention": manifest.intervention if manifest else None,
            }
        )
    return out


@router.get("/datasets/{dataset_id}/overview")
def overview(
    dataset_id: str,
    granularity: str = Query("day", pattern="^(hour|day)$"),
    top_types: int = Query(6, ge=1, le=24),
    start: int | None = Query(None, description="起止为 epoch 秒"),
    end: int | None = None,
):
    with get_conn() as conn:
        try:
            dataset = require_dataset(conn, dataset_id)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset_id}")

        types = [
            {"type": r["key"], "count": r["cnt"]}
            for r in conn.execute(
                "SELECT key, cnt FROM stat_counts WHERE dataset_id=? AND kind='type' ORDER BY cnt DESC",
                (dataset_id,),
            )
        ]
        keep = {t["type"] for t in types[:top_types]}
        type_index = {t: i for i, t in enumerate([t["type"] for t in types[:top_types]] + [OTHER_TYPE])}

        where = ["dataset_id=?", "granularity=?"]
        params: list = [dataset_id, granularity]
        if start is not None:
            where.append("bucket_key>=?")
            params.append(start)
        if end is not None:
            where.append("bucket_key<=?")
            params.append(end)

        rows = conn.execute(
            "SELECT bucket_key, event_type, event_count FROM time_buckets WHERE "
            + " AND ".join(where)
            + " ORDER BY bucket_key",
            params,
        ).fetchall()

        buckets: list[int] = []
        bucket_index: dict[int, int] = {}
        merged: dict[tuple[int, int], int] = {}
        for row in rows:
            key = row["bucket_key"]
            if key not in bucket_index:
                bucket_index[key] = len(buckets)
                buckets.append(key)
            etype = row["event_type"] if row["event_type"] in keep else OTHER_TYPE
            point = (bucket_index[key], type_index[etype])
            merged[point] = merged.get(point, 0) + row["event_count"]

        points = [[b, t, n] for (b, t), n in sorted(merged.items())]

        # 直接读导入期算好的 stat_counts，避免对 18 万行事件做 GROUP BY（实测 400ms → 0.5ms）
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

        return {
            "dataset_id": dataset_id,
            "name": dataset["name"],
            "timezone_status": dataset["timezone_status"],
            "total_events": dataset["event_count"],
            "entity_count": dataset["entity_count"],
            "deliberation_count": dataset["deliberation_count"],
            "time_range": [dataset["ts_min"], dataset["ts_max"]],
            "granularity": granularity,
            "types": types,
            "series": {
                "types": [t["type"] for t in types[:top_types]] + [OTHER_TYPE],
                "buckets": buckets,
                "points": points,
            },
            "actors": actors,
        }
