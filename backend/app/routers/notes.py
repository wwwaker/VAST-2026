"""调查笔记的读写接口。

笔记是人工结论，与数据标签、规则线索分开存放：
它不参与事件检索，也不随数据重建消失。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import notes_store
from ..db import get_conn, require_dataset

router = APIRouter(prefix="/api/notes", tags=["notes"])


class NoteCreate(BaseModel):
    dataset_id: str
    body: str = Field(..., min_length=1, max_length=4000)
    event_id: str | None = None
    event_time: int | None = None
    filter_summary: str | None = Field(None, max_length=1000)


@router.get("")
def list_notes(dataset: str, limit: int = Query(200, ge=1, le=1000)):
    with get_conn() as conn:
        try:
            require_dataset(conn, dataset)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {dataset}")
    return {"dataset_id": dataset, "items": notes_store.list_notes(dataset, limit)}


@router.post("", status_code=201)
def create_note(payload: NoteCreate):
    with get_conn() as conn:
        try:
            require_dataset(conn, payload.dataset_id)
        except KeyError:
            raise HTTPException(404, f"未知数据集 {payload.dataset_id}")

    body = payload.body.strip()
    if not body:
        raise HTTPException(400, "笔记内容不能为空")

    return notes_store.create_note(
        dataset_id=payload.dataset_id,
        body=body,
        event_id=payload.event_id,
        event_time=payload.event_time,
        filter_summary=payload.filter_summary,
    )


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: int):
    if not notes_store.delete_note(note_id):
        raise HTTPException(404, f"未知笔记 {note_id}")
    return None
