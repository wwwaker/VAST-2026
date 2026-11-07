"""案例：只读预置案例 + 用户保存的快照 + 导出。

预置案例来自 `backend/app/cases/*.json`；用户案例与结论写入独立的 notes.db，
主库 --fresh 重建不会带走它们。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from .. import case_store
from ..db import get_conn, require_dataset
from ..domain import cases as case_domain
from ..domain import export as export_domain
from ..domain import ui_snapshot

router = APIRouter(prefix="/api/cases", tags=["cases"])


class CaseCreate(BaseModel):
    dataset_id: str
    title: str = Field(..., min_length=1, max_length=200)
    snapshot: dict = Field(default_factory=dict)


def _require_dataset(conn, dataset: str):
    try:
        return require_dataset(conn, dataset)
    except KeyError:
        raise HTTPException(404, f"未知数据集 {dataset}")


def resolve_case(conn, case_id: str) -> tuple[str, dict | None, dict | None]:
    """返回 (dataset_id, 用户案例, 预置案例)，找不到抛 404。"""
    user = case_store.get_case(case_id)
    if user is not None:
        return user["dataset_id"], user, None
    dataset_row = _require_dataset(conn, "CUSTOM")
    try:
        preset = case_domain.get_case(conn, case_id, dataset_row["data_version"])
    except KeyError:
        raise HTTPException(404, f"未知案例 {case_id}")
    return "CUSTOM", None, preset


@router.get("")
def list_cases(dataset: str = Query("CUSTOM")):
    with get_conn() as conn:
        dataset_row = _require_dataset(conn, dataset)
        user_items = []
        for item in case_store.list_cases(dataset):
            stale = bool(item["data_version"] and item["data_version"] != dataset_row["data_version"])
            user_items.append(
                {
                    **item,
                    "kind": "user",
                    "status": "stale" if stale else "ok",
                    "status_label": "数据版本已变" if stale else "可用",
                }
            )
        payload = {"items": [], "total": 0, "status_counts": {}, "stale": False}
        if dataset == "CUSTOM":
            payload = case_domain.list_cases(conn, dataset_row["data_version"])
    return {
        "meta": {"scope": "cases", "read_only": False},
        "dataset_id": dataset,
        "user_items": user_items,
        **payload,
    }


@router.post("", status_code=201)
def create_case(payload: CaseCreate):
    with get_conn() as conn:
        dataset_row = _require_dataset(conn, payload.dataset_id)
        try:
            snapshot_status = ui_snapshot.validate(payload.snapshot, payload.dataset_id, conn)
        except (ui_snapshot.SnapshotError, TypeError, KeyError, RecursionError) as exc:
            raise HTTPException(422, f"invalid_ui_snapshot: {exc}") from exc
    title = payload.title.strip()
    if not title:
        raise HTTPException(400, "案例标题不能为空")
    snapshot = dict(payload.snapshot or {})
    snapshot.setdefault("contract_version", 2)
    snapshot.setdefault("dataset_id", payload.dataset_id)
    created = case_store.create_case(
        dataset_id=payload.dataset_id,
        title=title,
        snapshot=snapshot,
        data_version=dataset_row["data_version"],
    )
    return {**created, "kind": "user", "status": "ok", "status_label": "可用", "snapshot_status": snapshot_status}


@router.get("/{case_id}/export")
def export_case(case_id: str, format: str = Query("json", pattern="^(json|md)$")):
    with get_conn() as conn:
        dataset_id, _user, _preset = resolve_case(conn, case_id)
        dataset_row = _require_dataset(conn, dataset_id)
        payload = export_domain.build(conn, case_id, dataset_row["data_version"])

    filename = f"{case_id}.{format}"
    if format == "json":
        return JSONResponse(
            payload,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    return PlainTextResponse(
        export_domain.render_markdown(payload),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{case_id}")
def get_case(case_id: str):
    with get_conn() as conn:
        dataset_id, user, preset = resolve_case(conn, case_id)
        dataset_row = _require_dataset(conn, dataset_id)
        findings = case_store.list_findings(case_id)
        if user is not None:
            stale = bool(user["data_version"] and user["data_version"] != dataset_row["data_version"])
            return {
                "meta": {"scope": "case", "read_only": False},
                "kind": "user",
                "status": "stale" if stale else "ok",
                "status_label": "数据版本已变" if stale else "可用",
                "stale": stale,
                "findings": findings,
                "snapshot_status": ui_snapshot.describe(user["snapshot"], dataset_id, conn),
                **user,
            }
    return {
        "meta": {"scope": "case", "read_only": True},
        "kind": "preset",
        "findings": findings,
        **preset,
    }


@router.delete("/{case_id}", status_code=204)
def delete_case(case_id: str):
    # 预置案例只读，不允许删除
    if case_store.get_case(case_id) is None:
        raise HTTPException(400, "预置案例只读，不能删除")
    case_store.delete_case(case_id)
    return None
