"""结构化结论（findings）与多证据引用。

约束：
- 一条结论只属于一个案例，因此只使用该案例数据集的证据，不跨数据集混用；
- 事件证据必须当前可解析，缺失时返回 400 并列出 ID，不写入半条结论；
- source_hash 由服务端按主库内容计算，作为“结论基于哪一版证据”的凭据。
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import case_store
from ..db import get_conn
from .cases import resolve_case

router = APIRouter(prefix="/api/findings", tags=["findings"])


class EvidenceIn(BaseModel):
    reference_id: str = Field(..., min_length=1, max_length=200)
    role: Literal["support", "counter", "uncertain"] = "support"
    reference_kind: Literal["event"] = "event"
    excerpt: str | None = Field(None, max_length=500)
    field_pointer: str | None = Field(None, max_length=200)


class FindingCreate(BaseModel):
    case_id: str
    claim: str = Field(..., min_length=1, max_length=500)
    status: Literal["hypothesis", "supported", "inconclusive"] = "hypothesis"
    explanation: str = Field(..., min_length=1, max_length=4000)
    limitations: str | None = Field(None, max_length=2000)
    evidence: list[EvidenceIn] = Field(default_factory=list)


@router.post("", status_code=201)
def create_finding(payload: FindingCreate):
    with get_conn() as conn:
        dataset_id, _user, _preset = resolve_case(conn, payload.case_id)

        rows = {}
        missing: list[str] = []
        for item in payload.evidence:
            row = conn.execute(
                "SELECT event_id, timestamp_raw, details_json FROM events "
                "WHERE dataset_id=? AND event_id=?",
                (dataset_id, item.reference_id),
            ).fetchone()
            if row is None:
                missing.append(item.reference_id)
            else:
                rows[item.reference_id] = row
        if missing:
            raise HTTPException(400, f"证据事件在当前主库中不存在：{', '.join(missing)}")

        evidence = [
            {
                "dataset_id": dataset_id,
                "reference_kind": item.reference_kind,
                "reference_id": item.reference_id,
                "role": item.role,
                "field_pointer": item.field_pointer,
                "excerpt": item.excerpt,
                "source_hash": case_store.evidence_hash(
                    dataset_id,
                    item.reference_id,
                    rows[item.reference_id]["timestamp_raw"],
                    rows[item.reference_id]["details_json"],
                ),
            }
            for item in payload.evidence
        ]

        claim = payload.claim.strip()
        explanation = payload.explanation.strip()
        if not claim or not explanation:
            raise HTTPException(400, "主张与解释都不能为空")

        return case_store.create_finding(
            case_id=payload.case_id,
            claim=claim,
            status=payload.status,
            explanation=explanation,
            limitations=(payload.limitations or "").strip() or None,
            evidence=evidence,
        )


@router.get("")
def list_findings(case_id: str = Query(...)):
    with get_conn() as conn:
        resolve_case(conn, case_id)
    items = case_store.list_findings(case_id)
    return {
        "case_id": case_id,
        "items": items,
        "total": len(items),
        "status_counts": {
            key: sum(1 for item in items if item["status"] == key)
            for key in case_store.FINDING_STATUS
        },
    }


@router.delete("/{finding_id}", status_code=204)
def delete_finding(finding_id: str):
    if not case_store.delete_finding(finding_id):
        raise HTTPException(404, f"未知结论 {finding_id}")
    return None
