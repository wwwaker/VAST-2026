"""MC1 先兆候选规则（M1-03）。

原则：
- 不用情绪分数或黑箱概率；每条规则必须给出 rule_id、版本、适用渠道、预期依据与局限。
- 有记录依据的规则引用环境叙事 / 事件标记的 context_id；没有制度依据的规则明确标
  expected_basis="pending"（界面上是“待确认预期”），不生成候选去凑数量。
- 候选层 provenanceKind=candidate，不进入已确认统计；默认只检索目标窗口之前的历史。
"""

from __future__ import annotations

import json

from ..query import filters
from . import mc1_context

RULE_VERSION = "1.0"
DEFAULT_TOPIC_KEYWORDS = (
    "merger",
    "civicloom",
    "harborcrest",
    "residentedge",
    "embargo",
    "6pm",
)
MAX_CANDIDATES = 20


def _incident_window(views: dict | None, target_us: int | None) -> dict:
    markers = (views or {}).get("event_markers") or []
    by_id = {item.get("event_id"): item for item in markers}
    start_item = by_id.get("saltwind_confirms")
    end_item = by_id.get("formal_lift")
    if start_item and end_item:
        return {
            "start_us": mc1_context.parse_epoch_us(start_item["timestamp"]),
            "end_us": mc1_context.parse_epoch_us(end_item["timestamp"]),
            "source": "event_markers:saltwind_confirms..formal_lift",
        }
    if target_us is not None:
        return {
            "start_us": target_us - 60 * 60 * 1_000_000,
            "end_us": target_us,
            "source": "target_minus_60m",
        }
    return {"start_us": None, "end_us": None, "source": "unknown"}


def _excerpt(text: str, keyword: str, limit: int = 160) -> str:
    compact = " ".join(str(text).split())
    index = compact.lower().find(keyword.lower())
    if index < 0:
        return compact[:limit] + ("…" if len(compact) > limit else "")
    start = max(0, index - 60)
    end = min(len(compact), index + len(keyword) + 90)
    prefix = "…" if start else ""
    suffix = "…" if end < len(compact) else ""
    return prefix + compact[start:end] + suffix


def _keyword_lists(views: dict | None) -> tuple[list[str], list[str]]:
    view_filters = (views or {}).get("filters") or {}
    topic = [str(item).lower() for item in view_filters.get("topic_keywords") or []]
    dictionary = [str(item).lower() for item in view_filters.get("keyword_dictionary") or []]
    merged = list(dict.fromkeys(DEFAULT_TOPIC_KEYWORDS + tuple(topic)))
    return merged, dictionary


def _scan_events(conn, context, cutoff_us: int) -> list[dict]:
    """复用统一筛选：保留用户条件，只把时间截止改成目标窗口之前。"""
    from ..query.filters import FilterContext

    scan = FilterContext(
        dataset="MC1",
        start_us=context.start_us if context else None,
        end_us=cutoff_us,
        categories=list(context.categories) if context else [],
        event_types=list(context.event_types) if context else [],
        actor_id=context.actor_id if context else None,
        participant_id=context.participant_id if context else None,
        channels=list(context.channels) if context else [],
        keyword=context.keyword if context else "",
        cursor_us=None,
        masking=False,
    )
    selection = filters.build_selection(scan)
    if selection.zero:
        return []
    rows = conn.execute(
        "SELECT event_id, source_record_id, time_sort_us, timestamp_raw, event_type, actor_id, "
        "       channel_id, details_json, reply_class "
        "FROM events e WHERE " + selection.where_sql + " ORDER BY time_sort_us",
        selection.params,
    ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        try:
            details = json.loads(row["details_json"] or "{}")
        except json.JSONDecodeError:
            details = {}
        item["details"] = details if isinstance(details, dict) else {}
        items.append(item)
    return items


def _public_scope(channel_id: str | None) -> bool:
    return mc1_context.channel_scope(channel_id) == "public"


def _round_index_for(views: dict, item: dict) -> int | None:
    """event_markers 不一定带 round_index，按轮次区间反推。"""
    if item.get("round_index") is not None:
        return int(item["round_index"])
    if not item.get("timestamp"):
        return None
    moment = mc1_context.parse_epoch_us(item["timestamp"])
    for window in mc1_context._round_bounds(views):  # noqa: SLF001 - 同模块内复用
        if window["start_us"] <= moment < window["end_us"]:
            return window["round_index"]
    return None


def leading_indicators(conn, views: dict | None, target_us: int | None = None, context=None) -> dict:
    incident = _incident_window(views, target_us)
    cutoff = incident["start_us"]
    topic_keywords, _dictionary = _keyword_lists(views)
    candidates: list[dict] = []
    rules: list[dict] = []

    embargo_sources = ["env:9:event_narrative:0", "env:22:event_narrative:0"]
    rules.append(
        {
            "rule_id": "LI-EMBARGO-NAMED-TOPIC",
            "version": RULE_VERSION,
            "description": "解禁前公开渠道出现并购名称、代号或禁发期用语",
            "applies_to": "public channels (personal_post / official_post / anonymous_post)",
            "expected_behavior_source_ids": embargo_sources,
            "expected_basis": "recorded_environment_narrative",
            "keywords": topic_keywords,
            "limitations": (
                "关键词命中只作检索线索，不能直接断言违规或泄露；环境叙事为轮次精度，"
                "不给出精确的制度文本。"
            ),
        }
    )

    if cutoff is not None and views is not None:
        seen = 0
        for item in _scan_events(conn, context, cutoff):
            if not _public_scope(item["channel_id"]):
                continue
            content = str(item["details"].get("content") or "")
            if not content:
                continue
            hits = [keyword for keyword in topic_keywords if keyword in content.lower()]
            if not hits:
                continue
            seen += 1
            if seen > MAX_CANDIDATES:
                break
            candidates.append(
                {
                    "rule_id": "LI-EMBARGO-NAMED-TOPIC",
                    "rule_version": RULE_VERSION,
                    "provenanceKind": "candidate",
                    "event_id": item["event_id"],
                    "context_id": None,
                    "time_us": int(item["time_sort_us"]),
                    "timestamp_raw": item["timestamp_raw"],
                    "actor_id": item["actor_id"],
                    "channel": mc1_context.channel_name(item["channel_id"]),
                    "event_type": item["event_type"],
                    "excerpt": _excerpt(content, hits[0]),
                    "hit_keywords": hits,
                    "expected_basis": "recorded_environment_narrative",
                    "expected_behavior_source_ids": embargo_sources,
                    "source_pointers": [
                        "/rounds/9/environment_context/event_narrative",
                        "/rounds/22/environment_context/event_narrative",
                    ],
                    "similarity": "公开渠道 + 并购主题命中；发生在正式解禁之前",
                    "difference": "未确认该消息是否经过审核，也未证明与实际发布者共享同一内容文件",
                    "limitations": "只说明存在公开提及，不判断主观意图或违规结论。",
                }
            )

    signal_sources = ["anonymous_hint", "env:17:event_narrative:0", "elena_mention"]
    rules.append(
        {
            "rule_id": "LI-PUBLIC-NAMED-SIGNAL",
            "version": RULE_VERSION,
            "description": "目标窗口之前的公开渠道已出现并购主题或“6PM”类时间点暗示",
            "applies_to": "public channels + analyst event_markers(public_signal)",
            "expected_behavior_source_ids": signal_sources,
            "expected_basis": "recorded_environment_narrative",
            "keywords": [],
            "limitations": (
                "匿名帖发布者身份未知，环境叙事只记录“出现公开线索”，不能据此判定是谁泄露。"
            ),
        }
    )

    if views:
        record_to_event = {
            row["source_record_id"]: row["event_id"]
            for row in conn.execute(
                "SELECT event_id, source_record_id FROM events WHERE dataset_id='MC1' "
                "AND source_record_id IS NOT NULL"
            )
        }
        for marker in (views.get("event_markers") or []):
            if marker.get("kind") != "public_signal" or cutoff is None:
                continue
            moment = mc1_context.parse_epoch_us(marker["timestamp"])
            if moment >= cutoff:
                continue
            message_ids = [str(item) for item in marker.get("message_ids") or []]
            evidence_ids = [record_to_event[item] for item in message_ids if item in record_to_event]
            candidates.append(
                {
                    "rule_id": "LI-PUBLIC-NAMED-SIGNAL",
                    "rule_version": RULE_VERSION,
                    "provenanceKind": "candidate",
                    "event_id": evidence_ids[0] if evidence_ids else None,
                    "context_id": marker.get("event_id"),
                    "time_us": moment,
                    "timestamp_raw": marker.get("timestamp"),
                    "actor_id": None,
                    "channel": "public",
                    "event_type": "marker",
                    "excerpt": marker.get("label"),
                    "hit_keywords": [],
                    "evidence_event_ids": evidence_ids,
                    "expected_basis": "recorded_environment_narrative",
                    "expected_behavior_source_ids": signal_sources,
                    "source_pointers": marker.get("source_pointers") or [],
                    "similarity": "公开渠道先出现并购主题/时间点暗示，早于 17:00 外部报道",
                    "difference": "没有记录发布者身份，也没有与目标帖内容文件建立显式引用",
                    "limitations": "环境叙事为轮次精度；同轮共现与文本相似不构成因果。",
                }
            )

    oversight_sources = ["oversight_unavailable"]
    rules.append(
        {
            "rule_id": "LI-OVERSIGHT-GAP",
            "version": RULE_VERSION,
            "description": "监督角色被记录为不可用时，同轮出现公开渠道消息",
            "applies_to": "agent_unavailable markers + public channels",
            "expected_behavior_source_ids": oversight_sources,
            "expected_basis": "recorded_environment_narrative",
            "keywords": [],
            "limitations": "“不可用”来自环境叙事，不等于未履行审核职责；同轮共现不构成因果。",
        }
    )

    markers = (views or {}).get("event_markers") or []
    unavailable = next((item for item in markers if item.get("event_id") == "oversight_unavailable"), None)
    if unavailable and views:
        window = mc1_context.round_window(views, _round_index_for(views, unavailable))
        if window:
            from ..query.filters import FilterContext

            scan = FilterContext(
                dataset="MC1",
                start_us=window["start_us"],
                end_us=window["end_us"],
                cursor_us=None,
                masking=False,
            )
            selection = filters.build_selection(scan)
            rows = conn.execute(
                "SELECT event_id, time_sort_us, timestamp_raw, actor_id, channel_id, event_type "
                "FROM events e WHERE " + selection.where_sql
                + " AND e.channel_id IN ('MC1:channel:personal_post','MC1:channel:official_post',"
                "'MC1:channel:anonymous_post') ORDER BY time_sort_us",
                selection.params,
            ).fetchall()
            by_actor: dict[str, list] = {}
            for row in rows:
                by_actor.setdefault(row["actor_id"], []).append(row)
            for actor_id, group in by_actor.items():
                first = group[0]
                candidates.append(
                    {
                        "rule_id": "LI-OVERSIGHT-GAP",
                        "rule_version": RULE_VERSION,
                        "provenanceKind": "candidate",
                        "event_id": first["event_id"],
                        "context_id": "oversight_unavailable",
                        "time_us": int(first["time_sort_us"]),
                        "timestamp_raw": first["timestamp_raw"],
                        "actor_id": actor_id,
                        "channel": mc1_context.channel_name(first["channel_id"]),
                        "event_type": first["event_type"],
                        "excerpt": f"同轮公开消息 {len(group)} 条",
                        "hit_keywords": [],
                        "evidence_event_ids": [row["event_id"] for row in group],
                        "expected_basis": "recorded_environment_narrative",
                        "expected_behavior_source_ids": oversight_sources,
                        "source_pointers": ["/rounds/17/environment_context/agents_unavailable"],
                        "similarity": "监督角色被记录为不可用的同一轮次出现公开消息",
                        "difference": "没有记录审核流程是否被触发，也没有消息明确请求放行",
                        "limitations": "同轮共现不是绕过审核的证据。",
                    }
                )

    rules.append(
        {
            "rule_id": "LI-REVIEW-BEFORE-PUBLIC",
            "version": RULE_VERSION,
            "description": "公开发布前应存在审核记录",
            "applies_to": "public channels",
            "expected_behavior_source_ids": [],
            "expected_basis": "pending",
            "keywords": [],
            "limitations": (
                "当前数据没有给出适用于该场景的审核制度或指令，因此不生成候选；"
                "界面显示“待确认预期”，不能把“未找到审核消息”判为绕过。"
            ),
        }
    )

    pending_rules = [rule for rule in rules if rule["expected_basis"] == "pending"]
    with_candidates = {candidate["rule_id"] for candidate in candidates}
    return {
        "target_window": incident,
        "scan_scope": "events before target window, filtered by current non-time conditions",
        "rules": rules,
        "candidates": candidates,
        "pending_rules": pending_rules,
        "summary": {
            "candidate_count": len(candidates),
            "rules_with_candidates": len(with_candidates),
            "rule_count": len(rules),
            "pending_rule_count": len(pending_rules),
            "has_evidence_based_candidate": bool(candidates),
        },
        "notes": [
            "候选层不进入已确认统计；每条都带 ruleId、预期依据与局限。",
            "默认排除目标窗口（17:00 外部报道至 18:00 解禁）内的样本，避免把事后记录当先兆。",
            "没有制度依据的规则显示“待确认预期”，不生成候选。",
        ],
    }
