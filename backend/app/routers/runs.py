"""CUSTOM 运行维度：运行列表、单次流程与配对比较。

审计结论在请求时从事件字段重算；labels 的 scenario/observed 只作为源标注并列展示。
回放遮蔽开启时，审计只能看到游标以前的证据，结果状态相应变为“截至当前尚无发布结果”。
"""

from __future__ import annotations

import json
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import custom_audit
from ..query import filters
from ..query.filters import FilterError, RawFilter
from .events import load_annotations, summarize

router = APIRouter(prefix="/api", tags=["runs"])

from ..domain.run_stages import (
    STAGES, STAGE_RULES_VERSION, stage_of as _stage_of,
    stage_payload as _stage_payload, stage_summary as _stage_summary, summarize_run,
)


def _require_custom(conn, dataset: str):
    try:
        row = require_dataset(conn, dataset)
    except KeyError:
        raise HTTPException(404, f"未知数据集 {dataset}")
    if dataset != "CUSTOM":
        raise HTTPException(400, "unsupported_filter: 运行维度仅 CUSTOM 数据集支持")
    return row


def _fetch_events(conn, selection, limit: int = 600) -> list[dict]:
    rows = conn.execute(
        "SELECT e.*, en.label AS actor_label FROM events e "
        "LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
        "WHERE " + selection.where_sql + " ORDER BY e.time_sort_us, e.event_id LIMIT :run_limit",
        {**selection.params, "run_limit": limit},
    ).fetchall()
    events = []
    for row in rows:
        item = dict(row)
        details = item.get("details_json")
        item["details"] = json.loads(details) if details else {}
        events.append(item)
    return events


def _run_payload(row) -> dict:
    metrics = json.loads(row["metrics_json"]) if row["metrics_json"] else {}
    return {
        "run_id": row["run_id"],
        "model": row["model"],
        "fixture": row["fixture"],
        "scenario": row["scenario"],
        "observed": bool(row["observed"]),
        "anomaly_type": row["anomaly_type"],
        "start_us": row["start_us"],
        "end_us": row["end_us"],
        "duration_us": (row["end_us"] - row["start_us"]) if row["start_us"] is not None and row["end_us"] is not None else None,
        "event_count": row["event_count"],
        "metrics": metrics,
    }


def _run_rows(conn, dataset: str, model: str | None, fixture: str | None, scenario: str | None):
    where = ["dataset_id=?"]
    params: list = [dataset]
    if model:
        where.append("model=?")
        params.append(model)
    if fixture:
        where.append("fixture=?")
        params.append(fixture)
    if scenario:
        where.append("scenario=?")
        params.append(scenario)
    return conn.execute(
        "SELECT * FROM runs WHERE " + " AND ".join(where) + " ORDER BY start_us",
        params,
    ).fetchall()


def _load_run_events(conn, run_ids: list[str]) -> dict[str, list[dict]]:
    if not run_ids:
        return {}
    placeholders = ",".join("?" * len(run_ids))
    rows = conn.execute(
        "SELECT e.* FROM events e WHERE e.dataset_id='CUSTOM' AND e.run_id IN ("
        + placeholders
        + ") ORDER BY e.time_sort_us, e.event_id",
        run_ids,
    ).fetchall()
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        item = dict(row)
        details = item.get("details_json")
        item["details"] = json.loads(details) if details else {}
        grouped[item["run_id"]].append(item)
    return grouped


@router.get("/runs")
def list_runs(
    dataset: str = Query("CUSTOM"),
    model: str | None = None,
    fixture: str | None = None,
    scenario: str | None = None,
    observed: bool | None = None,
    limit: int = Query(200, ge=1, le=500),
    include_stages: bool = False,
):
    with get_conn() as conn:
        dataset_row = _require_custom(conn, dataset)
        rows = _run_rows(conn, dataset, model, fixture, scenario)
        pairs = {
            row["run_id"]: row["normal_run_id"]
            for row in conn.execute("SELECT run_id, normal_run_id FROM run_pairs WHERE dataset_id=?", (dataset,))
        }
        run_ids = [row["run_id"] for row in rows]
        grouped = _load_run_events(conn, run_ids)

    items = []
    for row in rows:
        if observed is not None and bool(row["observed"]) != observed:
            continue
        events = grouped.get(row["run_id"], [])
        audit = custom_audit.audit_run(events)
        normal_id = pairs.get(row["run_id"])
        items.append(
            {
                **_run_payload(row),
                "normal_run_id": normal_id,
                "has_pair": bool(normal_id),
                "audit": audit["summary"],
                "audit_rules": [rule for rule in audit["rules"] if rule["status"] not in {"valid", "current"}],
            }
        )
        if include_stages:
            complete = len(events) == row["event_count"] and any(e["event_type"] == "run_started" for e in events) and any(e["event_type"] == "run_finished" for e in events)
            items[-1]["stage_summary"] = summarize_run(events, row["start_us"], complete=complete)
    total = len(items)
    items = items[:limit]

    return {
        "meta": {
            "contract_version": filters.CONTRACT_VERSION,
            "dataset_id": dataset,
            "data_version": dataset_row["data_version"],
            "scope": "runs",
            "applied_filters": {"model": model, "fixture": fixture, "scenario": scenario, "observed": observed},
            "matched_runs": len(items),
            "matched_runs_total": total,
            "returned_runs": len(items),
            "truncated": total > len(items),
            **({"summary_scope": "full_run", "stage_rules_version": STAGE_RULES_VERSION} if include_stages else {}),
        },
        "items": items,
        **({"stage_dictionary": [{"key": key, "label": label, "order": order} for order, (key, label) in enumerate(STAGES)]} if include_stages else {}),
    }


@router.get("/runs/{run_key}")
def run_detail(
    run_key: str,
    dataset: str = Query("CUSTOM"),
    raw: RawFilter = Depends(filters.filter_params),
):
    # 路径参数不与筛选依赖的 run_id 同名：FastAPI 不允许依赖查询参数与路径参数重名
    run_id = run_key
    with get_conn() as conn:
        dataset_row = _require_custom(conn, dataset)
        row = conn.execute(
            "SELECT * FROM runs WHERE dataset_id=? AND run_id=?", (dataset, run_id)
        ).fetchone()
        if row is None:
            raise HTTPException(404, f"未知运行 {run_id}")

        try:
            context = raw.to_context(dataset).model_copy(update={"run_id": run_id})
            selection = filters.build_selection(context)
            matched = filters.count_events(conn, selection)
            events = _fetch_events(conn, selection)
        except FilterError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

        pair = conn.execute(
            "SELECT normal_run_id, model, fixture FROM run_pairs WHERE dataset_id=? AND run_id=?",
            (dataset, run_id),
        ).fetchone()
        links = conn.execute(
            "SELECT source_event_id, target_event_id, relation, derivation FROM event_links "
            "WHERE dataset_id=? AND source_event_id IN (SELECT event_id FROM events WHERE dataset_id=? AND run_id=?)",
            (dataset, dataset, run_id),
        ).fetchall()
        annotations = load_annotations(conn, dataset, [event["event_id"] for event in events])

    audit = custom_audit.audit_run(events)

    calls = []
    started = {event["event_id"]: event for event in events if event["event_type"] == "agent_call_started"}
    for event in events:
        if event["event_type"] != "agent_call_finished":
            continue
        start_event = started.get(event.get("parent_event_id"))
        details = event["details"] or {}
        calls.append(
            {
                "role": custom_audit.role_of(event.get("actor_id")),
                "started_event_id": start_event["event_id"] if start_event else None,
                "finished_event_id": event["event_id"],
                "start_us": start_event["time_sort_us"] if start_event else None,
                "end_us": event["time_sort_us"],
                "duration_ms": details.get("duration_ms"),
                "status": details.get("status"),
                "unpaired": start_event is None,
            }
        )

    items = [
        summarize(
            {
                **event,
                "timestamp_normalized": event["timestamp_normalized"],
                "time_sort_us": event["time_sort_us"],
                "actor_label": event.get("actor_label"),
            },
            dataset,
            annotations.get(event["event_id"], []),
        )
        for event in events
    ]

    return {
        "meta": filters.build_meta(
            selection,
            scope="single_run",
            data_version=dataset_row["data_version"],
            matched_events=matched,
        ),
        "run": _run_payload(row),
        "pair": (
            {"normal_run_id": pair["normal_run_id"], "model": pair["model"], "fixture": pair["fixture"]}
            if pair
            else None
        ),
        "events": items,
        "links": [dict(link) for link in links],
        "calls": calls,
        "audit": audit,
        "truncated": matched > len(events),
    }




def _metrics(events: list[dict], audit: dict) -> dict:
    calls = [event for event in events if event["event_type"] == "agent_call_finished"]
    call_ms = sum((event["details"] or {}).get("duration_ms") or 0 for event in calls)
    return {
        "events": len(events),
        "calls": len(calls),
        "call_duration_ms": call_ms,
        "handoffs": sum(1 for event in events if event["event_type"] == "task_handoff"),
        "review_present": any(event["event_type"] == "review_decision" for event in events),
        "attempts": audit["summary"]["attempt_count"],
        "read_version": next(
            (
                (event["details"] or {}).get("selected_version")
                for event in events
                if event["event_type"] == "workflow_route"
            ),
            None,
        ),
        "published_version": next(
            (event.get("version") for event in events if event["event_type"] == "publish_result"),
            None,
        ),
        "repeated_handoff": audit["summary"]["repeated_handoff"],
    }


@router.get("/run-comparisons")
def run_comparison(
    run_id: str,
    baseline_run_id: str | None = None,
    dataset: str = Query("CUSTOM"),
):
    with get_conn() as conn:
        dataset_row = _require_custom(conn, dataset)
        run_row = conn.execute(
            "SELECT * FROM runs WHERE dataset_id=? AND run_id=?", (dataset, run_id)
        ).fetchone()
        if run_row is None:
            raise HTTPException(404, f"未知运行 {run_id}")

        pair = conn.execute(
            "SELECT normal_run_id FROM run_pairs WHERE dataset_id=? AND run_id=?", (dataset, run_id)
        ).fetchone()
        normal_id = baseline_run_id or (pair["normal_run_id"] if pair else None)
        if not normal_id:
            raise HTTPException(400, "该运行没有配对正常对照，请显式提供 baseline_run_id")
        baseline_row = conn.execute(
            "SELECT * FROM runs WHERE dataset_id=? AND run_id=?", (dataset, normal_id)
        ).fetchone()
        if baseline_row is None:
            raise HTTPException(404, f"未知对照运行 {normal_id}")

        grouped = _load_run_events(conn, [run_id, normal_id])

    left = grouped.get(run_id, [])
    right = grouped.get(normal_id, [])
    left_audit = custom_audit.audit_run(left)
    right_audit = custom_audit.audit_run(right)

    same_model = run_row["model"] == baseline_row["model"]
    same_fixture = run_row["fixture"] == baseline_row["fixture"]
    baseline_normal = (baseline_row["scenario"] or "") == "normal"

    left_stages = _stage_payload(left)
    right_stages = _stage_payload(right)
    stages = []
    for key, label in STAGES:
        left_events = sorted(left_stages.get(key, []), key=lambda event: event["time_sort_us"])
        right_events = sorted(right_stages.get(key, []), key=lambda event: event["time_sort_us"])
        stages.append(
            {
                "stage": key,
                "label": label,
                "run": _stage_summary(left_events, run_row["start_us"]),
                "baseline": _stage_summary(right_events, baseline_row["start_us"]),
                "missing": {"run": not left_events, "baseline": not right_events},
            }
        )

    left_metrics = _metrics(left, left_audit)
    right_metrics = _metrics(right, right_audit)
    metric_labels = {
        "events": "事件数",
        "calls": "模型调用数",
        "call_duration_ms": "调用耗时(ms)",
        "handoffs": "交接数",
        "review_present": "存在审核",
        "attempts": "发布尝试",
        "read_version": "读取版本",
        "published_version": "发布版本",
        "repeated_handoff": "重复交接",
    }
    metrics = [
        {
            "key": key,
            "label": metric_labels[key],
            "run": left_metrics[key],
            "baseline": right_metrics[key],
            "different": left_metrics[key] != right_metrics[key],
        }
        for key in metric_labels
    ]

    return {
        "meta": {
            "contract_version": filters.CONTRACT_VERSION,
            "dataset_id": dataset,
            "data_version": dataset_row["data_version"],
            "scope": "run_comparison",
            "applied_filters": {"run_id": run_id, "baseline_run_id": normal_id},
        },
        "pair": {
            "run_id": run_id,
            "baseline_run_id": normal_id,
            "auto": baseline_run_id is None,
            "valid": bool(same_model and same_fixture and baseline_normal),
            "same_model": same_model,
            "same_fixture": same_fixture,
            "baseline_normal": baseline_normal,
        },
        "run": _run_payload(run_row),
        "baseline": _run_payload(baseline_row),
        "stages": stages,
        "metrics": metrics,
        "audit": {"run": left_audit["summary"], "baseline": right_audit["summary"]},
        "note": "阶段对齐只按事件类型与角色归类；同一阶段可包含多轮操作，缺失阶段不代表未发生。",
    }
