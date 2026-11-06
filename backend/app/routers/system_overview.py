"""MC2 系统背景地图：类型级聚合 + 静态组织边 + 目标链高亮。

背景聚合需要扫描全量参与者与关系（首屏约 0.8 s），因此按数据库文件状态做进程内缓存：
库在运行期不会被改写（导入需要停服替换），命中后同一份结果可直接复用。
展开单个类型走独立接口，不重复计算整张地图。
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..config import DB_PATH
from ..db import get_conn, require_dataset
from ..domain import system_map
from ..query import filters

router = APIRouter(prefix="/api", tags=["system-overview"])

_CACHE: dict[tuple, dict[str, Any]] = {}
_CACHE_MAX = 16


def _db_stamp() -> tuple[int, int]:
    try:
        stat = os.stat(DB_PATH)
    except OSError:
        return (0, 0)
    return (stat.st_mtime_ns, stat.st_size)


def clear_cache() -> None:
    _CACHE.clear()


def _require_mc2(conn, dataset: str):
    try:
        row = require_dataset(conn, dataset)
    except KeyError:
        raise HTTPException(404, f"未知数据集 {dataset}")
    if dataset != "MC2":
        raise HTTPException(400, "unsupported_dataset: 系统背景地图仅 MC2 支持")
    return row


@router.get("/system-overview")
def system_overview(
    dataset: str = Query("MC2"),
    trace_root_id: str | None = Query(None, description="用该事件的参与者做目标链高亮"),
):
    with get_conn() as conn:
        dataset_row = _require_mc2(conn, dataset)
        key = (_db_stamp(), dataset, trace_root_id)
        cached = _CACHE.get(key)
        if cached is not None:
            payload = dict(cached)
            hit = True
        else:
            payload = system_map.overview(conn, dataset, None, 0, trace_root_id)
            if len(_CACHE) >= _CACHE_MAX:
                _CACHE.pop(next(iter(_CACHE)))
            _CACHE[key] = payload
            hit = False

    return {
        "meta": {
            "contract_version": filters.CONTRACT_VERSION,
            "dataset_id": dataset,
            "data_version": dataset_row["data_version"],
            "scope": "system_overview",
            "cache_hit": hit,
            "note": "背景视图不做时间筛选；交互边覆盖全量事件，组织边为静态结构。",
        },
        "dataset_id": dataset,
        **payload,
    }


@router.get("/system-overview/members")
def system_overview_members(
    dataset: str = Query("MC2"),
    entity_type: str = Query(..., description="例如 agent / person / file_path"),
    limit: int = Query(system_map.MAX_MEMBERS, ge=1, le=system_map.MAX_MEMBERS),
):
    with get_conn() as conn:
        _require_mc2(conn, dataset)
        known = conn.execute(
            "SELECT 1 FROM entities WHERE dataset_id=? AND entity_type=? LIMIT 1",
            (dataset, entity_type),
        ).fetchone()
        if known is None:
            raise HTTPException(404, f"未知实体类型 {entity_type}")
        payload = system_map.expand_group(conn, dataset, entity_type, limit)
    return {"dataset_id": dataset, **payload}
