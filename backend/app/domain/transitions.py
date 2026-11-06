"""MC2 操作转移矩阵（M2-04 后半）。

硬性约束：
- 只有通过 manifest 哈希核验并导入 transition_pairs 的样本才参与统计。
- 源事件与后继事件必须同时满足当前 FilterContext；只约束一侧会让矩阵与列表口径不一致。
- 未实现 actor 校正前不返回 lift / 倍数；响应里只给支持对数、actor 数与明确的方法说明。
- 低样本格只给具体 n，不用颜色强度暗示异常。

性能取舍：
- 当筛选只涉及 actor / 类型 / lag（不涉及时间窗、参与者、关键词、渠道）时，
  直接在 transition_pairs 上聚合。这些条件在导入时已与源/后继事件逐条核对：
  actor_id 与两端一致、source_type/next_type 与两端事件类型一致（见 derived.load_mc2 的校验）。
- 一旦涉及事件级条件，就用 filters.build_selection 同时对两端施加同一份 WHERE。
"""

from __future__ import annotations

from typing import Any

from ..query import filters
from ..query.filters import EventSelection

WINDOW_CHOICES = {5: 300_000_000, 30: 1_800_000_000}
LOW_SAMPLE_THRESHOLD = 5

METHOD_NOTES = [
    "同执行者的相邻操作，不表示因果。",
    "未实现 actor 基线校正，因此不展示 lift、倍数或异常概率。",
    "源事件与后继事件都必须满足当前筛选条件；只满足一侧的对会被排除。",
    "并列时间（lag≤0）与缺少 actor 的对在导入阶段排除，数量见 excluded。",
]


def lag_limit(window_minutes: int) -> int:
    if window_minutes not in WINDOW_CHOICES:
        raise ValueError("window_minutes 只能是 5 或 30")
    return WINDOW_CHOICES[window_minutes]


def event_join_required(selection: EventSelection) -> bool:
    ctx = selection.context
    return bool(
        selection.start_us is not None
        or selection.end_us is not None
        or ctx.participant_id
        or ctx.keyword
        or ctx.channels
        or ctx.run_id
    )


def _pair_where(selection: EventSelection, limit_us: int) -> tuple[str, dict[str, Any]]:
    """只依赖 transition_pairs 列的条件（导入时已与两端事件核对）。"""
    ctx = selection.context
    params: dict[str, Any] = {"t_dataset": ctx.dataset, "t_lag_max": limit_us}
    where = ["t.dataset_id = :t_dataset", "t.lag_us <= :t_lag_max"]
    zero = selection.zero
    if ctx.actor_id:
        where.append("t.actor_id = :f_actor")
        params["f_actor"] = ctx.actor_id
    type_set = filters.resolve_types(ctx)
    if type_set is not None:
        if not type_set:
            zero = True
        else:
            names = sorted(type_set)
            placeholders = []
            for index, name in enumerate(names):
                key = f"f_type_{index}"
                params[key] = name
                placeholders.append(f":{key}")
            clause = ",".join(placeholders)
            where.append(f"t.source_type IN ({clause})")
            where.append(f"t.next_type IN ({clause})")
    return ("1 = 0" if zero else " AND ".join(where)), params


def _joined_where(selection: EventSelection, limit_us: int) -> tuple[str, dict[str, Any]]:
    source = filters.build_selection(selection.context, alias="s")
    following = filters.build_selection(selection.context, alias="n")
    params: dict[str, Any] = {"t_dataset": selection.context.dataset, "t_lag_max": limit_us}
    if source.zero or following.zero:
        return "1 = 0", params
    where = (
        "t.dataset_id = :t_dataset AND t.lag_us <= :t_lag_max "
        f"AND ({source.where_sql}) AND ({following.where_sql})"
    )
    # 两侧参数名相同、值相同，合并一次即可
    return where, {**params, **source.params, **following.params}


def _exclusions(conn, dataset: str) -> dict[str, int]:
    rows = conn.execute(
        "SELECT key, cnt FROM stat_counts WHERE dataset_id=? AND kind='transition_exclusion'",
        (dataset,),
    ).fetchall()
    return {row["key"]: int(row["cnt"]) for row in rows}


def matrix(conn, selection: EventSelection, window_minutes: int) -> dict:
    limit_us = lag_limit(window_minutes)
    dataset = selection.dataset
    fast = not event_join_required(selection)
    if fast:
        where, params = _pair_where(selection, limit_us)
    else:
        where, params = _joined_where(selection, limit_us)

    installed = conn.execute(
        "SELECT COUNT(*) FROM transition_pairs WHERE dataset_id=?", (dataset,)
    ).fetchone()[0]
    within_window = conn.execute(
        "SELECT COUNT(*) FROM transition_pairs WHERE dataset_id=? AND lag_us <= ?",
        (dataset, limit_us),
    ).fetchone()[0]
    actors_in_window = conn.execute(
        "SELECT COUNT(DISTINCT actor_id) FROM transition_pairs "
        "WHERE dataset_id=? AND lag_us <= ? AND actor_id IS NOT NULL",
        (dataset, limit_us),
    ).fetchone()[0]

    if where == "1 = 0":
        cells: list[dict] = []
        matched = 0
        actor_matched = 0
    else:
        from_sql = "FROM transition_pairs t WHERE " + where
        if not fast:
            from_sql = (
                "FROM transition_pairs t "
                "JOIN events s ON s.dataset_id = t.dataset_id AND s.event_id = t.source_event_id "
                "JOIN events n ON n.dataset_id = t.dataset_id AND n.event_id = t.next_event_id "
                "WHERE " + where
            )
        rows = conn.execute(
            "SELECT t.source_type, t.next_type, COUNT(*) AS support, "
            "       COUNT(DISTINCT t.actor_id) AS actor_count, "
            "       MIN(t.lag_us) AS min_lag_us, MAX(t.lag_us) AS max_lag_us "
            + from_sql
            + " GROUP BY t.source_type, t.next_type "
            "ORDER BY t.source_type, t.next_type",
            params,
        ).fetchall()
        cells = [
            {
                "source_type": row["source_type"],
                "next_type": row["next_type"],
                "support": int(row["support"]),
                "actor_count": int(row["actor_count"]),
                "low_sample": int(row["support"]) < LOW_SAMPLE_THRESHOLD,
                "min_lag_us": int(row["min_lag_us"]),
                "max_lag_us": int(row["max_lag_us"]),
            }
            for row in rows
        ]
        totals = conn.execute(
            "SELECT COUNT(*) AS pairs, COUNT(DISTINCT t.actor_id) AS actors " + from_sql,
            params,
        ).fetchone()
        matched = int(totals["pairs"])
        actor_matched = int(totals["actors"])

    types = sorted({cell["source_type"] for cell in cells} | {cell["next_type"] for cell in cells})
    return {
        "window_minutes": window_minutes,
        "lag_max_us": limit_us,
        "types": types,
        "cells": cells,
        "totals": {
            "installed_pairs": int(installed),
            "within_window_pairs": int(within_window),
            "matched_pairs": matched,
            "source_type_count": len({cell["source_type"] for cell in cells}),
            "next_type_count": len({cell["next_type"] for cell in cells}),
            "cell_count": len(cells),
        },
        "actor_coverage": {
            "actors_in_window": int(actors_in_window),
            "actors_matched": actor_matched,
            "coverage_ratio": (
                round(actor_matched / actors_in_window, 4) if actors_in_window else None
            ),
        },
        "excluded": {
            **_exclusions(conn, dataset),
            "by_filter": int(within_window) - matched,
        },
        "low_sample_threshold": LOW_SAMPLE_THRESHOLD,
        "supports_lift": False,
        "query_path": "pair_only" if fast else "joined",
        "method_notes": METHOD_NOTES,
    }


def evidence(
    conn,
    selection: EventSelection,
    window_minutes: int,
    source_type: str,
    next_type: str,
    limit: int,
    offset: int,
) -> dict:
    limit_us = lag_limit(window_minutes)
    dataset = selection.dataset
    fast = not event_join_required(selection)
    if fast:
        where, params = _pair_where(selection, limit_us)
    else:
        where, params = _joined_where(selection, limit_us)
    if where != "1 = 0":
        where = where + " AND t.source_type = :t_source_type AND t.next_type = :t_next_type"
    params.update(
        {
            "t_dataset": dataset,
            "t_lag_max": limit_us,
            "t_source_type": source_type,
            "t_next_type": next_type,
        }
    )

    if where == "1 = 0":
        total = 0
        rows = []
    else:
        if fast:
            total_from = "FROM transition_pairs t WHERE " + where
        else:
            total_from = (
                "FROM transition_pairs t "
                "JOIN events s ON s.dataset_id = t.dataset_id AND s.event_id = t.source_event_id "
                "JOIN events n ON n.dataset_id = t.dataset_id AND n.event_id = t.next_event_id "
                "WHERE " + where
            )
        total = int(conn.execute("SELECT COUNT(*) " + total_from, params).fetchone()[0])
        # 分页仍取事件行（需要时间、类型与摘要），但类型对已把候选缩到单格
        rows = conn.execute(
            "SELECT t.source_event_id, t.next_event_id, t.actor_id, t.lag_us, "
            "       t.source_type, t.next_type, "
            "       s.time_sort_us AS source_us, s.timestamp_raw AS source_raw, "
            "       s.channel_id AS source_channel, s.details_json AS source_details, "
            "       n.time_sort_us AS next_us, n.timestamp_raw AS next_raw, "
            "       n.channel_id AS next_channel, n.details_json AS next_details, "
            "       se.label AS actor_label "
            "FROM transition_pairs t "
            "JOIN events s ON s.dataset_id = t.dataset_id AND s.event_id = t.source_event_id "
            "JOIN events n ON n.dataset_id = t.dataset_id AND n.event_id = t.next_event_id "
            "LEFT JOIN entities se ON se.dataset_id = t.dataset_id AND se.entity_id = t.actor_id "
            "WHERE " + where
            + " ORDER BY s.time_sort_us, t.source_event_id, t.next_event_id "
            "LIMIT :page_limit OFFSET :page_offset",
            {**params, "page_limit": limit, "page_offset": offset},
        ).fetchall()

    from ..routers.events import _preview

    items = [
        {
            "source": {
                "event_id": row["source_event_id"],
                "time_us": int(row["source_us"]),
                "timestamp_raw": row["source_raw"],
                "event_type": row["source_type"],
                "actor_id": row["actor_id"],
                "actor_label": row["actor_label"],
                "channel_id": row["source_channel"],
                "preview": _preview(row["source_details"]),
            },
            "next": {
                "event_id": row["next_event_id"],
                "time_us": int(row["next_us"]),
                "timestamp_raw": row["next_raw"],
                "event_type": row["next_type"],
                "actor_id": row["actor_id"],
                "actor_label": row["actor_label"],
                "channel_id": row["next_channel"],
                "preview": _preview(row["next_details"]),
            },
            "lag_us": int(row["lag_us"]),
            "actor_id": row["actor_id"],
            "provenanceKind": "derived",
            "ruleId": "transition_pairs.adjacent_same_actor",
        }
        for row in rows
    ]
    return {
        "source_type": source_type,
        "next_type": next_type,
        "window_minutes": window_minutes,
        "lag_max_us": limit_us,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(items) < total,
        "items": items,
        "query_path": "pair_only" if fast else "joined",
        "note": "同执行者的相邻操作，不表示因果；两条事件都可回到原始记录。",
    }
