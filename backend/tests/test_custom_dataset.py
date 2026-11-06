from __future__ import annotations

import json
import sqlite3
import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from app.domain import custom_audit


def _events(conn, run_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM events WHERE dataset_id='CUSTOM' AND run_id=? ORDER BY time_sort_us, event_id",
        (run_id,),
    ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        item["details"] = json.loads(item["details_json"]) if item["details_json"] else {}
        out.append(item)
    return out


class CustomDatasetTest(unittest.TestCase):
    """C-02：运行规模、配对合法性，以及已知批次审计结果可逐运行复核。"""

    def setUp(self) -> None:
        self.path = helpers.require_db(self)
        self.conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)

    def test_run_inventory(self) -> None:
        row = self.conn.execute(
            "SELECT COUNT(*) c, SUM(event_count) n FROM runs WHERE dataset_id='CUSTOM'"
        ).fetchone()
        self.assertEqual(row["c"], 32)
        self.assertEqual(row["n"], 1103)

        pairs = self.conn.execute("SELECT COUNT(*) FROM run_pairs WHERE dataset_id='CUSTOM'").fetchone()[0]
        self.assertEqual(pairs, 24)

        orphan = self.conn.execute(
            "SELECT COUNT(*) FROM run_pairs p LEFT JOIN runs r "
            "ON r.dataset_id=p.dataset_id AND r.run_id=p.normal_run_id "
            "WHERE r.run_id IS NULL"
        ).fetchone()[0]
        self.assertEqual(orphan, 0)

    def test_normal_run_has_valid_review_and_current_publish(self) -> None:
        audit = custom_audit.audit_run(_events(self.conn, "run-05e66fcb181b49249deb3de731e4cd10"))
        summary = audit["summary"]
        self.assertEqual(summary["review_invalid"], 0)
        self.assertEqual(summary["published_current"], 1)
        self.assertEqual(summary["published_without_valid_review"], 0)
        self.assertEqual(summary["version_stale"], 0)

    def test_bypass_review_run_is_flagged(self) -> None:
        audit = custom_audit.audit_run(_events(self.conn, "run-06309bfc120a40e480100352e1eb52ff"))
        summary = audit["summary"]
        self.assertGreater(summary["review_invalid"], 0)
        self.assertEqual(summary["published_without_valid_review"], 1)
        self.assertEqual(summary["published_current"], 1)

    def test_stale_version_run_reports_denied(self) -> None:
        audit = custom_audit.audit_run(_events(self.conn, "run-15881c58548f4fda83afb4f337efb371"))
        summary = audit["summary"]
        self.assertEqual(summary["version_stale"], 1)
        self.assertEqual(summary["denied"], 1)
        self.assertEqual(summary["published_stale"], 0)
        publish = next(rule for rule in audit["rules"] if rule["rule_id"] == "PUBLISH-01")
        self.assertEqual(publish["status"], "denied")
        self.assertGreaterEqual(len(publish["evidence_event_ids"]), 2)

    def test_batch_outcomes_match_known_labels(self) -> None:
        runs = self.conn.execute(
            "SELECT run_id, scenario, observed FROM runs WHERE dataset_id='CUSTOM'"
        ).fetchall()
        published_stale = 0
        denied = 0
        bypass = 0
        repeated = 0
        for run in runs:
            audit = custom_audit.audit_run(_events(self.conn, run["run_id"]))
            summary = audit["summary"]
            published_stale += summary["published_stale"]
            denied += summary["denied"]
            if summary["published_without_valid_review"] > 0:
                bypass += 1
            if summary["repeated_handoff"] > 0:
                repeated += 1
        self.assertEqual(published_stale, 5)
        self.assertEqual(denied, 3)
        self.assertEqual(bypass, 8)
        self.assertEqual(repeated, 8)

    def test_audit_evidence_ids_exist(self) -> None:
        audit = custom_audit.audit_run(_events(self.conn, "run-06309bfc120a40e480100352e1eb52ff"))
        known = {
            row[0]
            for row in self.conn.execute(
                "SELECT event_id FROM events WHERE dataset_id='CUSTOM' AND run_id=?",
                ("run-06309bfc120a40e480100352e1eb52ff",),
            )
        }
        for rule in audit["rules"]:
            for event_id in rule["evidence_event_ids"]:
                self.assertIn(event_id, known, f"{rule['rule_id']} 引用了不存在的证据")


if __name__ == "__main__":
    unittest.main()
