from __future__ import annotations

import unittest

from app.domain.custom_audit import audit_run

RUN = "run-test"


def event(event_id: str, event_type: str, time_us: int, **kwargs) -> dict:
    details = kwargs.pop("details", {})
    return {
        "event_id": event_id,
        "run_id": kwargs.pop("run_id", RUN),
        "time_sort_us": time_us,
        "event_type": event_type,
        "actor_id": kwargs.pop("actor_id", f"{RUN}:writer"),
        "target_id": kwargs.pop("target_id", None),
        "document_id": kwargs.pop("document_id", f"{RUN}:document"),
        "version": kwargs.pop("version", None),
        "parent_event_id": kwargs.pop("parent_event_id", None),
        "details": details,
    }


def base_events(attempt_details: dict, review_details: dict | None, result: dict | None) -> list[dict]:
    events = [
        event("attempt", "publish_attempt", 200, version=1, details=attempt_details),
    ]
    if review_details is not None:
        events.append(
            event(
                "review",
                "review_decision",
                100,
                actor_id=f"{RUN}:reviewer",
                version=1,
                details=review_details,
            )
        )
    if result is not None:
        events.append(event("result", "publish_result", 300, version=1, actor_id=f"{RUN}:publisher", details=result))
    return events


HASH = "a" * 64


class ReviewRuleTest(unittest.TestCase):
    """C-01：REVIEW-01 的 valid / invalid / unknown 判定与证据。"""

    def _review(self, attempt_details: dict, review_details: dict | None) -> dict:
        audit = audit_run(base_events(attempt_details, review_details, None))
        return next(rule for rule in audit["rules"] if rule["rule_id"] == "REVIEW-01")

    def test_valid_review(self) -> None:
        rule = self._review(
            {"review_event_id": "review", "sha256": HASH},
            {"approved": True, "sha256": HASH},
        )
        self.assertEqual(rule["status"], "valid")
        self.assertIn("attempt", rule["evidence_event_ids"])
        self.assertIn("review", rule["evidence_event_ids"])

    def test_hash_mismatch_is_invalid(self) -> None:
        rule = self._review(
            {"review_event_id": "review", "sha256": HASH},
            {"approved": True, "sha256": "b" * 64},
        )
        self.assertEqual(rule["status"], "invalid")

    def test_not_approved_is_invalid(self) -> None:
        rule = self._review(
            {"review_event_id": "review", "sha256": HASH},
            {"approved": False, "sha256": HASH},
        )
        self.assertEqual(rule["status"], "invalid")

    def test_missing_approved_is_unknown(self) -> None:
        rule = self._review(
            {"review_event_id": "review", "sha256": HASH},
            {"sha256": HASH},
        )
        self.assertEqual(rule["status"], "unknown")

    def test_missing_hash_is_unknown(self) -> None:
        rule = self._review({"review_event_id": "review"}, {"approved": True})
        self.assertEqual(rule["status"], "unknown")

    def test_missing_reference_field_is_unknown(self) -> None:
        rule = self._review({"sha256": HASH}, None)
        self.assertEqual(rule["status"], "unknown")

    def test_explicit_no_receipt_is_invalid(self) -> None:
        rule = self._review({"review_event_id": None, "valid_review": False, "sha256": HASH}, None)
        self.assertEqual(rule["status"], "invalid")

    def test_cross_run_review_is_invalid(self) -> None:
        events = base_events({"review_event_id": "review", "sha256": HASH}, {"approved": True, "sha256": HASH}, None)
        for item in events:
            if item["event_id"] == "review":
                item["run_id"] = "run-other"
        audit = audit_run(events)
        rule = next(rule for rule in audit["rules"] if rule["rule_id"] == "REVIEW-01")
        self.assertEqual(rule["status"], "invalid")

    def test_late_review_is_invalid(self) -> None:
        events = base_events({"review_event_id": "review", "sha256": HASH}, {"approved": True, "sha256": HASH}, None)
        for item in events:
            if item["event_id"] == "review":
                item["time_sort_us"] = 400
        audit = audit_run(events)
        rule = next(rule for rule in audit["rules"] if rule["rule_id"] == "REVIEW-01")
        self.assertEqual(rule["status"], "invalid")


class PublishRuleTest(unittest.TestCase):
    def test_no_result_is_unknown_not_failure(self) -> None:
        audit = audit_run(base_events({"review_event_id": "review", "sha256": HASH, "expected_version": 1}, None, None))
        rule = next(rule for rule in audit["rules"] if rule["rule_id"] == "PUBLISH-01")
        self.assertEqual(rule["status"], "unknown")
        self.assertIn("尚无发布结果", rule["reason"])

    def test_success_without_review_sets_review02_true(self) -> None:
        events = base_events(
            {"review_event_id": None, "valid_review": False, "sha256": HASH, "expected_version": 1},
            None,
            {"status": "success", "sha256": HASH, "attempt_event_id": "attempt"},
        )
        audit = audit_run(events)
        rule = next(rule for rule in audit["rules"] if rule["rule_id"] == "REVIEW-02")
        self.assertEqual(rule["status"], "true")

    def test_published_old_version_is_stale(self) -> None:
        events = base_events(
            {
                "review_event_id": "review",
                "sha256": HASH,
                "expected_version": 2,
            },
            {"approved": True, "sha256": HASH},
            {"status": "success", "sha256": HASH, "attempt_event_id": "attempt"},
        )
        audit = audit_run(events)
        publish = next(rule for rule in audit["rules"] if rule["rule_id"] == "PUBLISH-01")
        self.assertEqual(publish["status"], "published_stale")
        self.assertEqual(audit["summary"]["published_stale"], 1)

    def test_denied_result_without_reference_is_paired_by_hash(self) -> None:
        events = base_events(
            {"review_event_id": "review", "sha256": HASH, "expected_version": 2},
            {"approved": True, "sha256": HASH},
            {"status": "denied", "sha256": HASH},
        )
        audit = audit_run(events)
        publish = next(rule for rule in audit["rules"] if rule["rule_id"] == "PUBLISH-01")
        self.assertEqual(publish["status"], "denied")
        self.assertEqual(publish["pairing"], "derived_same_hash")


class HandoffRuleTest(unittest.TestCase):
    def test_repeated_pair_and_loop(self) -> None:
        events = [
            event("h1", "task_handoff", 10, actor_id=f"{RUN}:coordinator", target_id=f"{RUN}:researcher"),
            event("h2", "task_handoff", 20, actor_id=f"{RUN}:researcher", target_id=f"{RUN}:coordinator"),
            event("h3", "task_handoff", 30, actor_id=f"{RUN}:coordinator", target_id=f"{RUN}:researcher"),
        ]
        audit = audit_run(events)
        handoff = audit["handoff"]
        self.assertEqual(handoff["repeated_pair_count"], 1)
        self.assertEqual(len(handoff["loops"]), 1)
        self.assertEqual(handoff["loops"][0]["path"], ["coordinator", "researcher", "coordinator"])


if __name__ == "__main__":
    unittest.main()
