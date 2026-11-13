from __future__ import annotations

import json
import os
import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from fastapi import HTTPException

from app.db import get_conn
from app.domain import cases as case_domain
from app.routers.cases import get_case, list_cases

CASE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "cases", "custom.json"
)


class CaseFileTest(unittest.TestCase):
    """S2 剩余项：七条冻结案例的 ID、配对与期望值都能被重算复核。"""

    def setUp(self) -> None:
        helpers.require_db(self)

    def _version(self) -> str:
        with get_conn() as conn:
            return conn.execute(
                "SELECT data_version FROM datasets WHERE dataset_id='CUSTOM'"
            ).fetchone()["data_version"]

    def test_seven_cases_are_frozen(self) -> None:
        payload = list_cases("CUSTOM")
        self.assertEqual(payload["total"], 7)
        self.assertEqual([item["case_id"] for item in payload["items"]], [
            "custom-normal",
            "custom-bypass-review",
            "custom-repeated-handoff",
            "custom-stale-denied",
            "custom-stale-published",
            "custom-normal-rework",
            "custom-valid-review-denied",
        ])
        # 每条都用当前主库重算过，期望值与实际一致
        self.assertEqual(payload["status_counts"]["ok"], 7)
        self.assertFalse(payload["stale"])

    def test_every_case_resolves_run_and_baseline(self) -> None:
        payload = list_cases("CUSTOM")
        for item in payload["items"]:
            self.assertEqual(item["status"], "ok", f"{item['case_id']} 未通过：{item['diffs']}")
            self.assertIsNotNone(item["run"])
            if item["baseline_run_id"]:
                self.assertIsNotNone(item.get("baseline"))
                self.assertEqual(item["baseline"]["scenario"], "normal")
                self.assertEqual(item["run"]["model"], item["baseline"]["model"])
                self.assertEqual(item["run"]["fixture"], item["baseline"]["fixture"])

    def test_handoff_case_reports_pair_and_loop(self) -> None:
        case = get_case("custom-repeated-handoff")
        self.assertEqual(case["audit"]["repeated_handoff"], 1)
        self.assertEqual(len(case["loops"]), 1)
        self.assertEqual(case["loops"][0]["path"], ["coordinator", "researcher", "coordinator"])

    def test_stale_cases_are_distinguished(self) -> None:
        denied = get_case("custom-stale-denied")
        self.assertEqual(denied["audit"]["denied"], 1)
        self.assertEqual(denied["audit"]["published_stale"], 0)
        published = get_case("custom-stale-published")
        self.assertEqual(published["audit"]["published_stale"], 1)
        self.assertEqual(published["audit"]["denied"], 0)

    def test_evidence_events_resolve(self) -> None:
        case = get_case("custom-bypass-review")
        self.assertTrue(case["evidence_events"])
        for item in case["evidence_events"]:
            self.assertFalse(item["missing"], f"{item['role']} 未解析")
            self.assertTrue(item["event_id"])

    def test_version_change_marks_all_stale(self) -> None:
        with get_conn() as conn:
            payload = case_domain.list_cases(conn, "sha256-of-some-other-build", CASE_PATH)
        self.assertTrue(payload["stale"])
        self.assertEqual(payload["status_counts"]["stale"], 7)
        for item in payload["items"]:
            self.assertEqual(item["computed_status"], "ok")

    def test_mismatch_is_reported_not_silenced(self) -> None:
        with open(CASE_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        broken = json.loads(json.dumps(data))
        broken["cases"][0]["expect"]["published_stale"] = 3
        path = CASE_PATH + ".tmp-test.json"
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(broken, handle, ensure_ascii=False)
        try:
            with get_conn() as conn:
                payload = case_domain.list_cases(conn, self._version(), path)
            first = payload["items"][0]
            self.assertEqual(first["status"], "mismatch")
            self.assertEqual(first["diffs"][0]["field"], "published_stale")
        finally:
            os.remove(path)

    def test_unknown_case_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            get_case("case-not-exist")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_other_dataset_has_no_presets_but_accepts_user_cases(self) -> None:
        # 预置案例只属于 CUSTOM；MC2 可以保存用户案例，因此列表是合法请求
        payload = list_cases("MC2")
        self.assertEqual(payload["items"], [])
        self.assertEqual(payload["total"], 0)
        self.assertIsInstance(payload["user_items"], list)


if __name__ == "__main__":
    unittest.main()
