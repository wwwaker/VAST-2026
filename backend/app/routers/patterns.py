"""MC2 历史模式与干预论证。

- 候选与阶段全部来自记录字段；文件名前缀只作检索提示并显式标注。
- 覆盖分母区分完整链与部分链，缺失阶段不算“拦截成功”。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import mc2_patterns

router = APIRouter(prefix="/api", tags=["patterns"])


def _require_mc2(conn, dataset: str):
    try:
        row = require_dataset(conn, dataset)
    except KeyError:
        raise HTTPException(404, f"未知数据集 {dataset}")
    if dataset != "MC2":
        raise HTTPException(400, "unsupported_dataset: 历史模式当前仅 MC2 支持")
    return row


@router.get("/patterns/file-posts")
def file_posts(
    dataset: str = Query("MC2"),
    before_us: int | None = Query(None, ge=0, description="只看该时刻之前的实例（整数微秒）"),
    limit: int = Query(20, ge=1, le=100),
):
    with get_conn() as conn:
        dataset_row = _require_mc2(conn, dataset)
        payload = mc2_patterns.file_posts(conn, dataset, before_us, limit)
    return {
        "dataset_id": dataset,
        "data_version": dataset_row["data_version"],
        "scope": "file_posts",
        "before_us": before_us,
        **payload,
        "note": "阶段存在性由事件决定；“候选”只表示文件名前缀相同，不能当作传播证据。",
    }


@router.get("/interventions")
def interventions(
    dataset: str = Query("MC2"),
    position: str = Query("relay_queue", pattern="^relay_queue$"),
):
    with get_conn() as conn:
        _require_mc2(conn, dataset)
        try:
            payload = mc2_patterns.intervention(conn, dataset, position)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    return {
        "dataset_id": dataset,
        "scope": "intervention",
        **payload,
        "constraint": "官方要求最多选择一个干预位置；这里只论证一个候选，不宣称它是唯一入口。",
    }
