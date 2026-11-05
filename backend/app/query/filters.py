"""统一筛选上下文（contract v2）。

规则：
- 所有公开时间参数都是整数微秒，窗口统一为半开区间 [start_us, end_us)。
- 回放游标 cursor_us 的语义是“显示时间不晚于此游标的事件”，因此有效截止为
  min(end_us, cursor_us + 1)，游标恰好落在一条事件时该事件可见。
- 列表、计数、聚合、图、比较全部通过本模块生成同一个 WHERE，不在各 router 里各写一套。
- categories 由服务端类型字典解析为具体类型；解析为空时必须返回零条，不能退化为“不限”。
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

from fastapi import Query
from pydantic import BaseModel, Field

from ..domain import event_types

CONTRACT_VERSION = 2

HOUR_US = 3_600_000_000
MINUTE_US = 60_000_000
DAY_US = 86_400_000_000


class FilterError(Exception):
    """可直接映射为 HTTP 400 的筛选错误。"""

    def __init__(self, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


class FilterContext(BaseModel):
    dataset: str
    start_us: int | None = None
    end_us: int | None = None
    categories: list[int] = Field(default_factory=list)
    event_types: list[str] = Field(default_factory=list)
    actor_id: str | None = None
    participant_id: str | None = None
    run_id: str | None = None
    keyword: str = ""
    cursor_us: int | None = None
    masking: bool = False

    def applied(self) -> dict:
        return {
            "start_us": self.start_us,
            "end_us": self.end_us,
            "categories": sorted(self.categories),
            "event_types": sorted(self.event_types),
            "actor_id": self.actor_id,
            "participant_id": self.participant_id,
            "run_id": self.run_id,
            "keyword": self.keyword,
            "cursor_us": self.cursor_us,
            "masking": self.masking,
        }

    def hash_payload(self) -> dict:
        """游标校验用：不包含 cursor 本身（翻页不改变筛选），包含 masking（改变结果集）。"""
        payload = self.applied()
        payload.pop("cursor_us", None)
        return payload


@dataclass
class RawFilter:
    start_us: int | None = None
    end_us: int | None = None
    categories: str | None = None
    types: str | None = None
    actor: str | None = None
    participant: str | None = None
    run_id: str | None = None
    keyword: str | None = None
    cursor_us: int | None = None
    masking: bool = False

    def to_context(self, dataset: str) -> FilterContext:
        return FilterContext(
            dataset=dataset,
            start_us=self.start_us,
            end_us=self.end_us,
            categories=_split_ints(self.categories),
            event_types=_split_strs(self.types),
            actor_id=self.actor or None,
            participant_id=self.participant or None,
            run_id=self.run_id or None,
            keyword=(self.keyword or "").strip(),
            cursor_us=self.cursor_us,
            masking=bool(self.masking),
        )


def _split_ints(value: str | None) -> list[int]:
    if not value:
        return []
    out: list[int] = []
    for token in value.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            out.append(int(token))
        except ValueError as exc:
            raise FilterError(f"非法的类别 id：{token}") from exc
    return sorted(set(out))


def _split_strs(value: str | None) -> list[str]:
    if not value:
        return []
    return sorted({token.strip() for token in value.split(",") if token.strip()})


def filter_params(
    start_us: int | None = Query(None, ge=0, description="窗口起点（含），整数微秒"),
    end_us: int | None = Query(None, ge=0, description="窗口终点（不含），整数微秒"),
    categories: str | None = Query(None, description="逗号分隔的类别 id（1..8）"),
    types: str | None = Query(None, description="逗号分隔的事件类型"),
    actor: str | None = Query(None, description="执行者必须相等"),
    participant: str | None = Query(None, description="任一参与者命中"),
    run_id: str | None = Query(None, description="仅 CUSTOM 支持"),
    q: str | None = Query(None, description="关键词，普通文本检索"),
    cursor_us: int | None = Query(None, ge=0, description="回放截止时间（微秒）"),
    masking: bool = Query(False, description="是否按游标遮蔽未来记录"),
) -> RawFilter:
    return RawFilter(
        start_us=start_us,
        end_us=end_us,
        categories=categories,
        types=types,
        actor=actor,
        participant=participant,
        run_id=run_id,
        keyword=q,
        cursor_us=cursor_us,
        masking=masking,
    )


@dataclass(frozen=True)
class EventSelection:
    dataset: str
    where_sql: str
    params: dict[str, Any]
    start_us: int | None
    end_us: int | None
    filter_hash: str
    zero: bool
    context: FilterContext

    @property
    def effective_time(self) -> dict:
        return {"start_us": self.start_us, "end_us": self.end_us}

    def extend(self, extra_sql: str, extra_params: dict[str, Any], salt: str) -> "EventSelection":
        """在同一个选择器上追加条件（例如图的一条边）。游标哈希会包含 salt。"""
        where = self.where_sql if self.zero else f"({self.where_sql}) AND ({extra_sql})"
        params = {**self.params, **extra_params}
        digest = hashlib.sha1(
            json.dumps(
                {"base": self.filter_hash, "salt": salt},
                sort_keys=True,
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()
        return EventSelection(
            dataset=self.dataset,
            where_sql=where,
            params=params,
            start_us=self.start_us,
            end_us=self.end_us,
            filter_hash=digest,
            zero=self.zero,
            context=self.context,
        )


def _effective_range(ctx: FilterContext) -> tuple[int | None, int | None]:
    start = ctx.start_us
    end = ctx.end_us
    if ctx.masking and ctx.cursor_us is not None:
        cap = ctx.cursor_us + 1
        end = cap if end is None else min(end, cap)
    return start, end


def build_selection(ctx: FilterContext) -> EventSelection:
    if ctx.dataset not in event_types.TYPES:
        raise FilterError(f"未知数据集 {ctx.dataset}", 404)
    if ctx.start_us is not None and ctx.end_us is not None and ctx.start_us >= ctx.end_us:
        raise FilterError("时间窗无效：start_us 必须小于 end_us（半开区间 [start, end)）")
    if ctx.run_id and ctx.dataset != "CUSTOM":
        raise FilterError("unsupported_filter: run_id 仅 CUSTOM 数据集支持")

    start, end = _effective_range(ctx)
    zero = start is not None and end is not None and start >= end

    where = ["e.dataset_id = :f_dataset"]
    params: dict[str, Any] = {"f_dataset": ctx.dataset}

    if start is not None:
        where.append("e.time_sort_us >= :f_start")
        params["f_start"] = start
    if end is not None:
        where.append("e.time_sort_us < :f_end")
        params["f_end"] = end

    type_set: set[str] | None = None
    if ctx.categories:
        type_set = event_types.types_in_categories(ctx.dataset, ctx.categories)
        if not type_set:
            zero = True
    if ctx.event_types:
        explicit = set(ctx.event_types)
        type_set = explicit if type_set is None else (type_set & explicit)
        if not type_set:
            zero = True
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
            where.append("e.event_type IN (" + ",".join(placeholders) + ")")

    if ctx.actor_id:
        where.append("e.actor_id = :f_actor")
        params["f_actor"] = ctx.actor_id

    if ctx.participant_id:
        # 用 EXISTS 而不是 JOIN participants，避免一个事件命中多个角色导致重复计数
        where.append(
            "EXISTS (SELECT 1 FROM participants p "
            "WHERE p.dataset_id = e.dataset_id AND p.event_id = e.event_id "
            "AND p.entity_id = :f_participant)"
        )
        params["f_participant"] = ctx.participant_id

    if ctx.run_id:
        where.append("e.run_id = :f_run")
        params["f_run"] = ctx.run_id

    if ctx.keyword:
        where.append(
            "EXISTS (SELECT 1 FROM event_fts f "
            "WHERE f.dataset_id = e.dataset_id AND f.event_id = e.event_id "
            "AND f.rowid IN (SELECT rowid FROM event_fts_idx WHERE event_fts_idx MATCH :f_q))"
        )
        params["f_q"] = fts_match_query(ctx.keyword)

    where_sql = "1 = 0" if zero else " AND ".join(where)
    digest = hashlib.sha1(
        json.dumps(ctx.hash_payload(), sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()

    return EventSelection(
        dataset=ctx.dataset,
        where_sql=where_sql,
        params=params,
        start_us=start,
        end_us=end,
        filter_hash=digest,
        zero=zero,
        context=ctx,
    )


def fts_match_query(keyword: str) -> str:
    """把普通文本转成 FTS5 查询：逐词加引号，内部引号加倍，默认 AND 语义。"""
    terms = [term for term in re.split(r"\s+", keyword.strip()) if term]
    if not terms:
        return '""'
    return " AND ".join('"' + term.replace('"', '""') + '"' for term in terms)


# ---------------------------------------------------------------- 游标


def _b64encode(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(token: str) -> dict:
    padding = "=" * (-len(token) % 4)
    try:
        raw = base64.urlsafe_b64decode(token + padding)
        payload = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise FilterError("cursor 格式无效") from exc
    if not isinstance(payload, dict) or payload.get("v") != 2:
        raise FilterError("cursor 版本不匹配，请从第一页重新加载")
    return payload


def encode_cursor(selection: EventSelection, time_us: int, event_id: str, direction: str) -> str:
    return _b64encode(
        {
            "v": 2,
            "t_us": int(time_us),
            "event_id": event_id,
            "direction": direction,
            "filter_hash": selection.filter_hash,
        }
    )


def decode_cursor(selection: EventSelection, token: str, direction: str) -> tuple[int, str]:
    payload = _b64decode(token)
    if payload.get("filter_hash") != selection.filter_hash:
        raise FilterError("cursor_filter_mismatch: 筛选条件已变化，请从第一页重新加载")
    if payload.get("direction") != direction:
        raise FilterError("cursor_direction_mismatch: 排序方向已变化，请从第一页重新加载")
    try:
        return int(payload["t_us"]), str(payload["event_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise FilterError("cursor 缺少位置信息") from exc


# ---------------------------------------------------------------- 分页与计数


SUMMARY_COLUMNS = (
    "e.event_id, e.timestamp_raw, e.timestamp_normalized, e.time_sort_us, e.timezone_status, "
    "e.event_type, e.actor_id, e.actor_rule, e.details_json, e.has_deliberation, "
    "e.source_missing_id, e.run_id, e.version, e.document_id, e.channel_id, "
    "en.label AS actor_label"
)


def count_events(conn, selection: EventSelection) -> int:
    if selection.zero:
        return 0
    row = conn.execute(
        "SELECT COUNT(*) FROM events e WHERE " + selection.where_sql,
        selection.params,
    ).fetchone()
    return int(row[0])


def page_events(
    conn,
    selection: EventSelection,
    limit: int,
    cursor: str | None,
    direction: str,
) -> tuple[list, str | None]:
    """按 (time_sort_us, event_id) 稳定分页；返回行与下一页游标。"""
    if selection.zero:
        return [], None
    where = selection.where_sql
    params = dict(selection.params)
    if cursor:
        cursor_us, cursor_id = decode_cursor(selection, cursor, direction)
        op = "<" if direction == "desc" else ">"
        where = f"({where}) AND (e.time_sort_us, e.event_id) {op} (:c_us, :c_id)"
        params["c_us"] = cursor_us
        params["c_id"] = cursor_id

    order = "DESC" if direction == "desc" else "ASC"
    rows = conn.execute(
        "SELECT " + SUMMARY_COLUMNS + " FROM events e "
        "LEFT JOIN entities en ON en.dataset_id = e.dataset_id AND en.entity_id = e.actor_id "
        "WHERE " + where + f" ORDER BY e.time_sort_us {order}, e.event_id {order} LIMIT :page_limit",
        {**params, "page_limit": limit + 1},
    ).fetchall()

    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        next_cursor = encode_cursor(selection, last["time_sort_us"], last["event_id"], direction)
    return rows, next_cursor


# ---------------------------------------------------------------- 响应元信息


def build_meta(
    selection: EventSelection,
    scope: str,
    data_version: str,
    matched_events: int,
    truncated: bool = False,
    next_cursor: str | None = None,
) -> dict:
    return {
        "contract_version": CONTRACT_VERSION,
        "dataset_id": selection.dataset,
        "data_version": data_version,
        "scope": scope,
        "applied_filters": selection.context.applied(),
        "effective_time": selection.effective_time,
        "matched_events": matched_events,
        "truncated": truncated,
        "next_cursor": next_cursor,
    }


def coverage(
    start_us: int | None,
    end_us: int | None,
    data_start_us: int | None,
    data_end_us: int | None,
    observed_bucket_count: int,
) -> dict:
    requested = (end_us - start_us) if start_us is not None and end_us is not None else None
    if start_us is None or end_us is None or data_start_us is None or data_end_us is None:
        return {
            "requested_duration_us": requested,
            "in_range_duration_us": None,
            "observed_bucket_count": observed_bucket_count,
            "coverage_status": "unknown",
        }
    lo = max(start_us, data_start_us)
    hi = min(end_us, data_end_us)
    in_range = max(0, hi - lo)
    if requested and requested > 0:
        ratio = in_range / requested
    else:
        ratio = 0.0
    if in_range <= 0:
        status = "before_data"
    elif ratio < 0.999:
        status = "partial"
    else:
        status = "full"
    return {
        "requested_duration_us": requested,
        "in_range_duration_us": in_range,
        "coverage_ratio": round(ratio, 4),
        "observed_bucket_count": observed_bucket_count,
        "coverage_status": status,
    }
