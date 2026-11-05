from __future__ import annotations

import os
import unittest
from unittest.mock import patch

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.query.filters import RawFilter
from app.routers.compare import compare


class HalfOpenWindowTest(unittest.TestCase):
    """T-02：分界事件只属于右侧窗口，自动基线不与当前窗口相交。"""

    def setUp(self) -> None:
        self.path = helpers.build_tiny_db(
            [
                {"event_id": "before", "time_us": 1_000_000},
                {"event_id": "boundary", "time_us": 2_000_000},
                {"event_id": "after", "time_us": 4_000_000},
            ]
        )
        self.addCleanup(lambda: os.path.exists(self.path) and os.remove(self.path))

    def _compare(self, **kwargs):
        with patch("app.db.DB_PATH", self.path):
            return compare("MC1", **kwargs)

    def test_boundary_event_only_in_right_window(self) -> None:
        payload = self._compare(
            raw=RawFilter(start_us=2_000_000, end_us=4_000_000),
            baseline_start_us=0,
            baseline_end_us=2_000_000,
            dimension="event_type",
            limit=20,
        )
        self.assertEqual(payload["window"]["events"], 1)
        self.assertEqual(payload["baseline"]["events"], 1)
        row = next(r for r in payload["rows"] if r["key"] == "broadcast")
        self.assertEqual(row["window_count"], 1)
        self.assertEqual(row["baseline_count"], 1)
        self.assertEqual(payload["overlap_us"], 0)

    def test_auto_baseline_does_not_overlap(self) -> None:
        payload = self._compare(
            raw=RawFilter(start_us=2_000_000, end_us=4_000_000),
            dimension="event_type",
            limit=20,
        )
        self.assertTrue(payload["baseline"]["auto"])
        self.assertEqual(payload["baseline"]["start_us"], 0)
        self.assertEqual(payload["baseline"]["end_us"], 2_000_000)

    def test_partial_coverage_not_counted_as_zero_activity(self) -> None:
        payload = self._compare(
            raw=RawFilter(start_us=2_000_000, end_us=6_000_000),
            baseline_start_us=0,
            baseline_end_us=2_000_000,
            dimension="event_type",
            limit=20,
        )
        self.assertEqual(payload["window"]["coverage_status"], "partial")
        self.assertEqual(payload["window"]["in_range_duration_us"], 2_000_000)
        # 速率按交集时长计算（2 条 / 2 秒），而不是按请求的 4 秒时长稀释成一半
        self.assertAlmostEqual(payload["window_total_rate"], 3600.0, places=3)


if __name__ == "__main__":
    unittest.main()
