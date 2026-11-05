from __future__ import annotations

import sqlite3
import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.domain import event_types


class IngestContractTest(unittest.TestCase):
    """D-01：v2 导入后的事件规模、主键唯一与微秒精度。"""

    def setUp(self) -> None:
        self.path = helpers.require_db(self)

    def test_schema_version_and_counts(self) -> None:
        conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 2)
            events = dict(conn.execute("SELECT dataset_id, event_count FROM datasets"))
            self.assertEqual(events, {"MC1": 912, "MC2": 185147, "CUSTOM": 1103})
            entities = dict(conn.execute("SELECT dataset_id, entity_count FROM datasets"))
            self.assertEqual(entities, {"MC1": 13, "MC2": 15538, "CUSTOM": 330})
        finally:
            conn.close()

    def test_primary_keys_unique(self) -> None:
        conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        try:
            duplicates = conn.execute(
                "SELECT COUNT(*) FROM (SELECT dataset_id, event_id, COUNT(*) c "
                "FROM events GROUP BY 1,2 HAVING c > 1)"
            ).fetchone()[0]
            self.assertEqual(duplicates, 0)
        finally:
            conn.close()

    def test_custom_microsecond_precision_preserved(self) -> None:
        conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        try:
            distinct = conn.execute(
                "SELECT COUNT(DISTINCT time_sort_us) FROM events WHERE dataset_id='CUSTOM'"
            ).fetchone()[0]
            total = conn.execute(
                "SELECT COUNT(*) FROM events WHERE dataset_id='CUSTOM'"
            ).fetchone()[0]
            self.assertEqual(distinct, total)
            self.assertEqual(total, 1103)

            runs = conn.execute(
                "SELECT COUNT(DISTINCT run_id) FROM events WHERE dataset_id='CUSTOM'"
            ).fetchone()[0]
            self.assertEqual(runs, 32)
            missing = conn.execute(
                "SELECT COUNT(*) FROM events WHERE dataset_id='CUSTOM' AND run_id IS NULL"
            ).fetchone()[0]
            self.assertEqual(missing, 0)
        finally:
            conn.close()

    def test_all_types_are_known(self) -> None:
        conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        try:
            for dataset in ("MC1", "MC2", "CUSTOM"):
                observed = {
                    row[0]
                    for row in conn.execute(
                        "SELECT DISTINCT event_type FROM events WHERE dataset_id=?", (dataset,)
                    )
                }
                self.assertEqual(
                    event_types.unknown_types(dataset, observed), [], f"{dataset} 存在未登记类型"
                )
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
