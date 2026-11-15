"""Event display projection shared by query and HTTP layers."""
import json
from app.domain import event_types
from app.domain.mc2.reading import summary as mc2_summary

PREVIEW_KEYS = ("content", "subject", "title", "reason", "feedback", "purpose")


def _preview(details_json: str | None, limit: int = 180) -> str:
    """事件流摘要。先按已知语义取值，取不到再用键值对回落，避免整列都是“无摘要”。"""
    if not details_json:
        return ""
    try:
        details = json.loads(details_json)
    except json.JSONDecodeError:
        return ""
    if not isinstance(details, dict) or not details:
        return ""

    def clip(text: str) -> str:
        text = " ".join(str(text).split())
        return text[:limit] + ("…" if len(text) > limit else "")

    for key in PREVIEW_KEYS:
        value = details.get(key)
        if isinstance(value, str) and value:
            return clip(value)

    # 委派型：{target_agent, task, args:{path}}
    if isinstance(details.get("task"), str):
        agent = details.get("target_agent") or details.get("task_agent")
        args = details.get("args")
        path = args.get("path") if isinstance(args, dict) else None
        tail = f" → {path}" if isinstance(path, str) and path else ""
        return clip(f"[任务] {details['task']}{' → ' + str(agent) if agent else ''}{tail}")

    if isinstance(details.get("content_source"), str):
        return clip(f"[内容源] {details['content_source']}")

    if isinstance(details.get("action"), str):
        return clip(f"[动作] {details['action']} → {details.get('target', '—')}")

    # 回落：拼前若干个短标量（跳过哈希、长路径这类占满整行的值）
    parts: list[str] = []
    for key, value in details.items():
        if isinstance(value, (str, int, float, bool)):
            text = str(value)
            if text and len(text) <= 48:
                parts.append(f"{key}={text}")
        if len(parts) >= 3:
            break
    return clip(" · ".join(parts)) if parts else ""


def summarize(row, dataset: str, annotations: list[dict]) -> dict:
    return {
        "event_id": row["event_id"],
        "timestamp": row["timestamp_normalized"],
        "timestamp_raw": row["timestamp_raw"],
        "time_us": row["time_sort_us"],
        "timezone_status": row["timezone_status"],
        "event_type": row["event_type"],
        "category": event_types.category_of(dataset, row["event_type"]),
        "actor_id": row["actor_id"],
        "actor_label": row["actor_label"],
        "actor_rule": row["actor_rule"],
        "run_id": row["run_id"],
        "version": row["version"],
        "document_id": row["document_id"],
        "channel_id": row["channel_id"],
        "preview": mc2_summary(row["event_type"], row["details_json"]) if dataset == "MC2" else _preview(row["details_json"]),
        "has_deliberation": bool(row["has_deliberation"]),
        "source_missing_id": bool(row["source_missing_id"]),
        "annotations": annotations,
    }


def load_annotations(conn, dataset: str, event_ids: list[str]) -> dict[str, list[dict]]:
    annotations: dict[str, list[dict]] = {}
    if not event_ids:
        return annotations
    placeholders = ",".join("?" * len(event_ids))
    for anno in conn.execute(
        "SELECT ae.event_id, a.scenario, a.anomaly_type, a.observed, a.reason, a.run_id "
        f"FROM annotation_events ae JOIN annotations a ON a.annotation_id=ae.annotation_id "
        f"WHERE ae.dataset_id=? AND ae.event_id IN ({placeholders})",
        [dataset, *event_ids],
    ):
        annotations.setdefault(anno["event_id"], []).append(
            {
                "scenario": anno["scenario"],
                "anomaly_type": anno["anomaly_type"],
                "observed": bool(anno["observed"]),
                "reason": anno["reason"],
                "run_id": anno["run_id"],
            }
        )
    return annotations
