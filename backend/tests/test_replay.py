from __future__ import annotations

import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.query.filters import RawFilter
from app.routers.datasets import list_datasets, overview
from app.routers.events import list_events


class ReplayMaskingTest(unittest.TestCase):
    """R-01：开启遮蔽时所有动态结果 time_us <= cursor，关闭后恢复全量。"""

    def setUp(self) -> None:
        helpers.require_db(self)
        info = next(item for item in list_datasets() if item["dataset_id"] == "MC1")
        self.start_us = info["start_us"]
        self.end_us = info["end_us"]
        self.cursor = self.start_us + (self.end_us - self.start_us) // 2

    def _collect(self, raw: RawFilter) -> tuple[list[dict], int, int]:
        items: list[dict] = []
        cursor = None
        matched = 0
        effective_end = 0
        for _ in range(20):
            page = list_events("MC1", raw, None, 500, cursor, "asc")
            matched = page["meta"]["matched_events"]
            effective_end = page["meta"]["effective_time"]["end_us"]
            items.extend(page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        return items, matched, effective_end

    def test_masked_results_never_exceed_cursor(self) -> None:
        items, matched, effective_end = self._collect(
            RawFilter(cursor_us=self.cursor, masking=True)
        )
        self.assertGreater(matched, 0)
        self.assertLess(matched, 912)
        self.assertEqual(len(items), matched)
        self.assertEqual(effective_end, self.cursor + 1)
        self.assertTrue(all(item["time_us"] <= self.cursor for item in items))

    def test_disabling_masking_restores_full_range(self) -> None:
        items, matched, _ = self._collect(RawFilter(cursor_us=self.cursor, masking=False))
        self.assertEqual(matched, 912)
        self.assertEqual(len(items), 912)
        self.assertTrue(any(item["time_us"] > self.cursor for item in items))

    def test_overview_buckets_stop_at_cursor(self) -> None:
        payload = overview("MC1", RawFilter(cursor_us=self.cursor, masking=True), "hour")
        buckets = payload["filtered"]["series"]["buckets"]
        self.assertTrue(buckets)
        self.assertTrue(all(bucket <= self.cursor for bucket in buckets))
        meta_end = payload["meta"]["effective_time"]["end_us"]
        self.assertEqual(meta_end, self.cursor + 1)


if __name__ == "__main__":
    unittest.main()
