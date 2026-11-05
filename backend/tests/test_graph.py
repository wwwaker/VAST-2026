from __future__ import annotations

import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.query.filters import RawFilter
from app.routers.graph import graph, graph_evidence


class GraphEvidenceTest(unittest.TestCase):
    """G-01：同一条边的证据数不随遍历深度翻倍，证据分页数等于 evidence_count。"""

    CENTER = "MC1:agent:legal_agent"
    TARGET = "MC1:channel:comms_huddle"

    def setUp(self) -> None:
        helpers.require_db(self)

    def _edges(self, depth: int):
        payload = graph("MC1", self.CENTER, RawFilter(), depth, 80, 300)
        return [
            edge
            for edge in payload["edges"]
            if edge["target"] == self.TARGET and edge["source"] == self.CENTER
        ]

    def test_counts_do_not_double_with_depth(self) -> None:
        one = {edge["relation"]: edge["evidence_count"] for edge in self._edges(1)}
        two = {edge["relation"]: edge["evidence_count"] for edge in self._edges(2)}
        three = {edge["relation"]: edge["evidence_count"] for edge in self._edges(3)}
        self.assertEqual(one, {"in_channel": 126, "broadcast_to": 126})
        self.assertEqual(one, two)
        self.assertEqual(one, three)

    def test_evidence_pagination_matches_count(self) -> None:
        payload = graph_evidence(
            "MC1",
            self.CENTER,
            self.TARGET,
            "in_channel",
            "source:channel_id",
            RawFilter(),
            200,
            None,
            "asc",
        )
        self.assertEqual(payload["meta"]["matched_events"], 126)
        self.assertEqual(len(payload["items"]), 126)
        self.assertEqual(len({item["event_id"] for item in payload["items"]}), 126)

    def test_static_edges_are_separate(self) -> None:
        payload = graph("MC2", "MC2:department:department:executive_suite", RawFilter(), 1, 80, 300)
        dynamic = {edge["evidence_count"] for edge in payload["edges"]}
        self.assertTrue(all(count > 0 for count in dynamic))
        for edge in payload["static_edges"]:
            self.assertEqual(edge["evidence_count"], 0)
            self.assertEqual(edge["kind"], "static")


if __name__ == "__main__":
    unittest.main()
