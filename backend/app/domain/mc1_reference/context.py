# Message Context / Related Messages

import re
from typing import Any, Dict, List, Optional

from .config import (
    CRISIS_KEYWORDS, CHANNEL_WINDOW_MINUTES, NEIGHBOR_COUNT,
    AGENT_LABELS, CHANNEL_LABELS,
)

def _agent_name(m: Optional[Dict[str, Any]]) -> Optional[str]:
    """优先返回中文 Agent 名，取不到时退回原始 label。"""
    if not m:
        return None
    return AGENT_LABELS.get(m.get("agent_id") or "") or m.get("agent_label")

def _channel_name(channel: Optional[str]) -> str:
    return CHANNEL_LABELS.get(channel or "") or (channel or "")

_CRISIS_PATTERNS = [
    (kw, re.compile(r"\b" + re.escape(kw) + r"\b", re.IGNORECASE))
    for kw in CRISIS_KEYWORDS
]

def _keywords_in(text: str) -> List[str]:
    if not text:
        return []
    found = []
    for kw, pat in _CRISIS_PATTERNS:
        if pat.search(text) and kw not in found:
            found.append(kw)
    return found

def _project_related(m: Dict[str, Any], relation_type: str, relation_reason: str) -> Dict[str, Any]:
    return {
        "message_id": m.get("message_id"),
        "comm_id": m.get("comm_id"),
        "timestamp": m.get("timestamp"),
        "agent_id": m.get("agent_id"),
        "agent_label": m.get("agent_label"),
        "agent_role": m.get("agent_role"),
        "channel": m.get("channel"),
        "message_type": m.get("message_type"),
        "visibility": m.get("visibility"),
        "content": m.get("content"),
        "responding_to": m.get("responding_to") or "",
        "resolved_parent_id": m.get("resolved_parent_id") or "",
        "reply_kind": m.get("reply_kind") or "",
        "recipients": m.get("recipients"),
        "event_id": m.get("event_id"),
        "source_pointer": m.get("source_pointer"),
        "reply_class": m.get("reply_class"),
        "internal_reacting": m.get("internal_reacting"),
        "internal_rationalizing": m.get("internal_rationalizing"),
        "internal_deliberating": m.get("internal_deliberating"),
        "round_hour": m.get("round_hour"),
        "relation_type": relation_type,
        "relation_reason": relation_reason,
    }

def build_reply_thread(
    all_msgs: List[Dict[str, Any]],
    message_id: str,
) -> List[Dict[str, Any]]:
    by_id = {m["message_id"]: m for m in all_msgs}
    sel = by_id.get(message_id)
    if sel is None:
        return []

    def parent_of(m: Dict[str, Any]) -> str:
        return m.get("resolved_parent_id") or ""

    def link_reason(m: Dict[str, Any]) -> str:
        pid = parent_of(m)
        if not pid:
            return "开启该话题"
        target = by_id.get(pid)
        tlabel = _agent_name(target) if target else None
        kind = m.get("reply_kind") or ""
        if kind == "direct":
            return f"直接回复 {tlabel}" if tlabel else "直接回复"
        if kind == "addressed":
            return f"点名致意 {tlabel}" if tlabel else "点名致意更早的发言者"
        return f"回复 {tlabel}" if tlabel else "话题内的回复"

    children: Dict[str, List[Dict[str, Any]]] = {}
    for m in all_msgs:
        pid = parent_of(m)
        if pid:
            children.setdefault(pid, []).append(m)

    seen = {message_id}

    chain: List[Dict[str, Any]] = []
    cur = sel
    while True:
        pid = parent_of(cur)
        if not pid or pid not in by_id or pid in seen:
            break
        parent = by_id[pid]
        chain.append(parent)
        seen.add(pid)
        cur = parent
    ancestors = list(reversed(chain))

    descendants: List[Dict[str, Any]] = []
    queue = list(children.get(message_id, []))
    while queue:
        node = queue.pop(0)
        nid = node.get("message_id")
        if nid in seen:
            continue
        seen.add(nid)
        descendants.append(node)
        queue.extend(children.get(nid, []))

    thread_msgs = ancestors + [sel] + descendants
    thread_msgs.sort(key=lambda m: (m.get("timestamp") or "", m.get("comm_id") or 0))

    ancestor_ids = {m["message_id"] for m in ancestors}
    out = []
    for m in thread_msgs:
        mid = m.get("message_id")
        if mid == message_id:
            role, reason = "self", "所选消息"
        elif mid in ancestor_ids:
            role, reason = "ancestor", link_reason(m)
        else:
            role, reason = "reply", link_reason(m)
        item = _project_related(m, role, reason)
        item["is_focus"] = (mid == message_id)
        out.append(item)
    return out

def _parse_ts(value: Optional[str]):
    if not value:
        return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(value)
    except Exception:
        return None

def _empty_context(message_id: str) -> Dict[str, Any]:
    return {
        "found": False,
        "selected_message": None,
        "parent_message": None,
        "replies": [],
        "temporal_neighbors": [],
        "same_channel_context": [],
        "same_agent_context": [],
        "keyword_related": [],
        "all_related": [],
        "thread": [],
        "requested_message_id": message_id,
    }

def build_message_context(
    all_msgs: List[Dict[str, Any]],
    message_id: str,
    window_minutes: int = CHANNEL_WINDOW_MINUTES,
    neighbor_count: int = NEIGHBOR_COUNT,
) -> Dict[str, Any]:
    by_id = {m["message_id"]: m for m in all_msgs}
    sel = by_id.get(message_id)
    if sel is None:
        return _empty_context(message_id)

    ordered = sorted(all_msgs, key=lambda m: (m.get("timestamp") or "", m.get("message_id") or ""))

    round_hour = sel.get("round_hour")
    channel = sel.get("channel")
    agent_id = sel.get("agent_id")
    sel_dt = _parse_ts(sel.get("timestamp"))
    sel_keywords = _keywords_in(sel.get("content") or "")

    parent = None
    pid = sel.get("resolved_parent_id") or ""
    if pid and pid in by_id and pid != message_id:
        kind = sel.get("reply_kind") or ""
        reason = "直接回复的对象" if kind == "direct" else (
            "被点名致意的更早发言者" if kind == "addressed" else "上级消息")
        parent = _project_related(by_id[pid], "parent", reason)

    replies = [
        _project_related(m, "reply", "直接回复" if (m.get("reply_kind") == "direct") else "点名致意回复")
        for m in ordered
        if (m.get("resolved_parent_id") or "") == message_id
    ]

    round_msgs = [m for m in ordered if m.get("round_hour") == round_hour]
    temporal_neighbors = []
    sel_idx = next((i for i, m in enumerate(round_msgs) if m["message_id"] == message_id), None)
    if sel_idx is not None:
        nb = round_msgs[max(0, sel_idx - neighbor_count):sel_idx] + \
             round_msgs[sel_idx + 1:sel_idx + 1 + neighbor_count]
        temporal_neighbors = [_project_related(m, "temporal", "同一轮次内的上下文") for m in nb]

    same_channel_context = []
    if sel_dt is not None and channel:
        candidates = []
        for m in ordered:
            if m["message_id"] == message_id or m.get("channel") != channel:
                continue
            mdt = _parse_ts(m.get("timestamp"))
            if mdt is None:
                continue
            delta = abs((mdt - sel_dt).total_seconds())
            if delta <= window_minutes * 60:
                candidates.append((delta, m))
        candidates.sort(key=lambda x: x[0])
        nearest = [m for _, m in candidates[:8]]
        nearest.sort(key=lambda m: (m.get("timestamp") or "", m.get("message_id") or ""))
        same_channel_context = [
            _project_related(m, "same_channel", "时间窗口内的同渠道消息")
            for m in nearest
        ]

    agent_msgs = [m for m in ordered if m.get("agent_id") == agent_id]
    same_agent_context = []
    aidx = next((i for i, m in enumerate(agent_msgs) if m["message_id"] == message_id), None)
    if aidx is not None:
        an = agent_msgs[max(0, aidx - neighbor_count):aidx] + \
             agent_msgs[aidx + 1:aidx + 1 + neighbor_count]
        same_agent_context = [_project_related(m, "same_agent", "同一 Agent 的邻近消息") for m in an]

    keyword_related = []
    if sel_keywords:
        for m in round_msgs:
            if m["message_id"] == message_id:
                continue
            shared = [kw for kw in sel_keywords if _keywords_in(m.get("content") or "").count(kw)]
            if shared:
                keyword_related.append(
                    _project_related(m, "keyword", f"共享危机关键词：{shared[0]}")
                )
        keyword_related = keyword_related[:10]

    all_related = []
    seen = {message_id}
    for group in ([parent] if parent else [], replies, temporal_neighbors,
                  keyword_related, same_channel_context, same_agent_context):
        for item in group:
            mid = item["message_id"]
            if mid in seen:
                continue
            seen.add(mid)
            all_related.append(item)
    all_related.sort(key=lambda x: (x.get("timestamp") or "", x.get("message_id") or ""))

    reasons = []
    if channel in ("side_huddle", "anonymous_post"):
        reasons.append(f"它出现在「{_channel_name(channel)}」渠道中")
    if sel_keywords:
        reasons.append(f"其内容涉及“{sel_keywords[0]}”相关表述")
    if replies:
        reasons.append(f"它收到了 {len(replies)} 条回复")
    if parent:
        reasons.append("它属于一个仍在延续的话题")
    if reasons:
        why = "这条消息之所以重要，是因为" + "，".join(reasons) + "。"
    else:
        why = "该消息没有检测到明显的上下文线索。"

    selected_message = _project_related(sel, "selected", "所选消息")
    selected_message["why_matters"] = why
    selected_message["internal_reacting"] = sel.get("internal_reacting")
    selected_message["internal_rationalizing"] = sel.get("internal_rationalizing")
    selected_message["internal_deliberating"] = sel.get("internal_deliberating")

    return {
        "found": True,
        "selected_message": selected_message,
        "parent_message": parent,
        "replies": replies,
        "temporal_neighbors": temporal_neighbors,
        "same_channel_context": same_channel_context,
        "same_agent_context": same_agent_context,
        "keyword_related": keyword_related,
        "all_related": all_related,
        "requested_message_id": message_id,
    }
