from __future__ import annotations

import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.domain import event_types
from app.ingest.loader import parse_epoch_us
from app.query.filters import RawFilter
from app.routers.events import list_events


class FilterConsistencyTest(unittest.TestCase):
    """F-01/F-02：完整分页事件集合与聚合 matched_events 一致；空类别不退化为全量。"""

    def setUp(self) -> None:
        helpers.require_db(self)
        self.raw = RawFilter(
            start_us=parse_epoch_us("2046-05-17T11:00:00Z"),
            end_us=parse_epoch_us("2046-05-17T12:00:00Z"),
            participant="MC2:agent:Agent/person:john_windward",
            categories="2",
        )

    def _collect(self, raw: RawFilter, limit: int = 100) -> tuple[list[dict], int]:
        items: list[dict] = []
        cursor = None
        matched = None
        for _ in range(50):
            page = list_events("MC2", raw, None, limit, cursor, "asc")
            matched = page["meta"]["matched_events"]
            items.extend(page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertIsNotNone(matched)
        return items, int(matched)

    def test_pages_equal_matched_count(self) -> None:
        items, matched = self._collect(self.raw)
        self.assertGreater(matched, 0)
        self.assertEqual(len(items), matched)
        self.assertEqual(len({item["event_id"] for item in items}), matched)

        publish_types = event_types.types_in_categories("MC2", [2])
        for item in items:
            self.assertIn(item["event_type"], publish_types)
            self.assertEqual(item["actor_id"], "MC2:agent:Agent/person:john_windward")
            self.assertEqual(item["category"], 2)
            self.assertLess(item["time_us"], self.raw.end_us)

    def test_empty_category_resolves_to_zero(self) -> None:
        raw = RawFilter(
            start_us=self.raw.start_us,
            end_us=self.raw.end_us,
            categories="8",
        )
        items, matched = self._collect(raw)
        self.assertEqual(matched, 0)
        self.assertEqual(items, [])

    def test_category_and_type_intersection(self) -> None:
        raw = RawFilter(
            start_us=self.raw.start_us,
            end_us=self.raw.end_us,
            categories="2",
            types="post_saidit",
        )
        items, matched = self._collect(raw)
        self.assertEqual(len(items), matched)
        self.assertTrue(all(item["event_type"] == "post_saidit" for item in items))

    def test_cross_category_intersection_is_zero(self) -> None:
        raw = RawFilter(
            start_us=self.raw.start_us,
            end_us=self.raw.end_us,
            categories="2",
            types="read_file",
        )
        items, matched = self._collect(raw)
        self.assertEqual(matched, 0)
        self.assertEqual(items, [])


if __name__ == "__main__":
    unittest.main()
