from __future__ import annotations

import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from fastapi import HTTPException

from app.db import get_conn
from app.domain import mc2_patterns
from app.routers.patterns import file_posts, interventions

TARGET = "MC2:event:373902"


class FilePostPatternTest(unittest.TestCase):
    """M2-04：阶段签名只来自记录字段，缺失阶段必须留空。"""

    def setUp(self) -> None:
        helpers.require_db(self)

    def test_three_instances_share_relay_and_cleanup(self) -> None:
        payload = file_posts("MC2", None, 20)
        self.assertEqual(payload["total"], 3)
        self.assertEqual(len(payload["items"]), 3)
        for chain in payload["items"]:
            stages = {item["stage"]: item for item in chain["stages"]}
            self.assertEqual(stages["relay_queued"]["status"], "present")
            self.assertEqual(stages["posted"]["status"], "present")
            self.assertEqual(stages["cleanup_instruction"]["status"], "present")
            self.assertEqual(stages["cleanup_content"]["status"], "present")
            # 发布前的转交必须在 60 秒内，否则不能称“紧邻”
            self.assertIsNotNone(stages["relay_queued"]["nearest_lag_us"])
            self.assertLessEqual(stages["relay_queued"]["nearest_lag_us"], 60_000_000)

    def test_missing_content_created_is_kept_empty(self) -> None:
        payload = file_posts("MC2", None, 20)
        by_post = {chain["post_event_id"]: chain for chain in payload["items"]}
        hidden = by_post["MC2:event:27290"]
        stages = {item["stage"]: item for item in hidden["stages"]}
        self.assertEqual(stages["content_created"]["status"], "missing")
        self.assertEqual(stages["content_created"]["event_ids"], [])
        self.assertIn("content_created", hidden["missing_stages"])

    def test_name_prefix_link_is_labeled(self) -> None:
        payload = file_posts("MC2", None, 20)
        for chain in payload["items"]:
            self.assertEqual(chain["link_basis"], "name_prefix")
            self.assertTrue(chain["instruction_file"]["path"].endswith("_further_instructions.md"))
        self.assertIn("name_hint", payload["link_basis_note"])

    def test_before_filter_excludes_later_instances(self) -> None:
        with get_conn() as conn:
            target_us = conn.execute(
                "SELECT time_sort_us FROM events WHERE dataset_id='MC2' AND event_id=?", (TARGET,)
            ).fetchone()["time_sort_us"]
        payload = file_posts("MC2", target_us, 20)
        ids = [chain["post_event_id"] for chain in payload["items"]]
        self.assertNotIn(TARGET, ids)
        self.assertEqual(len(ids), 2)

    def test_non_mc2_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            file_posts("MC1", None, 20)
        self.assertEqual(ctx.exception.status_code, 400)


class InterventionTest(unittest.TestCase):
    """M2-05：覆盖分母、附带影响与可切断性都要有据可查。"""

    def setUp(self) -> None:
        helpers.require_db(self)

    def test_coverage_is_three_of_three(self) -> None:
        payload = interventions("MC2", "relay_queue")
        self.assertEqual(payload["coverage_summary"], {"covered": 3, "denominator": 3, "partial_chains": 1})
        self.assertTrue(payload["evidence_event_ids"])
        for item in payload["coverage"]:
            self.assertTrue(item["present"])
            self.assertIsNotNone(item["nearest_event_id"])

    def test_impact_uses_explicit_file_path_only(self) -> None:
        payload = interventions("MC2", "relay_queue")
        impact = payload["impact"]
        self.assertEqual(impact["queue_events_with_file_path"], 235)
        self.assertEqual(impact["events_on_target_files"], 235)
        self.assertEqual(impact["events_on_other_files"], 0)
        self.assertGreater(impact["queue_events_total"], impact["queue_events_with_file_path"])
        self.assertGreater(impact["distinct_senders"], 0)

    def test_cut_analysis_declines_proof(self) -> None:
        payload = interventions("MC2", "relay_queue")
        self.assertFalse(payload["cut_analysis"]["deterministic_path_exists"])
        self.assertIn("不能证明", payload["cut_analysis"]["statement"])

    def test_limitations_are_stated(self) -> None:
        payload = interventions("MC2", "relay_queue")
        self.assertGreaterEqual(len(payload["limitations"]), 3)
        self.assertGreaterEqual(len(payload["extra_info_needed"]), 2)
        self.assertIn("最多选择一个干预位置", payload["constraint"])

    def test_stage_dictionary_covers_all_stages(self) -> None:
        payload = file_posts("MC2", None, 20)
        keys = [item["stage"] for item in payload["stage_dictionary"]]
        self.assertEqual(keys, [key for key, _ in mc2_patterns.STAGES])


if __name__ == "__main__":
    unittest.main()
