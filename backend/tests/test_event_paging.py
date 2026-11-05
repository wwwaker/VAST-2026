from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.query.filters import RawFilter
from app.routers.events import list_events


class MicrosecondPagingTest(unittest.TestCase):
    """T-01：同秒不同微秒的事件按源时间顺序分页，游标换筛选后返回 400。"""

    def setUp(self) -> None:
        self.path = helpers.build_tiny_db(
            [
                {"event_id": "e1", "time_us": 1_000_000},
                {"event_id": "e2", "time_us": 1_000_001},
                {"event_id": "e3", "time_us": 1_000_002},
            ]
        )
        self.addCleanup(lambda: os.path.exists(self.path) and os.remove(self.path))

    def _page(self, raw: RawFilter, cursor: str | None, limit: int = 1):
        with patch("app.db.DB_PATH", self.path):
            return list_events("MC1", raw, None, limit, cursor, "desc")

    def test_order_and_no_loss(self) -> None:
        raw = RawFilter()
        ids: list[str] = []
        cursor = None
        for _ in range(5):
            page = self._page(raw, cursor)
            ids.extend(item["event_id"] for item in page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(ids, ["e3", "e2", "e1"])
        self.assertEqual(page["meta"]["matched_events"], 3)

    def test_cursor_rejects_changed_filter(self) -> None:
        first = self._page(RawFilter(), None)
        self.assertIsNotNone(first["next_cursor"])
        with self.assertRaises(HTTPException) as ctx:
            self._page(RawFilter(start_us=0), first["next_cursor"])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("cursor_filter_mismatch", ctx.exception.detail)

    def test_masking_cursor_is_inclusive(self) -> None:
        raw = RawFilter(cursor_us=1_000_001, masking=True)
        page = self._page(raw, None, limit=10)
        self.assertEqual([item["event_id"] for item in page["items"]], ["e2", "e1"])
        self.assertEqual(page["meta"]["effective_time"]["end_us"], 1_000_002)


if __name__ == "__main__":
    unittest.main()
