from __future__ import annotations

import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.query.filters import RawFilter
from app.routers.mc1 import decision_context, reply_network, reply_network_evidence


class Mc1ReplyNetworkTest(unittest.TestCase):
    """M1-03：回复网络按 agent 上卷，reply/mention/未来引用分开计数且可回查消息。"""

    def setUp(self) -> None:
        helpers.require_db(self)
        self.payload = reply_network("MC1", RawFilter())

    def test_agents_and_edge_totals_match_reply_audit(self) -> None:
        self.assertEqual(len(self.payload["nodes"]), 7)
        reply_edges = [edge for edge in self.payload["edges"] if edge["kind"] == "reply"]
        self.assertEqual(len(reply_edges), self.payload["counts"]["reply_edges"])
        # 回复边总数与 MC1 回复分类基线一致：309 有效 + 174 未来引用 = 483
        total = sum(edge["evidence_count"] for edge in reply_edges)
        self.assertEqual(total, 483)
        by_class = self.payload["counts"]["by_reply_class"]
        self.assertEqual(by_class["reply_valid"], 309)
        self.assertEqual(by_class["reply_future_reference"], 174)
        self.assertEqual(by_class["reply_valid"] + by_class["reply_future_reference"], total)

    def test_future_reference_is_its_own_edge(self) -> None:
        classes = {
            edge["reply_class"] for edge in self.payload["edges"] if edge["kind"] == "reply"
        }
        self.assertIn("reply_valid", classes)
        self.assertIn("reply_future_reference", classes)

    def test_edge_evidence_matches_edge_count(self) -> None:
        edge = max(
            (item for item in self.payload["edges"] if item["kind"] == "reply"),
            key=lambda item: item["evidence_count"],
        )
        evidence = reply_network_evidence(
            source_agent=edge["source"],
            target_agent=edge["target"],
            dataset="MC1",
            kind="reply",
            reply_class=edge["reply_class"],
            limit=5,
            raw=RawFilter(),
        )
        self.assertEqual(evidence["meta"]["matched_events"], edge["evidence_count"])
        self.assertTrue(evidence["items"])
        self.assertTrue(evidence["meta"]["truncated"])
        for item in evidence["items"]:
            self.assertEqual(item["actor_id"], edge["source"])

    def test_event_track_reports_truncation_and_pins_anchors(self) -> None:
        """R3：全范围超出单窗口上限时必须显式给总数，并保证关键事件在轨上。"""
        # 与网页一致：显式传热力图列跨度（05-17 起，覆盖全部 912 条消息）
        payload = decision_context(
            dataset="MC1",
            raw=RawFilter(start_us=2410128000000000, end_us=2412000000000000),
        )
        self.assertTrue(payload["truncated"])
        self.assertEqual(payload["lane_limit"], 800)
        self.assertEqual(payload["messages_total"], 912)
        drawn = len(payload["tracks"]["messages"])
        self.assertEqual(drawn, payload["lane_limit"] + len(payload["pinned_events"]))
        self.assertIn("MC1:event:20460605_21_026", payload["pinned_events"])
        self.assertIn("MC1:event:20460605_22_001", payload["pinned_events"])
        ids = {item["event_id"] for item in payload["tracks"]["messages"]}
        self.assertIn("MC1:event:20460605_21_026", ids)
        self.assertIn("MC1:event:20460605_22_001", ids)
        # 解禁事件本身走内部渠道（comms_huddle），因此只在消息轨补入，不伪造到发布轨
        lift = next(
            item for item in payload["tracks"]["messages"] if item["event_id"] == "MC1:event:20460605_22_001"
        )
        self.assertEqual(lift["channel_scope"], "internal")
        self.assertTrue(lift.get("pinned"))

    def test_pins_never_bypass_channel_actor_or_keyword_filters(self) -> None:
        """R7：补入只补"因上限被挤掉"的成员，筛选外的记录不得进入消息轨。"""
        window = {"start_us": 2410128000000000, "end_us": 2412000000000000}
        public_channels = ",".join(
            f"MC1:channel:{name}" for name in ("personal_post", "official_post", "anonymous_post")
        )
        pub = decision_context(dataset="MC1", raw=RawFilter(channels=public_channels, **window))
        self.assertEqual(pub["messages_total"], 77)
        self.assertEqual(len(pub["tracks"]["messages"]), 77)
        self.assertFalse(pub["truncated"])
        self.assertEqual(pub["pinned_events"], [])
        self.assertTrue(all(item["channel_scope"] == "public" for item in pub["tracks"]["messages"]))

        actor = decision_context(dataset="MC1", raw=RawFilter(actor="MC1:agent:pr_agent", **window))
        self.assertEqual(len(actor["tracks"]["messages"]), actor["messages_total"])
        self.assertEqual(actor["pinned_events"], [])
        self.assertTrue(
            all(item["actor_id"] == "MC1:agent:pr_agent" for item in actor["tracks"]["messages"])
        )

        empty = decision_context(
            dataset="MC1", raw=RawFilter(keyword="zzz-no-such-token-zzz", **window)
        )
        self.assertEqual(empty["messages_total"], 0)
        self.assertEqual(empty["tracks"]["messages"], [])
        self.assertEqual(empty["pinned_events"], [])

    def test_narrow_window_is_not_truncated(self) -> None:
        """缩到危机窗口后不应再截断，且不产生补入标记。"""
        payload = decision_context(
            dataset="MC1",
            raw=RawFilter(start_us=2411825100000000, end_us=2411828700000000),
        )
        self.assertFalse(payload["truncated"])
        self.assertLess(payload["messages_total"], payload["lane_limit"])
        self.assertEqual(payload["pinned_events"], [])

    def test_filters_narrow_the_network(self) -> None:
        edge = max(
            (item for item in self.payload["edges"] if item["kind"] == "reply"),
            key=lambda item: item["evidence_count"],
        )
        node = next(item for item in self.payload["nodes"] if item["id"] == edge["source"])
        actor_filtered = reply_network("MC1", RawFilter(actor=edge["source"]))
        narrowed = sum(
            item["evidence_count"] for item in actor_filtered["edges"] if item["kind"] == "reply"
        )
        self.assertLessEqual(narrowed, node["reply_out"])
        self.assertLess(narrowed, 483)

        zero = reply_network("MC1", RawFilter(start_us=0, end_us=1))
        self.assertEqual(zero["meta"]["matched_events"], 0)
        self.assertEqual(zero["edges"], [])
        self.assertTrue(all(item["messages"] == 0 for item in zero["nodes"]))

    def test_mention_edges_are_not_mixed_with_reply(self) -> None:
        mention_edges = [edge for edge in self.payload["edges"] if edge["kind"] == "mention"]
        self.assertTrue(mention_edges)
        for edge in mention_edges:
            self.assertEqual(edge["reply_class"], "mention")
            self.assertTrue(edge["target"].startswith("MC1:agent:"))


if __name__ == "__main__":
    unittest.main()
