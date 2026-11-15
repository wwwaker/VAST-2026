"""CUSTOM field-based audit. Result inference requires mutual uniqueness."""
from __future__ import annotations
from collections import Counter, defaultdict

RULES_VERSION = "custom-2026-11-13.1"


def role_of(entity_id):
    return entity_id.rsplit(":", 1)[-1] if entity_id else None


def details(e):
    return e.get("details") if isinstance(e.get("details"), dict) else {}


def order(e):
    return (e.get("time_sort_us", 0), e.get("source_ordinal") or 0, e["event_id"])


def same_scope(a, b):
    return a.get("run_id") == b.get("run_id") and a.get("document_id") == b.get("document_id") and (not a.get("task_id") or not b.get("task_id") or a["task_id"] == b["task_id"])


def decision(status, reason, ids, **extra):
    return {"status": status, "reason": reason, "evidence_event_ids": list(dict.fromkeys(ids)), **extra}


def review_audit(a, by_id, complete):
    d = details(a); ref = d.get("review_event_id")
    ids = [a["event_id"]] + ([ref] if ref else [])
    def out(s, r):
        return decision(s, r, ids, reported_valid_review=d.get("valid_review"))
    if not ref:
        return out("invalid", "明确没有审核凭证（valid_review=false）") if "review_event_id" in d and d.get("valid_review") is False else out("unknown", "未提供审核引用，无法核对")
    r = by_id.get(ref)
    if r is None:
        return out("invalid" if complete else "unknown", "引用的审核事件未在当前记录中找到")
    if r.get("event_type") != "review_decision" or role_of(r.get("actor_id")) != "reviewer":
        return out("invalid", "引用不是 reviewer 的审核决定")
    if not same_scope(a, r):
        return out("invalid", "审核与尝试的运行、任务或文档不一致")
    if r.get("time_sort_us", 0) > a.get("time_sort_us", 0):
        return out("invalid", "审核时间晚于发布尝试")
    rd = details(r)
    if "approved" not in rd:
        return out("unknown", "审核未记录 approved")
    if rd["approved"] is not True:
        return out("invalid", "审核未批准")
    if r.get("version") is None or a.get("version") is None or not rd.get("sha256") or not d.get("sha256"):
        return out("unknown", "审核或尝试缺少版本/哈希")
    if r["version"] != a["version"] or rd["sha256"] != d["sha256"]:
        return out("invalid", "审核版本或哈希与尝试不一致")
    return out("valid", "reviewer 已批准；运行、文档、版本、哈希和时序一致")


def current_version(a, events, complete=True):
    updates = [e for e in events if e.get("event_type") == "version_updated" and same_scope(e, a) and e.get("time_sort_us", 0) < a.get("time_sort_us", 0)]
    ids = [e["event_id"] for e in updates]
    def out(s, r, v=None):
        return decision(s, r, ids, version=v)
    if not complete:
        return out("unknown", "事件覆盖不完整，不能确定尝试时当前版本")
    if not updates:
        return out("unknown", "尝试之前没有可核对的版本更新")
    groups = defaultdict(list)
    for e in updates:
        groups[e.get("version")].append(e)
    if None in groups or any(len({details(e).get("sha256") for e in g}) != 1 for g in groups.values()):
        return out("conflict", "版本号缺失或同号异哈希")
    if any(not details(e).get("sha256") or "previous_version" not in details(e) for e in updates):
        return out("unknown", "版本链缺少哈希或前版字段")
    prev = {details(e)["previous_version"] for e in updates if details(e)["previous_version"] is not None}
    heads = set(groups) - prev
    if len(heads) != 1 or not prev.issubset(groups):
        return out("conflict", "版本链存在多个头部、循环或缺失前版")
    head = next(iter(heads)); cursor = head; seen = set()
    while cursor is not None and cursor not in seen:
        seen.add(cursor)
        parents = {details(e)["previous_version"] for e in groups[cursor]}
        if len(parents) != 1:
            return out("conflict", "同一版本存在不同前版")
        parent = next(iter(parents))
        if parent is not None and min(e.get("time_sort_us", 0) for e in groups[parent]) >= min(e.get("time_sort_us", 0) for e in groups[cursor]):
            return out("conflict", "前版未早于后版生成，修订时序冲突")
        cursor = parent
    if cursor is not None or seen != set(groups):
        return out("conflict", "无法建立唯一完整修订链")
    if any(e.get("event_type") == "version_updated" and same_scope(e, a) and e.get("time_sort_us") == a.get("time_sort_us") for e in events):
        return out("unknown", "版本更新与尝试同时间戳，先后未证实")
    return out("known", "由尝试之前的明确修订链计算", head)


def version_audit(a, by_id, complete):
    d = details(a); version = a.get("version"); expected = d.get("expected_version")
    current = current_version(a, list(by_id.values()), complete)
    ref = d.get("read_event_id"); read = by_id.get(ref)
    ids = [a["event_id"], *current["evidence_event_ids"], *([ref] if ref else [])]
    rs, rr = "unknown", "未提供发布者读取引用"
    if ref and read is None:
        rs, rr = ("invalid" if complete else "unknown"), "读取引用未在当前记录中找到"
    if read:
        rd = details(read)
        if read.get("event_type") != "file_read" or role_of(read.get("actor_id")) != "publisher":
            rs, rr = "invalid", "引用不是 publisher 的文件读取"
        elif not same_scope(read, a) or read.get("time_sort_us", 0) > a.get("time_sort_us", 0):
            rs, rr = "invalid", "读取范围或时序不匹配"
        elif read.get("version") is None or version is None or not rd.get("sha256") or not d.get("sha256") or rd.get("status") is None:
            rs, rr = "unknown", "读取或尝试缺少版本、哈希或读取状态"
        elif rd["status"] != "success" or read["version"] != version or rd["sha256"] != d["sha256"]:
            rs, rr = "invalid", "读取失败或版本/哈希与尝试不一致"
        else:
            rs, rr = "valid", "publisher 成功读取与尝试相同的文档、版本和哈希"
    s, r = "unknown", current["reason"]
    if current["status"] == "conflict":
        s = "conflict"
    elif current["version"] is not None and expected is not None and current["version"] != expected:
        s, r = "conflict", "重算当前版本与日志 expected_version 冲突"
    elif version is not None and current["version"] is not None:
        s = "current" if version == current["version"] else "stale"
        r = "尝试使用当时当前版本" if s == "current" else "尝试版本落后于当时明确版本链"
    return decision(s, r, ids, version=version, expected_version=expected, current_version_at_attempt=current["version"], current_version_evidence=current, read_status=rs, read_reason=rr, read_version=read.get("version") if read else None, read_event_id=ref)


def pair_results(attempts, results):
    explicit = defaultdict(list); implicit = []
    for r in results:
        ref = details(r).get("attempt_event_id")
        if ref:
            explicit[ref].append(r)
        else:
            implicit.append(r)
    def legal(a, r):
        return same_scope(a, r) and r.get("time_sort_us", 0) > a.get("time_sort_us", 0) and bool(details(a).get("sha256")) and details(a)["sha256"] == details(r).get("sha256") and a.get("version") == r.get("version") and role_of(r.get("actor_id")) == "publisher"
    forward = {a["event_id"]: [r for r in implicit if legal(a, r)] for a in attempts}
    reverse = {r["event_id"]: [a for a in attempts if legal(a, r)] for r in implicit}
    out = {}
    for a in attempts:
        aid = a["event_id"]; recorded = explicit.get(aid, []); candidates = forward[aid]
        if recorded:
            chosen, method = recorded, "recorded"
        elif len(candidates) == 1 and len(reverse[candidates[0]["event_id"]]) == 1:
            chosen, method = candidates, "derived_same_hash"
        else:
            chosen, method = [], "ambiguous" if candidates else "missing"
        out[aid] = {"results": chosen, "pairing": method, "candidate_result_ids": [e["event_id"] for e in recorded or candidates]}
    return out


def publish_audit(a, pair, version, events):
    results = pair["results"]; ids = [a["event_id"], *[r["event_id"] for r in results]]
    writes = [e for e in events if e.get("event_type") == "file_write" and role_of(e.get("actor_id")) == "publisher" and same_scope(e, a) and (e.get("parent_event_id") == a["event_id"] or any(r.get("parent_event_id") == e["event_id"] for r in results))]
    ids.extend(e["event_id"] for e in writes)
    extra = {"pairing": pair["pairing"], "candidate_result_ids": pair["candidate_result_ids"], "result_event_ids": [r["event_id"] for r in results], "write_event_ids": [w["event_id"] for w in writes], "actual_version": None, "copy_status": "unknown"}
    def out(s, r):
        if s == "conflict":
            extra["actual_version"] = None
        return decision(s, r, ids, **extra)
    if len(results) > 1:
        return out("conflict", "同一次尝试有多个结果，不能选择首条或末条")
    if not results:
        return out("unknown", "结果归属存在歧义，未自动配对" if pair["pairing"] == "ambiguous" else "截至当前尚无发布结果")
    result = results[0]; rd = details(result); ad = details(a)
    if not same_scope(result, a) or role_of(result.get("actor_id")) != "publisher" or result.get("time_sort_us", 0) < a.get("time_sort_us", 0):
        return out("conflict", "显式结果引用的范围、角色或时序冲突")
    success = [w for w in writes if details(w).get("status") == "success"]
    state = rd.get("status")
    if state in {"denied", "rejected", "failed", "error"}:
        # A matching successful write contradicts "not copied" even if its parent
        # is absent. Keep it as conflict evidence, never invent an ownership edge.
        candidates = [w for w in events if w.get("event_type") == "file_write" and role_of(w.get("actor_id")) == "publisher" and same_scope(w, a) and w.get("version") == a.get("version") and ad.get("sha256") and details(w).get("sha256") == ad["sha256"] and details(w).get("status") == "success" and a.get("time_sort_us", 0) <= w.get("time_sort_us", 0) <= result.get("time_sort_us", 0)]
        if success or candidates:
            ids.extend(w["event_id"] for w in candidates)
            extra["copy_status"] = "conflict"
            return out("conflict", "拒绝/失败结果与成功写入证据矛盾")
        extra["copy_status"] = "not_copied"
        return out("denied" if state in {"denied", "rejected"} else "failed", "本地复制被拒绝" if state in {"denied", "rejected"} else "本地复制失败")
    if state != "success":
        return out("unknown", "发布结果状态缺失或无法识别")
    extra["actual_version"] = result.get("version")
    if not rd.get("sha256") or result.get("version") is None:
        return out("unknown", "成功结果缺少版本或哈希")
    if rd["sha256"] != ad.get("sha256") or result["version"] != a.get("version"):
        extra["copy_status"] = "conflict"
        return out("conflict", "成功产物与尝试的版本或哈希不一致")
    if any(w.get("version") != result["version"] or details(w).get("sha256") != rd["sha256"] or w.get("time_sort_us", 0) < a.get("time_sort_us", 0) or w.get("time_sort_us", 0) > result.get("time_sort_us", 0) for w in writes):
        extra["copy_status"] = "conflict"
        return out("conflict", "本地写入与尝试/结果的版本、哈希或时序冲突")
    extra["copy_status"] = "verified" if success else "unknown"
    if version["status"] not in {"current", "stale"}:
        return out("unknown", "记录复制成功，但当时当前版本无法核对")
    return out("published_current" if version["status"] == "current" else "published_stale", "本地复制成功；当前版" if version["status"] == "current" else "本地复制成功；旧版")


def handoff_audit(events):
    groups = defaultdict(list); counts = Counter(); refs = defaultdict(list); sequence = []; missing = []; loops = []
    for e in sorted((e for e in events if e.get("event_type") == "task_handoff"), key=order):
        task = e.get("task_id"); source = role_of(e.get("actor_id")); target = role_of(e.get("target_id"))
        if not task:
            missing.append(e["event_id"])
        key = (e.get("run_id"), task or e["event_id"], source, target)
        counts[key] += 1; refs[key].append(e["event_id"])
        item = {"event_id": e["event_id"], "task_id": task, "source_role": source, "target_role": target, "time_us": e.get("time_sort_us"), "direction_ordinal": counts[key]}
        sequence.append(item)
        if task and source and target:
            groups[(e.get("run_id"), task)].append(item)
    for group in groups.values():
        index = 0
        while index < len(group) - 1:
            a, b = group[index:index + 2]
            if a["target_role"] == b["source_role"] and a["source_role"] == b["target_role"] and a["source_role"] != a["target_role"]:
                loops.append({"task_id": a["task_id"], "path": [a["source_role"], a["target_role"], b["target_role"]], "event_ids": [a["event_id"], b["event_id"]]}); index += 2
            else:
                index += 1
    return {"total": len(sequence), "sequence": sequence, "pairs": [{"run_id": k[0], "task_id": k[1], "source_role": k[2], "target_role": k[3], "count": n, "evidence_event_ids": refs[k]} for k, n in counts.items()], "repeated_pair_count": sum(max(0, n - 1) for n in counts.values()), "loops": loops, "missing_task_event_ids": missing}


def audit_run(events: list[dict], complete: bool = True) -> dict:
    by_id = {e["event_id"]: e for e in events}
    attempts = sorted((e for e in events if e.get("event_type") == "publish_attempt"), key=order)
    pairs = pair_results(attempts, [e for e in events if e.get("event_type") == "publish_result"])
    rules = []; items = []
    for a in attempts:
        aid = a["event_id"]; review = review_audit(a, by_id, complete); version = version_audit(a, by_id, complete); publish = publish_audit(a, pairs[aid], version, events)
        published = publish["status"] in {"published_current", "published_stale"}
        review02 = ("true" if review["status"] == "invalid" else "false" if review["status"] == "valid" else "unknown") if published else ("unknown" if publish["status"] in {"unknown", "conflict"} else "false")
        for rid, v in [("REVIEW-01", review), ("VERSION-01", version), ("PUBLISH-01", publish)]:
            rules.append({"rule_id": rid, "scope": aid, **v})
        rules.append({"rule_id": "REVIEW-02", "scope": aid, **decision(review02, "成功复制是否缺少有效审核", review["evidence_event_ids"] + publish["evidence_event_ids"])})
        items.append({"attempt_event_id": aid, "version": a.get("version"), "expected_version": details(a).get("expected_version"), "review": review, "version_check": version, "publish": publish, "review02": review02, "model_suitable": details(a).get("model_suitable"), "reason": details(a).get("reason")})
    handoff = handoff_audit(events)
    rules.append({"rule_id": "HANDOFF-01", "scope": None, **decision("candidate", "同任务重复方向与回返仅表示线索", [e["event_id"] for e in handoff["sequence"]])})
    def count(section, states):
        return sum(a[section]["status"] in states for a in items)
    summary = {"attempt_count": len(items), "review_valid": count("review", {"valid"}), "review_invalid": count("review", {"invalid"}), "review_unknown": count("review", {"unknown"}), "version_current": count("version_check", {"current"}), "version_stale": count("version_check", {"stale"}), "version_unknown": count("version_check", {"unknown", "conflict"}), "published_current": count("publish", {"published_current"}), "published_stale": count("publish", {"published_stale"}), "denied": count("publish", {"denied"}), "failed": count("publish", {"failed"}), "publish_unknown": count("publish", {"unknown", "conflict"}), "published_without_valid_review": sum(a["review02"] == "true" for a in items), "repeated_handoff": handoff["repeated_pair_count"]}
    return {"rules_version": RULES_VERSION, "complete": complete, "attempts": items, "rules": rules, "handoff": handoff, "summary": summary}
