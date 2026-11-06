from __future__ import annotations

import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.db import get_conn
from app.domain import mc1_context
from app.query.filters import RawFilter
from app.routers.mc1 import activity as activity_endpoint
from app.routers.mc1 import decision_context as decision_endpoint
from app.routers.mc1 import event_context as context_endpoint

TARGET = "MC1:event:20460605_21_026"


class Mc1ReferenceTest(unittest.TestCase):
    """M1-01：309 有效、174 未来引用；未来引用不进入历史主链。"""

    def setUp(self) -> None:
        helpers.require_db(self)

    def test_reply_classification_matches_derived_baseline(self) -> None:
        with get_conn() as conn:
            views = mc1_context.views_for(conn)
            audit = mc1_context.reply_audit(conn, views)
        counts = audit["counts"]
        self.assertEqual(counts["reply_valid"], 309)
        self.assertEqual(counts["reply_future_reference"], 174)
        self.assertEqual(counts["empty_reference"], 163)
        self.assertEqual(counts["mention"], 265)
        self.assertEqual(counts["unresolved_reference"], 1)
        self.assertEqual(sum(counts.values()), 912)
        self.assertEqual(audit["reply_edges"], 483)
        self.assertEqual(audit["text_reference_total"], 266)
        self.assertTrue(audit["baseline_compatible"])

    def test_future_reference_is_marked_unusable_as_history(self) -> None:
        with get_conn() as conn:
            payload = mc1_context.event_context(conn, "MC1:event:20460605_13_002")
        self.assertEqual(payload["event"]["reply_class"], "reply_future_reference")
        self.assertIsNotNone(payload["explicit_parent"])
        self.assertFalse(payload["explicit_parent"]["usable_as_history"])
        self.assertIn("晚于本消息", payload["explicit_parent"]["relation_reason"])

    def test_target_has_no_fabricated_parent_and_has_environment(self) -> None:
        payload = context_endpoint(TARGET, "MC1", RawFilter())
        self.assertIsNone(payload["explicit_parent"])
        self.assertEqual(payload["event"]["event_id"], TARGET)
        self.assertEqual(payload["round"]["round_index"], 21)
        kinds = {item["kind"] for item in payload["environment_context"]}
        self.assertIn("media_events", kinds)
        for item in payload["environment_context"]:
            self.assertTrue(item["context_id"].startswith("env:"))
            self.assertEqual(item["provenanceKind"], "recorded")


class Mc1ActivityTest(unittest.TestCase):
    """M1-02：7 个 agent 的矩阵，公开/内部渠道分开计数。"""

    def setUp(self) -> None:
        helpers.require_db(self)

    def test_day_matrix_covers_all_messages(self) -> None:
        payload = activity_endpoint("MC1", "day", RawFilter())
        self.assertEqual(len(payload["agents"]), 7)
        self.assertEqual(payload["matched_messages"], 912)
        self.assertEqual(payload["public_messages"], 77)
        self.assertEqual(payload["internal_messages"], 835)
        self.assertEqual(len(payload["cells"]), 7 * len(payload["columns"]))
        total = sum(cell["public"] + cell["internal"] + cell["other"] for cell in payload["cells"])
        self.assertEqual(total, 912)
        self.assertTrue(any(cell["empty"] for cell in payload["cells"]))
        for column in payload["columns"]:
            self.assertIsNotNone(column["start_us"])
            self.assertLess(column["start_us"], column["end_us"])

    def test_round_matrix_has_23_rounds(self) -> None:
        payload = activity_endpoint("MC1", "round", RawFilter())
        self.assertEqual(len(payload["columns"]), 23)
        self.assertEqual(payload["columns"][0]["label"], "R0")
        total = sum(cell["public"] + cell["internal"] + cell["other"] for cell in payload["cells"])
        self.assertEqual(total, 912)

    def test_activity_respects_actor_filter(self) -> None:
        actor = "MC1:agent:legal_agent"
        payload = activity_endpoint("MC1", "day", RawFilter(actor=actor))
        rows = [cell for cell in payload["cells"] if cell["agent_id"] == actor]
        self.assertTrue(rows)
        self.assertEqual(
            sum(cell["public"] + cell["internal"] + cell["other"] for cell in rows), 266
        )
        others = [cell for cell in payload["cells"] if cell["agent_id"] != actor]
        self.assertTrue(all(cell["empty"] for cell in others))


class Mc1DecisionTest(unittest.TestCase):
    """M1-02/M1-03：决策泳道并置 17:00 外部报道、17:25 内部确认与 18:00 解禁。"""

    def setUp(self) -> None:
        helpers.require_db(self)

    def test_anchors_are_distinct_and_not_fabricated(self) -> None:
        payload = decision_endpoint("MC1", RawFilter())
        anchors = payload["anchors"]
        self.assertEqual(anchors["external_report"]["context_id"], "env:21:media_events:0")
        self.assertIsNone(anchors["external_report"].get("event_id"))
        self.assertEqual(
            anchors["first_internal_confirmation"]["event_id"],
            "MC1:event:20460605_21_026",
        )
        self.assertEqual(anchors["formal_lift"]["event_id"], "MC1:event:20460605_22_001")
        self.assertLess(
            anchors["external_report"]["time_us"],
            anchors["first_internal_confirmation"]["time_us"],
        )
        self.assertLess(
            anchors["first_internal_confirmation"]["time_us"],
            anchors["formal_lift"]["time_us"],
        )

    def test_tracks_and_window(self) -> None:
        payload = decision_endpoint("MC1", RawFilter())
        self.assertEqual(payload["window"]["source"], "default")
        self.assertGreater(payload["counts"]["environment_records"], 0)
        self.assertGreater(payload["counts"]["messages"], 0)
        self.assertGreater(payload["counts"]["public_releases"], 0)
        self.assertTrue(payload["tracks"]["constraints"])
        bases = {item["constraint_basis"] for item in payload["tracks"]["constraints"]}
        self.assertIn("environment_narrative", bases)
        self.assertIn("event_marker", bases)
        for item in payload["tracks"]["messages"]:
            self.assertIn(item["reply_class"], mc1_context_dataclasses())

    def test_leading_indicators_have_rule_sources_and_pending_rule(self) -> None:
        payload = decision_endpoint("MC1", RawFilter())
        indicators = payload["leading_indicators"]
        self.assertTrue(indicators["candidates"])
        self.assertGreaterEqual(indicators["summary"]["rules_with_candidates"], 2)
        self.assertEqual(indicators["summary"]["pending_rule_count"], 1)
        pending = indicators["pending_rules"][0]
        self.assertEqual(pending["expected_basis"], "pending")
        self.assertFalse(pending["expected_behavior_source_ids"])
        for candidate in indicators["candidates"]:
            self.assertEqual(candidate["provenanceKind"], "candidate")
            self.assertTrue(candidate["rule_id"])
            self.assertTrue(candidate["expected_behavior_source_ids"])
            self.assertTrue(candidate["limitations"])
            # 默认排除 17:00-18:00 目标窗口
            self.assertLess(candidate["time_us"], payload["anchors"]["external_report"]["time_us"])
        self.assertFalse(any("lift" in key for key in payload["leading_indicators"]))


def mc1_context_dataclasses() -> set[str]:
    return {
        "reply_valid",
        "reply_future_reference",
        "mention",
        "unresolved_reference",
        "empty_reference",
    }


if __name__ == "__main__":
    unittest.main()
