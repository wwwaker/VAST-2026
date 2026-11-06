"""自建工作流的运行级审计（纯函数，便于单元测试）。

审计结论从事件字段重算，不沿用 labels 的 observed；两者并列保存。
每次 publish_attempt 独立计算，不假设每 run 只有一次尝试。

规则：
- REVIEW-01：审核凭证是否真实、同文档、同版本、同哈希、且早于发布尝试。
- VERSION-01：发布尝试的 version 与 expected_version 是否一致，并回查 publisher 读取。
- PUBLISH-01：结果是否成功，成功时发布的是当前版本还是旧版本。
- REVIEW-02：成功发布关联的尝试是否缺少有效审核。
- HANDOFF-01：同一任务内的重复交接与 A→B→A 回返线索。
"""

from __future__ import annotations

from collections import Counter, defaultdict


def role_of(entity_id: str | None) -> str | None:
    if not entity_id:
        return None
    return entity_id.rsplit(":", 1)[-1]


def _details(event: dict) -> dict:
    value = event.get("details")
    return value if isinstance(value, dict) else {}


def _event_id(event: dict) -> str:
    return event["event_id"]


def _review_audit(attempt: dict, by_id: dict[str, dict]) -> dict:
    details = _details(attempt)
    evidence = [_event_id(attempt)]
    if "review_event_id" not in details:
        return {
            "status": "unknown",
            "reason": "载荷未记录 review_event_id 字段",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }
    ref = details.get("review_event_id")
    if not ref:
        # 明确记录“没有审核凭证”属于已记录的否定事实，不能和“字段缺失”混为 unknown
        if details.get("valid_review") is False:
            return {
                "status": "invalid",
                "reason": "没有审核凭证（valid_review=false）",
                "evidence_event_ids": evidence,
                "reported_valid_review": False,
            }
        return {
            "status": "unknown",
            "reason": "未记录 review_event_id",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }
    review = by_id.get(ref)
    evidence.append(str(ref))
    if review is None:
        return {
            "status": "invalid",
            "reason": "引用的审核事件不存在",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }

    review_details = _details(review)
    if review.get("run_id") != attempt.get("run_id"):
        return {
            "status": "invalid",
            "reason": "审核事件不属于同一运行",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }
    if review.get("document_id") != attempt.get("document_id"):
        return {
            "status": "invalid",
            "reason": "审核事件指向其他文档",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }
    if "approved" not in review_details:
        return {
            "status": "unknown",
            "reason": "审核未记录 approved 字段",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }
    if review_details.get("approved") is not True:
        return {
            "status": "invalid",
            "reason": "审核未批准",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }
    if review.get("time_sort_us", 0) > attempt.get("time_sort_us", 0):
        return {
            "status": "invalid",
            "reason": "审核时间晚于发布尝试",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }

    review_hash = review_details.get("sha256")
    attempt_hash = details.get("sha256")
    if not review_hash or not attempt_hash:
        return {
            "status": "unknown",
            "reason": "审核或发布尝试缺少 sha256",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }
    if review_hash != attempt_hash:
        return {
            "status": "invalid",
            "reason": "审核哈希与发布版本不一致（审核了别的版本）",
            "evidence_event_ids": evidence,
            "reported_valid_review": details.get("valid_review"),
        }
    if review.get("version") is not None and attempt.get("version") is not None:
        if review.get("version") != attempt.get("version"):
            return {
                "status": "invalid",
                "reason": "审核版本与发布版本不一致",
                "evidence_event_ids": evidence,
                "reported_valid_review": details.get("valid_review"),
            }
    return {
        "status": "valid",
        "reason": "同运行、同文档、已批准、哈希与版本一致且早于发布",
        "evidence_event_ids": evidence,
        "reported_valid_review": details.get("valid_review"),
    }


def _version_audit(attempt: dict, by_id: dict[str, dict]) -> dict:
    details = _details(attempt)
    expected = details.get("expected_version")
    version = attempt.get("version")
    evidence = [_event_id(attempt)]

    read_ref = details.get("read_event_id")
    read = by_id.get(read_ref) if read_ref else None
    read_status = "unknown"
    read_reason = "未记录 read_event_id"
    if read_ref:
        evidence.append(str(read_ref))
    if read is not None:
        read_details = _details(read)
        if read.get("run_id") != attempt.get("run_id"):
            read_status, read_reason = "invalid", "读取事件不属于同一运行"
        elif read.get("document_id") != attempt.get("document_id"):
            read_status, read_reason = "invalid", "读取事件指向其他文档"
        elif read.get("time_sort_us", 0) > attempt.get("time_sort_us", 0):
            read_status, read_reason = "invalid", "读取时间晚于发布尝试"
        elif read_details.get("sha256") and details.get("sha256") is None:
            read_status, read_reason = "unknown", "发布尝试缺少哈希，无法比对读取"
        elif (
            read_details.get("sha256")
            and details.get("sha256")
            and read_details.get("sha256") != details.get("sha256")
        ):
            read_status, read_reason = "invalid", "发布者读取的哈希与待发布版本不一致"
        else:
            read_status, read_reason = "valid", "读取事件与发布尝试同运行、同文档、哈希一致"

    if version is None or expected is None:
        return {
            "status": "unknown",
            "reason": "缺少 version 或 expected_version",
            "version": version,
            "expected_version": expected,
            "read_status": read_status,
            "read_reason": read_reason,
            "evidence_event_ids": evidence,
        }
    if version == expected:
        return {
            "status": "current",
            "reason": "发布尝试使用的是当前版本",
            "version": version,
            "expected_version": expected,
            "read_status": read_status,
            "read_reason": read_reason,
            "evidence_event_ids": evidence,
        }
    return {
        "status": "stale",
        "reason": "发布尝试版本与 expected_version 不一致",
        "version": version,
        "expected_version": expected,
        "read_status": read_status,
        "read_reason": read_reason,
        "evidence_event_ids": evidence,
    }


def _publish_audit(attempt: dict, result: dict | None, pairing: str) -> dict:
    details = _details(attempt)
    evidence = [_event_id(attempt)]
    if result is None:
        return {
            "status": "unknown",
            "reason": "截至当前尚无发布结果",
            "evidence_event_ids": evidence,
            "pairing": pairing,
        }
    evidence.append(_event_id(result))
    result_details = _details(result)
    status_field = result_details.get("status")
    if status_field in {"denied", "rejected"}:
        return {
            "status": "denied",
            "reason": "发布被拒绝",
            "evidence_event_ids": evidence,
            "pairing": pairing,
        }
    if status_field in {"failed", "error"}:
        return {
            "status": "failed",
            "reason": "发布失败",
            "evidence_event_ids": evidence,
            "pairing": pairing,
        }
    if status_field != "success":
        return {
            "status": "unknown",
            "reason": f"未知发布结果状态：{status_field}",
            "evidence_event_ids": evidence,
            "pairing": pairing,
        }

    result_version = result.get("version")
    result_hash = result_details.get("sha256")
    if result_version is None or not result_hash:
        return {
            "status": "unknown",
            "reason": "成功结果缺少版本或哈希",
            "evidence_event_ids": evidence,
            "pairing": pairing,
        }

    # “当前/旧版”以 expected_version 为准：成功发出旧版仍是 published_stale
    expected = details.get("expected_version")
    target = expected if expected is not None else attempt.get("version")
    if target is None:
        return {
            "status": "unknown",
            "reason": "缺少 expected_version，无法判断发布的是否为当前版本",
            "evidence_event_ids": evidence,
            "pairing": pairing,
        }
    if result_version != target:
        return {
            "status": "published_stale",
            "reason": f"成功发布的版本 {result_version} 不是期望版本 {target}",
            "evidence_event_ids": evidence,
            "pairing": pairing,
        }
    if result_hash != details.get("sha256"):
        return {
            "status": "published_stale",
            "reason": "成功发布的哈希与发布尝试不一致",
            "evidence_event_ids": evidence,
            "pairing": pairing,
        }
    return {
        "status": "published_current",
        "reason": "成功发布当前版本",
        "evidence_event_ids": evidence,
        "pairing": pairing,
    }


def _handoff_audit(events: list[dict]) -> dict:
    handoffs = sorted(
        (event for event in events if event.get("event_type") == "task_handoff"),
        key=lambda event: event.get("time_sort_us", 0),
    )
    counts: Counter[tuple[str, str]] = Counter()
    evidence: dict[tuple[str, str], list[str]] = defaultdict(list)
    sequence: list[tuple[str, str, str, int]] = []
    for event in handoffs:
        source = role_of(event.get("actor_id"))
        target = role_of(event.get("target_id"))
        if not source or not target:
            continue
        counts[(source, target)] += 1
        evidence[(source, target)].append(_event_id(event))
        sequence.append((source, target, _event_id(event), event.get("time_sort_us", 0)))

    repeated = sum(max(0, count - 1) for count in counts.values())
    loops = []
    index = 0
    # 相邻的 A→B→A→B 会产生两个重叠窗口；按不重叠的顺序记录，避免同一回返被算两次
    while index < len(sequence) - 1:
        first = sequence[index]
        second = sequence[index + 1]
        if first[1] == second[0] and second[1] == first[0] and first[0] != first[1]:
            loops.append(
                {
                    "path": [first[0], first[1], second[1]],
                    "event_ids": [first[2], second[2]],
                }
            )
            index += 2
        else:
            index += 1
    return {
        "total": len(handoffs),
        "pairs": [
            {"source_role": source, "target_role": target, "count": count, "evidence_event_ids": evidence[(source, target)]}
            for (source, target), count in counts.items()
        ],
        "repeated_pair_count": repeated,
        "loops": loops,
    }


def audit_run(events: list[dict]) -> dict:
    """按每次 publish_attempt 重算，输出规则状态与证据。"""
    by_id = {_event_id(event): event for event in events}
    attempts = sorted(
        (event for event in events if event.get("event_type") == "publish_attempt"),
        key=lambda event: event.get("time_sort_us", 0),
    )
    results = [event for event in events if event.get("event_type") == "publish_result"]
    explicit: dict[str, dict] = {}
    claimed: set[str] = set()
    for event in results:
        ref = _details(event).get("attempt_event_id")
        if ref:
            explicit[str(ref)] = event
            claimed.add(_event_id(event))

    rules = []
    attempts_out = []
    for attempt in attempts:
        review = _review_audit(attempt, by_id)
        version = _version_audit(attempt, by_id)

        attempt_id = _event_id(attempt)
        result = explicit.get(attempt_id)
        pairing = "recorded"
        if result is None:
            # 少数 denied 结果没有 attempt_event_id；只在同 run/同文档/同哈希且唯一时配对，
            # 并把 pairing 标为派生，避免把相邻时间硬当成因果。
            attempt_hash = _details(attempt).get("sha256")
            candidates = [
                event
                for event in results
                if _event_id(event) not in claimed
                and event.get("run_id") == attempt.get("run_id")
                and event.get("document_id") == attempt.get("document_id")
                and event.get("time_sort_us", 0) > attempt.get("time_sort_us", 0)
                and attempt_hash
                and _details(event).get("sha256") == attempt_hash
            ]
            if len(candidates) == 1:
                result = candidates[0]
                pairing = "derived_same_hash"
                claimed.add(_event_id(result))

        publish = _publish_audit(attempt, result, pairing)
        published = publish["status"] in {"published_current", "published_stale"}
        if not published:
            review02 = "unknown" if publish["status"] == "unknown" else "false"
        elif review["status"] == "invalid":
            review02 = "true"
        elif review["status"] == "unknown":
            review02 = "unknown"
        else:
            review02 = "false"

        rules.append({"rule_id": "REVIEW-01", "scope": _event_id(attempt), **review})
        rules.append({"rule_id": "VERSION-01", "scope": _event_id(attempt), **version})
        rules.append({"rule_id": "PUBLISH-01", "scope": _event_id(attempt), **publish})
        rules.append(
            {
                "rule_id": "REVIEW-02",
                "scope": _event_id(attempt),
                "status": review02,
                "reason": "成功发布是否缺少有效审核",
                "evidence_event_ids": [*review["evidence_event_ids"], *publish["evidence_event_ids"]],
            }
        )
        attempts_out.append(
            {
                "attempt_event_id": _event_id(attempt),
                "version": attempt.get("version"),
                "expected_version": _details(attempt).get("expected_version"),
                "review": review,
                "version_check": version,
                "publish": publish,
                "review02": review02,
            }
        )

    handoff = _handoff_audit(events)
    rules.append(
        {
            "rule_id": "HANDOFF-01",
            "scope": None,
            "status": "candidate",
            "reason": f"重复交接线索 {handoff['repeated_pair_count']} 次；仅表示同一角色对的重复转交",
            "evidence_event_ids": [eid for pair in handoff["pairs"] for eid in pair["evidence_event_ids"]],
        }
    )

    summary = {
        "attempt_count": len(attempts_out),
        "review_valid": sum(1 for item in attempts_out if item["review"]["status"] == "valid"),
        "review_invalid": sum(1 for item in attempts_out if item["review"]["status"] == "invalid"),
        "review_unknown": sum(1 for item in attempts_out if item["review"]["status"] == "unknown"),
        "version_current": sum(1 for item in attempts_out if item["version_check"]["status"] == "current"),
        "version_stale": sum(1 for item in attempts_out if item["version_check"]["status"] == "stale"),
        "version_unknown": sum(1 for item in attempts_out if item["version_check"]["status"] == "unknown"),
        "published_current": sum(1 for item in attempts_out if item["publish"]["status"] == "published_current"),
        "published_stale": sum(1 for item in attempts_out if item["publish"]["status"] == "published_stale"),
        "denied": sum(1 for item in attempts_out if item["publish"]["status"] == "denied"),
        "failed": sum(1 for item in attempts_out if item["publish"]["status"] == "failed"),
        "publish_unknown": sum(1 for item in attempts_out if item["publish"]["status"] == "unknown"),
        "published_without_valid_review": sum(
            1 for item in attempts_out if item["review02"] == "true"
        ),
        "repeated_handoff": handoff["repeated_pair_count"],
    }

    return {
        "attempts": attempts_out,
        "rules": rules,
        "handoff": handoff,
        "summary": summary,
    }
