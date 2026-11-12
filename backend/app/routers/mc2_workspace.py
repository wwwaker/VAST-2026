"""MC2 investigation projections. Aggregates and evidence share one selection.

No import/rebuild or inferred file links: only recorded entity roles are used.
Local context includes incoming roles even when participants omits that role.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
import json

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_conn, require_dataset
from ..domain import event_types
from ..domain import mc2_files
from ..query import filters
from ..query.filters import RawFilter, FilterError
from .events import summarize

router = APIRouter(prefix="/api/mc2", tags=["mc2-workspace"])
FILE_ROLES = ("file_path", "queued_file_path", "post_content_source")
RELATIONS = {
    "queue_target_agent": "任务目标 · 智能体",
    "queue_target_person": "任务目标 · 人员",
    "mail_recipient": "邮件收件角色",
    "mail_sender": "邮件发件角色",
    "a2a_destination": "智能体通信目标",
    "meeting_invitee": "会议邀请对象",
    "system_party": "系统参与角色",
    "room": "场所角色",
    "file_path": "文件操作",
    "queued_file_path": "任务文件参数",
    "post_content_source": "发布来源引用",
}


def base(raw: RawFilter):
    try:
        ctx = raw.to_context("MC2")
        participant = ctx.participant_id
        sel = filters.build_selection(ctx.model_copy(update={"participant_id": None}) if participant else ctx)
        if participant:
            params = {}
            sel = sel.extend(participation_clause([participant], params), params, f"participant:{participant}")
            sel = replace(sel, context=ctx)
        return sel
    except FilterError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc


def selected(raw: RawFilter, file_id=None, no_file=False, relation=None,
             source=None, target=None, action=None):
    sel = base(raw)
    if file_id or no_file:
        clause = ("EXISTS (SELECT 1 FROM relations rf WHERE rf.dataset_id=e.dataset_id "
                  "AND rf.event_id=e.event_id AND rf.relation IN "
                  "('file_path','queued_file_path','post_content_source')")
        if file_id:
            sel = sel.extend(clause + " AND rf.dst_id=:w_file)", {"w_file": file_id}, f"file:{file_id}")
        else:
            sel = sel.extend("NOT " + clause + ")", {}, "no-file")
    if relation:
        if relation not in RELATIONS:
            raise HTTPException(400, "未知关系类型")
        clause = ("EXISTS (SELECT 1 FROM relations rr WHERE rr.dataset_id=e.dataset_id "
                  "AND rr.event_id=e.event_id AND rr.target_kind='entity' AND rr.relation=:w_rel")
        params = {"w_rel": relation}
        if source:
            clause += " AND rr.src_id IS NULL" if source == "__missing__" else " AND rr.src_id=:w_src"
            params["w_src"] = source
        if target:
            clause += " AND rr.dst_id=:w_dst"
            params["w_dst"] = target
        sel = sel.extend(clause + ")", params, json.dumps([relation, source, target]))
    if action:
        sel = sel.extend("e.event_type=:w_action", {"w_action": action}, f"action:{action}")
    return sel


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
        rows = sorted((r for r in rows if q.casefold() in (r["label"] or r["id"]).casefold()), key=lambda r: (-r["count"], r["id"]))
        return {"meta": meta(conn, sel), "items": rows[offset:offset + 12], "total": len(rows),
                "offset": offset, "missing": missing, "kind": kind}


@router.get("/relations")
def relations(raw: RawFilter = Depends(filters.filter_params), file_id: str | None = None,
              no_file: bool = False, mode: str = Query("system", pattern="^(system|relay|operations|types)$"),
              relation: str | None = None):
    sel = selected(raw, file_id, no_file)
    with get_conn() as conn:
        relation_counts = [dict(r) for r in conn.execute(
            "SELECT r.relation,COUNT(DISTINCT e.event_id) count FROM events e "
            "JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
            f"WHERE {sel.where_sql} AND r.target_kind='entity' GROUP BY r.relation ORDER BY count DESC", sel.params)]
        valid = [r["relation"] for r in relation_counts]
        if mode == "relay":
            allowed = [r for r in valid if r in ("queue_target_agent", "queue_target_person")]
        elif mode == "operations":
            allowed = [r for r in valid if r in ("file_path", "post_content_source")]
        elif mode == "types":
            allowed = valid
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
        src_expr = "COALESCE(src.entity_type,'unknown')" if mode == "types" else "COALESCE(r.src_id,'__missing__')"
        dst_expr = "COALESCE(dst.entity_type,'unknown')" if mode == "types" else "r.dst_id"
        edges = [dict(r) for r in conn.execute(
            f"SELECT {src_expr} source,{dst_expr} target,r.relation,e.event_type action,"
            "COUNT(DISTINCT e.event_id) count,MIN(e.time_sort_us) first_us,MAX(e.time_sort_us) last_us "
            "FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
            "LEFT JOIN entities src ON src.dataset_id=r.dataset_id AND src.entity_id=r.src_id "
            "LEFT JOIN entities dst ON dst.dataset_id=r.dataset_id AND dst.entity_id=r.dst_id "
            f"WHERE {sel.where_sql} AND r.target_kind='entity' AND {role_sql} AND {0 if needs_file else 1} "
            f"GROUP BY {src_expr},{dst_expr},r.relation,e.event_type ORDER BY count DESC,source,target", params)]
        mapped = conn.execute(
            "SELECT COUNT(DISTINCT e.event_id) FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
            f"WHERE {sel.where_sql} AND r.target_kind='entity' AND {role_sql}", params).fetchone()[0]
        ids = {x[k] for x in edges for k in ("source", "target")}
        if mode == "types":
            members = {r["entity_type"]: r["count"] for r in conn.execute(
                "SELECT en.entity_type,COUNT(DISTINCT en.entity_id) count FROM entities en WHERE en.dataset_id='MC2' AND en.entity_id IN ("
                "SELECT r.src_id FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
                f"WHERE {sel.where_sql} AND r.target_kind='entity' AND {role_sql} UNION "
                "SELECT r.dst_id FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
                f"WHERE {sel.where_sql} AND r.target_kind='entity' AND {role_sql}) GROUP BY en.entity_type", params)}
            labels = {"agent": "智能体", "person": "人员", "file_path": "文件", "system": "系统", "room": "场所", "team": "团队", "department": "部门", "company": "公司", "world": "环境", "unknown": "缺失角色"}
            nodes = [{"id": i, "label": f"{labels.get(i, i)} · {members.get(i, 0)} 个活跃实体", "entity_type": i} for i in sorted(ids)]
        else:
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


def participation_clause(ids, params, prefix="participant"):
    marks = []
    for i, entity in enumerate(ids):
        key = f"{prefix}{i}"
        params[key] = entity
        marks.append(f":{key}")
    if not marks:
        return "0"
    values = ",".join(marks)
    return (f"(e.actor_id IN ({values}) OR EXISTS (SELECT 1 FROM relations rp "
            "WHERE rp.dataset_id=e.dataset_id AND rp.event_id=e.event_id AND rp.target_kind='entity' "
            "AND rp.derivation LIKE 'source:%' "
            f"AND (rp.src_id IN ({values}) OR rp.dst_id IN ({values}))))")


@router.get("/process")
def process(anchor: str, raw: RawFilter = Depends(filters.filter_params), file_id: str | None = None,
            no_file: bool = False, relation: str | None = None, source: str | None = None,
            target: str | None = None, action: str | None = None,
            seconds: int = Query(60, ge=1, le=86400), context: bool = False,
            expand: bool = False, actors: str = ""):
    parent = selected(raw, file_id, no_file, relation, source, target, action)
    with get_conn() as conn:
        root = conn.execute("SELECT * FROM events WHERE dataset_id='MC2' AND event_id=?", (anchor,)).fetchone()
        if root is None:
            raise HTTPException(404, "锚点记录不存在")
        valid = conn.execute(f"SELECT 1 FROM events e WHERE {parent.where_sql} AND e.event_id=:anchor", {**parent.params, "anchor": anchor}).fetchone() is not None
        if not valid and not expand:
            return {"valid": False, "anchor": anchor, "anchor_time": root["time_sort_us"], "items": [], "lanes": [], "links": [],
                    "note": "锚点不符合当前选择。调整范围后重算，或明确固定原过程。"}
        start, end = root["time_sort_us"] - seconds * 1_000_000, root["time_sort_us"] + seconds * 1_000_000 + 1
        if not expand:
            start = max(start, parent.start_us if parent.start_us is not None else start)
            end = min(end, parent.end_us if parent.end_us is not None else end)
        seed = {root["actor_id"]} if root["actor_id"] else set()
        for row in conn.execute(
            "SELECT r.src_id,r.dst_id,src.entity_type st,dst.entity_type dt FROM relations r "
            "LEFT JOIN entities src ON src.dataset_id=r.dataset_id AND src.entity_id=r.src_id "
            "LEFT JOIN entities dst ON dst.dataset_id=r.dataset_id AND dst.entity_id=r.dst_id "
            "WHERE r.dataset_id='MC2' AND r.event_id=? AND r.target_kind='entity' AND r.derivation LIKE 'source:%'", (anchor,)):
            if row["st"] in ("agent", "person"):
                seed.add(row["src_id"])
            if row["dt"] in ("agent", "person"):
                seed.add(row["dst_id"])
        # Extra entities are an explicit user action. Incoming task sources are
        # discovered by their target role; no recursive expansion is performed.
        if actors:
            seed.update(x for x in actors.split(",") if x)
        if len(seed) > 150:
            raise HTTPException(400, "局部实体过多，请缩小选择")
        main = parent.extend("e.time_sort_us>=:pstart AND e.time_sort_us<:pend", {"pstart": start, "pend": end}, f"window:{start}:{end}")
        p = {"f_dataset": "MC2", "pstart": start, "pend": end, "p_anchor": anchor}
        part = participation_clause(sorted(seed), p, prefix="seed")
        if context:
            rows = conn.execute(
                "SELECT e.*,en.label actor_label FROM events e LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
                f"WHERE e.dataset_id='MC2' AND e.time_sort_us>=:pstart AND e.time_sort_us<:pend AND ({part} OR e.event_id=:p_anchor) ORDER BY e.time_sort_us,e.event_id", p).fetchall()
        else:
            rows = conn.execute(
                "SELECT e.*,en.label actor_label FROM events e LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
                f"WHERE {main.where_sql} ORDER BY e.time_sort_us,e.event_id", main.params).fetchall()
        main_ids = {r[0] for r in conn.execute(f"SELECT e.event_id FROM events e WHERE {main.where_sql} AND ({part} OR e.event_id=:p_anchor)", {**main.params, **p})}
        if not context:
            rows = [r for r in rows if r["event_id"] in main_ids]
        items, links = [], []
        lane_ids = set(seed)
        roles_by_event = defaultdict(list)
        # Read role rows in batches instead of one SQL query per plotted event.
        row_ids = [r["event_id"] for r in rows]
        for offset in range(0, len(row_ids), 500):
            chunk = row_ids[offset:offset + 500]
            placeholders = ",".join("?" for _ in chunk)
            for role in conn.execute(
                "SELECT event_id,relation,src_id,dst_id,derivation FROM relations "
                f"WHERE dataset_id='MC2' AND target_kind='entity' AND event_id IN ({placeholders})", chunk):
                role = dict(role)
                roles_by_event[role.pop("event_id")].append(role)
        # Aggregate by pixel-scale time bins only when needed; retain the anchor.
        aggregated = defaultdict(list)
        for row in rows:
            roles = roles_by_event[row["event_id"]]
            item = {**summarize(row, "MC2", []), "context": row["event_id"] not in main_ids,
                    "roles": roles, "files": sorted({r["dst_id"] for r in roles if r["relation"] in FILE_ROLES})}
            lane = row["actor_id"] or "__missing__"
            lane_ids.add(lane)
            if len(rows) > 600 and row["event_id"] != anchor:
                bucket = (row["time_sort_us"] - start) * 240 // max(1, end - start)
                aggregated[(lane, bucket, item["context"])].append(item)
            else:
                items.append(item)
                for role in roles:
                    if role["relation"] in ("queue_target_agent", "queue_target_person"):
                        lane_ids.add(role["dst_id"])
                        links.append({"event_id": row["event_id"], "source": lane, "target": role["dst_id"], "relation": role["relation"], "time_us": row["time_sort_us"]})
        for (lane, bucket, ctx), group in aggregated.items():
            items.append({**group[0], "aggregate_count": len(group), "bucket_start": start + bucket * (end - start) // 240,
                          "bucket_end": start + (bucket + 1) * (end - start) // 240 + 1, "context": ctx})
        lanes = []
        for entity in sorted(lane_ids):
            en = conn.execute("SELECT label,entity_type FROM entities WHERE dataset_id='MC2' AND entity_id=?", (entity,)).fetchone()
            lanes.append({"id": entity, "label": en["label"] if en else "缺少执行者", "entity_type": en["entity_type"] if en else "missing"})
        return {"valid": True, "anchor": anchor, "anchor_time": root["time_sort_us"], "start": start, "end": end,
                "items": sorted(items, key=lambda i: (i["time_us"], i["event_id"])), "lanes": lanes, "links": links,
                "total": len(rows), "main_count": sum(r["event_id"] in main_ids for r in rows),
                "context_count": sum(r["event_id"] not in main_ids for r in rows), "seed_actors": sorted(seed),
                "outside_main": sum(r["time_sort_us"] < (parent.start_us if parent.start_us is not None else start)
                                    or r["time_sort_us"] >= (parent.end_us if parent.end_us is not None else end) for r in rows),
                "expanded": expand, "note": "参与包括执行者及日志明确来源/目标角色；包含入向任务，仅一跳，不递归。"}


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
                "note": "全库有明确 post_content_source 的发布子集；文件操作为全历史。未见记录不等于行为未发生，不含同名前缀推断。"}
