"""Deterministic evidence projection; every edge retains its actual field basis."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
from functools import lru_cache
from .custom_audit import details, order, role_of, same_scope, audit_run, RULES_VERSION
from ..config import ROOT

PROJECTION_VERSION = "custom-projection-1"


def coverage(events, expected):
    ids = {e["event_id"] for e in events}
    missing = []
    for e in events:
        for field in ("parent_event_id",):
            ref = e.get(field)
            if ref and ref not in ids:
                missing.append({"event_id": e["event_id"], "field": field, "reference": ref})
        for field in ("review_event_id", "read_event_id", "attempt_event_id"):
            ref = details(e).get(field)
            if ref and ref not in ids:
                missing.append({"event_id": e["event_id"], "field": "details." + field, "reference": ref})
    boundary = any(e["event_type"] == "run_started" for e in events) and any(e["event_type"] == "run_finished" for e in events)
    return {"expected_events": expected, "returned_events": len(events), "truncated": len(events) < expected,
            "boundaries_present": boundary, "missing_references": missing,
            "complete": len(events) == expected and boundary and not missing}


@lru_cache(maxsize=96)
def _raw_index(run_id, stamp):
    path = Path(ROOT) / "data/raw/custom_dataset" / run_id / "events.jsonl"
    if not path.is_file():
        return {}
    return {e["event_id"]: {"raw": e, "line": i} for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1) if line.strip() for e in [json.loads(line)]}


def raw_index(run_id):
    if not run_id or Path(run_id).name != run_id:
        return {}
    path = Path(ROOT) / "data/raw/custom_dataset" / run_id / "events.jsonl"
    return _raw_index(run_id, path.stat().st_mtime_ns if path.is_file() else 0)


def attachment_status(run_id, location):
    # Data paths are untrusted. Never read a supplied absolute or escaping path.
    bases = [Path(ROOT) / "data/raw/custom_dataset" / run_id, Path(ROOT) / "data/raw/custom_dataset"]
    for base in bases:
        candidate = (base / location).resolve()
        if candidate.is_relative_to(base.resolve()) and candidate.is_file():
            try:
                digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
            except OSError:
                return {"location": location, "exists": True, "readable": False, "sha256": None}
            return {"location": location, "exists": True, "readable": True, "sha256": digest}
    return {"location": location, "exists": False, "readable": False, "sha256": None}


def project(events, expected, data_version, audit=None):
    events = sorted(events, key=order)
    cov = coverage(events, expected)
    audit = audit or audit_run(events, cov["complete"])
    by_id = {e["event_id"]: e for e in events}
    run_id = events[0].get("run_id") if events else None
    originals = raw_index(run_id)
    nodes, edges, attachments = [], [], {}
    def edge(source, target, relation, field, refs, recorded=True):
        edges.append({"id": f"{source}|{relation}|{target}", "source": source, "target": target,
                      "relation": relation, "field": field, "recorded": recorded, "source_event_ids": refs})
    def node(e, kind, label):
        return {"id": e["event_id"], "kind": kind, "label": label, "version": e.get("version"),
                "document_id": e.get("document_id"), "time_us": e.get("time_sort_us"), "role": role_of(e.get("actor_id")),
                "details": details(e), "source_event_ids": [e["event_id"]], "target_id": e.get("target_id")}
    versions = []
    for e in events:
        if e["event_type"] != "version_updated":
            continue
        d = details(e)
        vid = f"version:{e.get('target_id') or e.get('document_id')}:{e.get('version')}:{d.get('sha256')}"
        existing = next((v for v in versions if v["id"] == vid), None)
        if existing:
            existing["source_event_ids"].append(e["event_id"])
            continue
        v = node(e, "version", f"v{e.get('version')}")
        v.update(id=vid, hash=d.get("sha256"), previous_version=d.get("previous_version"), entity_id=e.get("target_id"))
        write = by_id.get(e.get("parent_event_id"))
        if write and write["event_type"] == "file_write" and role_of(write.get("actor_id")) == "writer" and write.get("target_id") == e.get("target_id"):
            v["source_event_ids"].insert(0, write["event_id"])
            v["path"] = details(write).get("path")
        else:
            v["path"] = None
        v["content"] = attachment_status(run_id, v["path"]) if v["path"] else {"exists": False, "readable": False, "location": None, "sha256": None}
        versions.append(v)
    nodes.extend(versions)
    for v in versions:
        prev = [p for p in versions if p["document_id"] == v["document_id"] and p["version"] == v["previous_version"]]
        if len(prev) == 1:
            edge(prev[0]["id"], v["id"], "修订", "version_updated.details.previous_version", v["source_event_ids"])
    for e in events:
        kind = {"review_decision": "review", "workflow_route": "route", "publish_attempt": "attempt", "publish_result": "result"}.get(e["event_type"])
        if e["event_type"] == "file_read" and role_of(e.get("actor_id")) == "publisher":
            kind = "read"
        if e["event_type"] == "file_write" and role_of(e.get("actor_id")) == "publisher":
            kind = "copy"
        if not kind:
            continue
        d = details(e)
        label = {"review": "审核批准" if d.get("approved") is True else "审核拒绝" if d.get("approved") is False else "审核未知",
                 "read": "发布者读取", "route": "流程选择", "attempt": "发布尝试", "copy": "本地写入",
                 "result": {"success": "复制成功", "denied": "拒绝", "rejected": "拒绝", "failed": "失败"}.get(d.get("status"), "结果未知")}[kind]
        nodes.append(node(e, kind, label))
        if kind in {"review", "read", "attempt"}:
            vs = [v for v in versions if v["entity_id"] == e.get("target_id") and v["version"] == e.get("version") and v["hash"] == d.get("sha256")]
            if len(vs) == 1:
                edge(vs[0]["id"], e["event_id"], {"review": "审核此版", "read": "读取此版", "attempt": "尝试此版"}[kind], "target_id + version + details.sha256", [e["event_id"]])
        if kind == "route":
            vs = [v for v in versions if v["document_id"] == e.get("document_id") and v["version"] == d.get("selected_version")]
            if len(vs) == 1:
                edge(e["event_id"], vs[0]["id"], "流程选用", "workflow_route.details.selected_version + document_id", [e["event_id"]])
    node_ids = {n["id"] for n in nodes}
    for a in audit["attempts"]:
        attempt = by_id[a["attempt_event_id"]]
        for field, relation in [("review_event_id", "审核引用"), ("read_event_id", "读取引用")]:
            ref = details(attempt).get(field)
            if ref in node_ids:
                edge(ref, attempt["event_id"], relation, "publish_attempt.details." + field, [attempt["event_id"], ref])
        for rid in a["publish"]["result_event_ids"]:
            edge(attempt["event_id"], rid, "结果引用" if a["publish"]["pairing"] == "recorded" else "双向唯一匹配", "publish_result.details.attempt_event_id" if a["publish"]["pairing"] == "recorded" else "same run/task/document/version/hash + time + mutual uniqueness", [attempt["event_id"], rid], a["publish"]["pairing"] == "recorded")
        for wid in a["publish"]["write_event_ids"]:
            w = by_id[wid]
            if w.get("parent_event_id") == attempt["event_id"]:
                edge(attempt["event_id"], wid, "写入来源记录", "file_write.parent_event_id", [attempt["event_id"], wid])
            for rid in a["publish"]["result_event_ids"]:
                if by_id[rid].get("parent_event_id") == wid:
                    edge(wid, rid, "结果来源记录", "publish_result.parent_event_id", [wid, rid])
    calls = []
    finishes = set()
    for e in events:
        if e["event_type"] != "agent_call_finished":
            continue
        start = by_id.get(e.get("parent_event_id"))
        valid = bool(start and start["event_type"] == "agent_call_started" and start.get("actor_id") == e.get("actor_id") and same_scope(start, e) and start.get("time_sort_us", 0) <= e.get("time_sort_us", 0))
        if valid:
            finishes.add(start["event_id"])
        msgs = [m["event_id"] for m in events if m["event_type"] == "agent_message" and m.get("parent_event_id") == e["event_id"]]
        calls.append({"role": role_of(e.get("actor_id")), "started_event_id": start["event_id"] if valid else None, "finished_event_id": e["event_id"],
                      "start_us": start["time_sort_us"] if valid else None, "end_us": e["time_sort_us"], "duration_ms": details(e).get("duration_ms"),
                      "status": details(e).get("status"), "unpaired": not valid, "source_event_ids": ([start["event_id"]] if valid else []) + [e["event_id"], *msgs]})
    for e in events:
        if e["event_type"] == "agent_call_started" and e["event_id"] not in finishes:
            calls.append({"role": role_of(e.get("actor_id")), "started_event_id": e["event_id"], "finished_event_id": None, "start_us": e["time_sort_us"], "end_us": None, "duration_ms": None, "status": "unknown", "unpaired": True, "source_event_ids": [e["event_id"]]})
    projected_events = []
    for e in events:
        original = originals.get(e["event_id"])
        location = details(original["raw"]).get("evidence") if original else None
        if isinstance(location, str):
            if location not in attachments:
                attachments[location] = {**attachment_status(run_id, location), "event_ids": []}
            attachments[location]["event_ids"].append(e["event_id"])
        projected_events.append({"event_id": e["event_id"], "event_type": e["event_type"], "time_us": e.get("time_sort_us"), "role": role_of(e.get("actor_id")),
                                 "actor_id": e.get("actor_id"), "target_id": e.get("target_id"), "task_id": e.get("task_id"), "run_id": e.get("run_id"), "version": e.get("version"),
                                 "document_id": e.get("document_id"), "parent_event_id": e.get("parent_event_id"), "details": details(e), "ordinal": e.get("source_ordinal"),
                                 "raw_source": {"path": f"data/raw/custom_dataset/{run_id}/events.jsonl" if original else "data/process/custom_dataset/events.jsonl", "line": original["line"] if original else e.get("source_ordinal")},
                                 "attachment": attachments.get(location), "original": original["raw"] if original else None})
    return {"projection_version": PROJECTION_VERSION, "rules_version": RULES_VERSION, "data_version": data_version,
            "coverage": cov, "content_availability": {"version_bodies": sum(v["content"]["exists"] for v in versions), "versions": len(versions), "call_attachments": sum(a["exists"] for a in attachments.values()), "referenced_call_attachments": len(attachments)},
            "attachments": list(attachments.values()), "versions": versions, "nodes": nodes, "edges": edges, "events": projected_events, "calls": calls, "audit": audit}
