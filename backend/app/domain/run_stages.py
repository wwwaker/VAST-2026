"""Shared CUSTOM stage rules. Classification uses exact types and actor roles, never names.

Offsets and duration describe first/last recorded event, not inferred execution time.
"""
from __future__ import annotations
from collections import defaultdict
from . import custom_audit

STAGE_RULES_VERSION = "1"

STAGES = [
    ("start", "运行开始"),
    ("research", "研究/读取 fixture"),
    ("write", "写作与版本"),
    ("review", "提交与审核"),
    ("publisher_read", "发布者读取"),
    ("attempt", "发布尝试"),
    ("result", "发布结果"),
]

def stage_of(event: dict) -> str | None:
    event_type = event["event_type"]
    role = custom_audit.role_of(event.get("actor_id"))
    if event_type == "run_started":
        return "start"
    if event_type == "file_read":
        if role == "researcher":
            return "research"
        if role == "publisher":
            return "publisher_read"
        return None
    if event_type in {"file_write", "version_updated"}:
        return "write"
    if event_type in {"submit_review", "review_decision"}:
        return "review"
    if event_type == "publish_attempt":
        return "attempt"
    if event_type == "publish_result":
        return "result"
    return None


def stage_payload(events: list[dict]) -> dict:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for event in events:
        stage = stage_of(event)
        if stage:
            grouped[stage].append(event)
    return grouped


def stage_summary(events: list[dict], start_us: int | None) -> dict:
    if not events:
        return {"count": 0, "event_ids": [], "start_offset_us": None, "duration_us": None}
    first = min(event["time_sort_us"] for event in events)
    last = max(event["time_sort_us"] for event in events)
    return {
        "count": len(events),
        "event_ids": [event["event_id"] for event in events],
        "start_offset_us": (first - start_us) if start_us is not None else None,
        "duration_us": last - first,
        "actors": sorted({custom_audit.role_of(event.get("actor_id")) or "unknown" for event in events}),
    }



def summarize_run(events: list[dict], start_us: int | None, *, complete: bool) -> list[dict]:
    grouped = stage_payload(events)
    result = []
    for key, _label in STAGES:
        if not complete:
            result.append({"key": key, "state": "unknown", "count": None,
                           "start_offset_us": None, "duration_us": None, "sample_event_ids": []})
            continue
        summary = stage_summary(grouped.get(key, []), start_us)
        result.append({"key": key, "state": "recorded" if summary["count"] else "no_record",
                       "count": summary["count"], "start_offset_us": summary["start_offset_us"],
                       "duration_us": summary["duration_us"], "sample_event_ids": summary["event_ids"][:3]})
    return result
