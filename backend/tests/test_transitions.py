from __future__ import annotations

import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.query.filters import RawFilter
from app.routers.transitions import transition_evidence, transition_matrix


class TransitionMatrixTest(unittest.TestCase):
    """M2-04：矩阵与证据列表同口径，两侧同时受筛选约束，且不展示 lift。"""

    def setUp(self) -> None:
        helpers.require_db(self)
        self.payload = transition_matrix("MC2", 5, RawFilter())

    def test_installed_and_window_subset(self) -> None:
        totals = self.payload["totals"]
        self.assertEqual(totals["installed_pairs"], 171768)
        self.assertEqual(totals["within_window_pairs"], 165102)
        self.assertEqual(totals["matched_pairs"], 165102)
        self.assertEqual(self.payload["excluded"]["by_filter"], 0)
        self.assertEqual(self.payload["actor_coverage"]["actors_in_window"], 98)
        self.assertEqual(self.payload["actor_coverage"]["actors_matched"], 98)
        self.assertFalse(self.payload["supports_lift"])
        self.assertNotIn("lift", self.payload)
        self.assertTrue(self.payload["method_notes"])

    def test_evidence_total_equals_cell_support(self) -> None:
        cell = max(self.payload["cells"], key=lambda item: item["support"])
        evidence = transition_evidence(
            "MC2", 5, cell["source_type"], cell["next_type"], 200, 0, RawFilter()
        )
        self.assertEqual(evidence["total"], cell["support"])
        self.assertEqual(evidence["cell"]["total"], cell["support"])
        self.assertTrue(evidence["items"])
        first = evidence["items"][0]
        self.assertEqual(first["source"]["event_type"], cell["source_type"])
        self.assertEqual(first["next"]["event_type"], cell["next_type"])
        self.assertGreater(first["lag_us"], 0)
        self.assertLessEqual(first["lag_us"], 300_000_000)
        self.assertEqual(first["provenanceKind"], "derived")
        self.assertTrue(first["ruleId"])

    def test_pagination_does_not_lose_or_duplicate(self) -> None:
        cell = max(self.payload["cells"], key=lambda item: item["support"])
        seen = []
        offset = 0
        while offset < min(cell["support"], 500):
            page = transition_evidence(
                "MC2", 5, cell["source_type"], cell["next_type"], 50, offset, RawFilter()
            )
            seen.extend(item["source"]["event_id"] for item in page["items"])
            offset += 50
            if not page["has_more"]:
                break
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(len(seen), min(cell["support"], 500))

    def test_both_endpoints_must_match_filter(self) -> None:
        actor = "MC2:agent:Agent/person:abigail_spinnaker"
        payload = transition_matrix("MC2", 5, RawFilter(actor=actor))
        self.assertGreater(len(payload["cells"]), 0)
        cell = max(payload["cells"], key=lambda item: item["support"])
        evidence = transition_evidence(
            "MC2", 5, cell["source_type"], cell["next_type"], 200, 0, RawFilter(actor=actor)
        )
        self.assertEqual(evidence["total"], cell["support"])
        for item in evidence["items"]:
            self.assertEqual(item["source"]["actor_id"], actor)
            self.assertEqual(item["next"]["actor_id"], actor)

        # 时间窗同时约束两条事件：只保留两端都落在窗口内的对
        first = evidence["items"][0]
        start = first["source"]["time_us"]
        end = first["next"]["time_us"] + 1
        windowed = RawFilter(start_us=start, end_us=end)
        narrow = transition_matrix("MC2", 5, windowed)
        narrow_cell = next(
            (
                item
                for item in narrow["cells"]
                if item["source_type"] == cell["source_type"]
                and item["next_type"] == cell["next_type"]
            ),
            None,
        )
        self.assertIsNotNone(narrow_cell)
        narrow_evidence = transition_evidence(
            "MC2", 5, cell["source_type"], cell["next_type"], 200, 0, windowed
        )
        self.assertEqual(narrow_evidence["total"], narrow_cell["support"])
        for item in narrow_evidence["items"]:
            self.assertGreaterEqual(item["source"]["time_us"], start)
            self.assertLess(item["next"]["time_us"], end)

    def test_window_30_is_superset_of_5(self) -> None:
        wide = transition_matrix("MC2", 30, RawFilter())
        self.assertGreaterEqual(
            wide["totals"]["matched_pairs"], self.payload["totals"]["matched_pairs"]
        )
        self.assertEqual(wide["lag_max_us"], 1_800_000_000)

    def test_low_sample_cells_show_exact_count(self) -> None:
        payload = transition_matrix("MC2", 5, RawFilter(keyword="no-such-token-xyz"))
        self.assertEqual(payload["totals"]["matched_pairs"], 0)
        self.assertEqual(payload["cells"], [])
        self.assertEqual(payload["excluded"]["by_filter"], 165102)


if __name__ == "__main__":
    unittest.main()
