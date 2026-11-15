"""MC2 selection semantics shared by aggregates, evidence and local processes."""
from dataclasses import replace
import json
from fastapi import HTTPException
from app.query import filters
from app.query.filters import RawFilter, FilterError

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
        clause = ("e.event_id IN (SELECT rf.event_id FROM relations rf WHERE rf.dataset_id='MC2' "
                  "AND rf.event_id IS NOT NULL AND rf.relation IN "
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
