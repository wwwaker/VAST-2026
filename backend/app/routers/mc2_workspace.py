"""MC2 investigation projections. Aggregates and evidence share one selection.

No import/rebuild or inferred file links: only recorded entity roles are used.
Local context includes incoming roles even when participants omits that role.
"""
from __future__ import annotations

from app.query.mc2_selection import base, selected, participation_clause, RELATIONS, FILE_ROLES

import json

from fastapi import APIRouter, Depends, HTTPException, Query

from app.storage.database import get_conn, require_dataset
from app.domain import event_types
import app.domain.mc2.files as mc2_files
import app.domain.mc2.cache as mc2_cache
import app.domain.mc2.projection as mc2_projection
from app.domain.mc2.relations import type_overview
from app.query import filters
from app.query.filters import RawFilter, FilterError
from app.projections.events import summarize

router = APIRouter(prefix="/api/mc2", tags=["mc2-workspace"])


def meta(conn, sel):
    return {"matched_events": filters.count_events(conn, sel),
            "selection_hash": sel.filter_hash, "applied_filters": sel.context.applied(),
            "data_version": require_dataset(conn, "MC2")["data_version"]}


def event_rows(conn, sel, limit=40, cursor=None, direction="asc"):
    try:
        rows, next_cursor = filters.page_events(conn, sel, limit, cursor, direction)
    except FilterError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc
    return [summarize(row, "MC2", []) for row in rows], next_cursor


@router.get("/activity")
def activity(raw: RawFilter = Depends(filters.filter_params), granularity: str = Query("day", pattern="^(day|hour)$")):
    sel = base(raw)
    step = filters.DAY_US if granularity == "day" else filters.HOUR_US
    with get_conn() as conn:
        bounds = conn.execute("SELECT MIN(time_sort_us),MAX(time_sort_us) FROM events WHERE dataset_id='MC2'").fetchone()
        start = sel.start_us if sel.start_us is not None else bounds[0]
        end = sel.end_us if sel.end_us is not None else bounds[1] + 1
        start = start // step * step
        if (end - start + step - 1) // step > 240:
            raise HTTPException(400, "时间列过多，请先缩小范围再切换小时粒度。")
        buckets = list(range(start, end, step))
        rows = conn.execute(
            "SELECT (e.time_sort_us/:step)*:step bucket,e.event_type,COUNT(*) n "
            f"FROM events e WHERE {sel.where_sql} GROUP BY bucket,e.event_type ORDER BY bucket",
            {**sel.params, "step": step}).fetchall()
        observed = {r[0] for r in conn.execute("SELECT DISTINCT event_type FROM events WHERE dataset_id='MC2'")}
        types = [t for t in event_types.capabilities("MC2")["types"] if t["type"] in observed]
        known = {t["type"] for t in types}
        types += [{"type": t, "display_label": t, "category": 8} for t in sorted(observed - known)]
        return {"meta": meta(conn, sel), "buckets": buckets, "step": step, "types": types,
                "cells": [{"bucket": r["bucket"], "type": r["event_type"], "count": r["n"]} for r in rows],
                "coverage": {"start": bounds[0], "end": bounds[1] + 1},
                "categories": event_types.CATEGORIES}


@router.get("/facets")
def facets(raw: RawFilter = Depends(filters.filter_params), kind: str = Query("file", pattern="^(file|actor|system)$"),
           q: str = "", offset: int = Query(0, ge=0)):
    sel = base(raw)
    with get_conn() as conn:
        data = mc2_cache.cached(conn, ("facets", projection_key(sel), kind),
                                lambda: _facet_data(conn, sel, raw, kind))
    rows = [r for r in data["items"] if q.casefold() in (r["label"] or r["id"]).casefold()]
    return {**data, "items": rows[offset:offset + 12], "total": len(rows), "offset": offset,
            "scale_max": max((r["count"] for r in data["items"]), default=1)}


def _facet_data(conn, sel, raw, kind):
    projected = mc2_projection.facets(conn, sel, kind)
    if projected is not None:
        return projected
    if kind == "actor":
        sql = ("SELECT e.actor_id id,en.label,en.entity_type,COUNT(DISTINCT e.event_id) count "
               "FROM events e LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
               f"WHERE {sel.where_sql} GROUP BY e.actor_id")
        missing = conn.execute(f"SELECT COUNT(*) FROM events e WHERE {sel.where_sql} AND e.actor_id IS NULL", sel.params).fetchone()[0]
    else:
        role_clause = "r.relation IN ('file_path','queued_file_path','post_content_source')" if kind == "file" else "en.entity_type='system'"
        sql = ("SELECT r.dst_id id,COALESCE(en.source_value,en.label,r.dst_id) label,en.entity_type,COUNT(DISTINCT e.event_id) count "
               "FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
               "LEFT JOIN entities en ON en.dataset_id=r.dataset_id AND en.entity_id=r.dst_id "
               f"WHERE {sel.where_sql} AND r.target_kind='entity' AND {role_clause} GROUP BY r.dst_id")
        if kind == "file":
            missing = filters.count_events(conn, selected(raw, no_file=True))
        else:
            missing = filters.count_events(conn, sel) - conn.execute(
                "SELECT COUNT(DISTINCT e.event_id) FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
                "JOIN entities en ON en.dataset_id=r.dataset_id AND en.entity_id=r.dst_id "
                f"WHERE {sel.where_sql} AND en.entity_type='system'", sel.params).fetchone()[0]
    rows = [dict(r) for r in conn.execute(sql, sel.params) if r["id"] is not None]
    rows = sorted(rows, key=lambda r: (-r["count"], r["id"]))
    return {"meta": meta(conn, sel), "items": rows, "total": len(rows),
            "missing": missing, "kind": kind}


@router.get("/relations")
def relations(raw: RawFilter = Depends(filters.filter_params), file_id: str | None = None,
              no_file: bool = False, mode: str = Query("system", pattern="^(system|relay|operations|types)$"),
              relation: str | None = None):
    sel = selected(raw, file_id, no_file)
    with get_conn() as conn:
        from app.domain.mc2.semantics import registry
        data = mc2_cache.cached(conn, ("relations", projection_key(sel), file_id, mode, relation),
                                lambda: _relations(conn, sel, file_id, mode, relation))
        return {**data, "semantics": registry()}


def projection_key(sel):
    # filter_hash excludes the replay cursor, while applied() includes it.
    return sel.filter_hash, json.dumps(sel.context.applied(), sort_keys=True)


def _relations(conn, sel, file_id, mode, relation):
    if mode == "types":
        projected = mc2_projection.overview(conn, sel, RELATIONS)
        return projected if projected is not None else type_overview(conn, sel, meta(conn, sel), RELATIONS)
    projected = mc2_projection.details(conn, sel, file_id, mode, relation, RELATIONS)
    if projected is not None:
        return projected
    relation_counts = [dict(r) for r in conn.execute(
        "SELECT r.relation,COUNT(DISTINCT e.event_id) count FROM events e "
        "JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
        f"WHERE {sel.where_sql} AND r.target_kind='entity' GROUP BY r.relation ORDER BY count DESC,r.relation", sel.params)]
    valid = [r["relation"] for r in relation_counts]
    if mode == "relay":
        allowed = [r for r in valid if r in ("queue_target_agent", "queue_target_person")]
    elif mode == "operations":
        allowed = [r for r in valid if r in FILE_ROLES]
    else:
        allowed = [relation] if relation in valid else valid[:1]
    params = dict(sel.params)
    marks = []
    for i, role in enumerate(allowed):
        params[f"role{i}"] = role
        marks.append(f":role{i}")
    role_sql = "r.relation IN (" + ",".join(marks) + ")" if marks else "0"
    if mode == "operations":
        role_sql += " AND r.dst_id=:op_file"
        params["op_file"] = file_id
    needs_file = mode == "system" and not file_id and any(r in FILE_ROLES for r in allowed)
    src_expr = "COALESCE(r.src_id,'__missing__')"
    dst_expr = "r.dst_id"
    edges = [dict(r) for r in conn.execute(
        f"SELECT {src_expr} source,{dst_expr} target,r.relation,e.event_type action,"
        "COUNT(DISTINCT e.event_id) count,MIN(e.time_sort_us) first_us,MAX(e.time_sort_us) last_us "
        "FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
        f"WHERE {sel.where_sql} AND r.target_kind='entity' AND {role_sql} AND {0 if needs_file else 1} "
        f"GROUP BY {src_expr},{dst_expr},r.relation,e.event_type ORDER BY count DESC,source,target", params)]
    mapped = conn.execute(
        "SELECT COUNT(DISTINCT e.event_id) FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
        f"WHERE {sel.where_sql} AND r.target_kind='entity' AND {role_sql}", params).fetchone()[0]
    ids = {x[k] for x in edges for k in ("source", "target")}
    nodes = []
    for entity in sorted(ids):
        row = conn.execute("SELECT label,source_value,entity_type FROM entities WHERE dataset_id='MC2' AND entity_id=?", (entity,)).fetchone()
        nodes.append({"id": entity, "label": (row["source_value"] if row["entity_type"] == "file_path" else row["label"]) or entity,
                      "entity_type": row["entity_type"]} if row else {"id": entity, "label": "缺少发起者", "entity_type": "missing"})
    payload_meta = meta(conn, sel)
    return {"meta": payload_meta, "nodes": nodes, "edges": edges, "mapped_events": mapped,
            "unmapped_events": payload_meta["matched_events"] - mapped,
            "missing_source_events": conn.execute(
                "SELECT COUNT(DISTINCT e.event_id) FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
                f"WHERE {sel.where_sql} AND {role_sql} AND r.src_id IS NULL", params).fetchone()[0],
            "relation_counts": [{**r, "label": RELATIONS.get(r["relation"], r["relation"])} for r in relation_counts],
            "selected_relations": allowed, "mode": mode, "needs_file": needs_file}


@router.get("/evidence")
def evidence(raw: RawFilter = Depends(filters.filter_params), file_id: str | None = None, no_file: bool = False,
             relation: str | None = None, source: str | None = None, target: str | None = None,
             action: str | None = None, cursor: str | None = None,
             direction: str = Query("asc", pattern="^(asc|desc)$"), distribution: bool = False, actor_missing: bool = False):
    sel = selected(raw, file_id, no_file, relation, source, target, action)
    if actor_missing:
        sel = sel.extend("e.actor_id IS NULL", {}, "missing-actor")
    with get_conn() as conn:
        items, nxt = event_rows(conn, sel, cursor=cursor, direction=direction)
        timeline = []
        if distribution:
            lo, hi = conn.execute(f"SELECT MIN(e.time_sort_us),MAX(e.time_sort_us) FROM events e WHERE {sel.where_sql}", sel.params).fetchone()
            if lo is not None:
                step = max(1_000_000, (hi - lo + 1) // 64 + 1)
                timeline = [dict(r) for r in conn.execute(
                    "SELECT ((e.time_sort_us-:dist_lo)/:dist_step)*:dist_step+:dist_lo start,COUNT(*) count "
                    f"FROM events e WHERE {sel.where_sql} GROUP BY start ORDER BY start", {**sel.params, "dist_lo": lo, "dist_step": step})]
                for bucket in timeline:
                    bucket["end"] = bucket["start"] + step
        return {"meta": meta(conn, sel), "items": items, "next_cursor": nxt, "timeline": timeline}


@router.get("/process")
def process(anchor: str, raw: RawFilter = Depends(filters.filter_params), file_id: str | None = None,
            no_file: bool = False, relation: str | None = None, source: str | None = None,
            target: str | None = None, action: str | None = None,
            seconds: int = Query(60, ge=1, le=86400), context: bool = False,
            expand: bool = False, actors: str = "", bins: int = Query(240, ge=32, le=512), selected_event: str | None = None,
            expected_version: str | None = None):
    import app.domain.mc2.process as mc2_process
    with get_conn() as conn:
        packet = mc2_process.collect(conn, raw, anchor, file_id, no_file, relation, source,
                                     target, action, seconds, context, expand, actors, bins, selected_event)
        if expected_version and packet['data_version'] != expected_version:
            raise HTTPException(409, '固定过程的数据版本已不存在，请取消固定并重新选择记录')
        return mc2_process.public(packet)


@router.get('/file-info')
def file_info(file_id: str):
    import app.domain.mc2.files as mc2_files
    with get_conn() as conn:
        try:
            info = mc2_cache.cached(conn, ('file-info', file_id), lambda: mc2_files.content_status(conn, 'MC2', file_id))
        except KeyError:
            raise HTTPException(404, '此精确文件已不存在')
        return {k: info[k] for k in ('file_id', 'path', 'content_status', 'reason', 'events_truncated')}


@router.get("/process-members")
def process_members(anchor: str, aggregate_id: str, data_version: str, selection_key: str,
                    raw: RawFilter = Depends(filters.filter_params), file_id: str | None = None,
                    no_file: bool = False, relation: str | None = None, source: str | None = None,
                    target: str | None = None, action: str | None = None,
                    seconds: int = Query(60, ge=1, le=86400), context: bool = False, expand: bool = False,
                    actors: str = "", bins: int = Query(240, ge=32, le=512), selected_event: str | None = None,
                    cursor: str | None = None, member_action: str | None = None):
    import app.domain.mc2.process as mc2_process
    with get_conn() as conn:
        packet = mc2_process.collect(conn, raw, anchor, file_id, no_file, relation, source,
                                    target, action, seconds, context, expand, actors, bins, selected_event)
        return mc2_process.members(packet, aggregate_id, data_version, selection_key, cursor, member_action)


@router.get("/count")
def count(raw: RawFilter = Depends(filters.filter_params), file_id: str | None = None, no_file: bool = False,
          relation: str | None = None, source: str | None = None, target: str | None = None, action: str | None = None):
    with get_conn() as conn:
        return {"meta": meta(conn, selected(raw, file_id, no_file, relation, source, target, action))}


@router.get("/comparison")
def comparison(before_us: int | None = None, offset: int = Query(0, ge=0)):
    with get_conn() as conn:
        params = {"before": before_us}
        where = "e.dataset_id='MC2' AND (:before IS NULL OR e.time_sort_us<:before)"
        rows = conn.execute(
            "SELECT e.event_id,e.time_sort_us,e.actor_id,r.dst_id file_id,f.source_value path "
            "FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id AND r.relation='post_content_source' "
            "LEFT JOIN entities f ON f.dataset_id=r.dataset_id AND f.entity_id=r.dst_id "
            f"WHERE {where} ORDER BY e.time_sort_us,e.event_id", params).fetchall()
        items = []
        for row in rows[offset:offset + 20]:
            ops = [dict(r) for r in conn.execute(
                "SELECT DISTINCT e.event_id,e.event_type,e.time_sort_us FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
                "WHERE r.dataset_id='MC2' AND r.dst_id=? AND r.relation IN ('file_path','queued_file_path','post_content_source') ORDER BY e.time_sort_us,e.event_id", (row["file_id"],))]
            creates = [r for r in ops if r["event_type"] == "create_file" and r["time_sort_us"] <= row["time_sort_us"]]
            deletes = [r for r in ops if r["event_type"] == "delete_file" and r["time_sort_us"] >= row["time_sort_us"]]
            info = mc2_files.content_status(conn, "MC2", row["file_id"])
            items.append({**dict(row), "operations": ops, "content_status": info["content_status"], "content_note": info["reason"],
                          "create_lag_us": row["time_sort_us"] - creates[-1]["time_sort_us"] if creates else None,
                          "delete_lag_us": deletes[0]["time_sort_us"] - row["time_sort_us"] if deletes else None})
        return {"items": items, "total": len(rows), "offset": offset,
                "meta": {"data_version": require_dataset(conn, "MC2")["data_version"], "before_us": before_us},
                "note": "全库有明确 post_content_source 的发布子集；文件操作为全历史。未见记录不等于行为未发生，不含同名前缀推断。"}


@router.get('/file-patterns')
def file_patterns(offset: int = Query(0, ge=0), sort: str = Query('files', pattern='^(files|actions)$')):
    import app.domain.mc2.fingerprints as mc2_fingerprints
    with get_conn() as conn:
        return mc2_fingerprints.patterns(conn, offset, sort)


@router.get('/file-pattern-members')
def file_pattern_members(pattern_id: str, offset: int = Query(0, ge=0), q: str = '', data_version: str | None = None):
    import app.domain.mc2.fingerprints as mc2_fingerprints
    with get_conn() as conn:
        return mc2_fingerprints.members(conn, pattern_id, offset, q, data_version)
