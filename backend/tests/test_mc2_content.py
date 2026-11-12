from __future__ import annotations

import unittest
import sqlite3

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from fastapi import HTTPException

from app.db import get_conn
from app.domain import mc2_files
from app.query.filters import RawFilter
from app.routers.files import file_track
from app.routers.traces import traces

TARGET_POST = "MC2:event:373902"
TARGET_FILE = "MC2:file_path:SwiftWren.txt"
INSTRUCTION_FILE = "MC2:file_path:SwiftWren_further_instructions.md"


class Mc2ContentTest(unittest.TestCase):
    """M2-01：只含文件名/size_hint 的目标包不得返回 available，也不得出现伪正文。"""

    def setUp(self) -> None:
        helpers.require_db(self)

    def test_target_file_is_metadata_only(self) -> None:
        with get_conn() as conn:
            info = mc2_files.content_status(conn, "MC2", TARGET_FILE)
        self.assertEqual(info["content_status"], "metadata_only")
        self.assertEqual(info["size_hint"], 30615)
        self.assertEqual(info["content_sources"], [])
        self.assertIn("文件正文", info["missing_fields"])
        self.assertEqual(info["event_type_counts"], {"create_file": 1, "saidit_post": 1, "delete_file": 1})

    def test_target_post_has_no_content_while_peers_do(self) -> None:
        with get_conn() as conn:
            row = conn.execute(
                "SELECT json_type(details_json, '$.content') AS t, event_type FROM events "
                "WHERE dataset_id='MC2' AND event_id=?",
                (TARGET_POST,),
            ).fetchone()
            peers = conn.execute(
                "SELECT COUNT(*) AS total, "
                "SUM(CASE WHEN json_type(details_json,'$.content')='text' THEN 1 ELSE 0 END) AS with_content "
                "FROM events WHERE dataset_id='MC2' AND event_type=?",
                (row["event_type"],),
            ).fetchone()
        self.assertIsNone(row["t"])
        # 字段差异是可核查事实；这里只断言计数，不据此推断动机
        self.assertEqual(int(peers["with_content"]), 105)
        self.assertEqual(int(peers["total"]), 108)

    def test_same_name_files_are_not_merged(self) -> None:
        with get_conn() as conn:
            items = mc2_files.search_files(conn, "MC2", "SwiftWren", 10)
        ids = {item["file_id"] for item in items}
        self.assertIn(TARGET_FILE, ids)
        self.assertIn(INSTRUCTION_FILE, ids)
        self.assertEqual(len(ids), 2)
        # 精确路径查询才标 exact，避免按 basename 匹配
        with get_conn() as conn:
            exact = mc2_files.search_files(conn, "MC2", "SwiftWren.txt", 10)
        self.assertTrue(exact[0]["exact"])

    def test_summary_counts_distinct_events_beyond_content_inspection_limit(self) -> None:
        """A bounded body inspection must not become a truncated or duplicate total."""
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        self.addCleanup(conn.close)
        conn.executescript(helpers.schema.TABLES)
        conn.execute("INSERT INTO entities (dataset_id,entity_id,entity_type,source_value) VALUES ('MC2','file','file_path','test.txt')")
        for index in range(502):
            event_id = f"test:{index}"
            helpers.insert_event(conn, dataset="MC2", event_id=event_id, time_us=index + 1, event_type="read_file", details='{"file_path":"test.txt"}')
            for relation in ("file_path", "queued_file_path"):
                conn.execute("INSERT INTO relations (dataset_id,event_id,dst_id,relation,derivation) VALUES ('MC2',?,'file',?,'recorded')", (event_id, relation))
        info = mc2_files.content_status(conn, "MC2", "file")
        self.assertEqual(info["event_count"], 502)
        self.assertEqual(info["event_type_counts"], {"read_file": 502})
        self.assertEqual((info["first_us"], info["last_us"]), (1, 502))
        self.assertTrue(info["events_truncated"])
        self.assertEqual(info["summary_scope"], "global")


class Mc2TraceTest(unittest.TestCase):
    """M2-02：候选关联不得当成已证实传播；回放不得读到未来证据。"""

    def setUp(self) -> None:
        helpers.require_db(self)

    def test_recorded_edges_have_evidence_and_candidates_do_not(self) -> None:
        payload = traces("MC2", TARGET_POST, RawFilter(), 100)
        recorded = [e for e in payload["edges"] if e["provenanceKind"] == "recorded"]
        candidates = [e for e in payload["edges"] if e["provenanceKind"] == "candidate"]
        self.assertTrue(recorded)
        for edge in recorded:
            self.assertTrue(edge["evidenceEventIds"], f"记录边缺少证据：{edge['id']}")
        self.assertTrue(candidates)
        for edge in candidates:
            self.assertEqual(edge["ruleId"], "shared_prefix_hint")
            self.assertEqual(edge["evidenceEventIds"], [])
        self.assertEqual(payload["recorded_edge_count"], len(recorded))
        self.assertEqual(payload["candidate_edge_count"], len(candidates))

    def test_root_file_and_operations_are_linked(self) -> None:
        payload = traces("MC2", TARGET_POST, RawFilter(), 100)
        node_ids = {node["id"] for node in payload["nodes"]}
        self.assertIn(TARGET_FILE, node_ids)
        self.assertIn("MC2:event:21202", node_ids)  # 创建文件
        self.assertIn("MC2:event:373913", node_ids)  # 删除文件
        self.assertNotIn("MC2:event:373902", [e["targetId"] for e in payload["edges"] if e["sourceId"] == TARGET_FILE])

    def test_root_after_cursor_is_rejected(self) -> None:
        with get_conn() as conn:
            root_us = conn.execute(
                "SELECT time_sort_us FROM events WHERE dataset_id='MC2' AND event_id=?",
                (TARGET_POST,),
            ).fetchone()["time_sort_us"]
        with self.assertRaises(HTTPException) as ctx:
            traces("MC2", TARGET_POST, RawFilter(cursor_us=root_us - 1, masking=True), 100)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("root_after_cursor", ctx.exception.detail)

    def test_root_after_window_is_not_misreported_as_replay_conflict(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            traces("MC2", TARGET_POST, RawFilter(end_us=2410168875000000), 100)
        self.assertIn("root_outside_window", ctx.exception.detail)
        self.assertNotIn("root_after_cursor", ctx.exception.detail)

    def test_candidate_relay_count_is_reported_not_asserted(self) -> None:
        payload = traces("MC2", TARGET_POST, RawFilter(), 100)
        candidate_files = [n for n in payload["nodes"] if n.get("role") == "candidate_file"]
        self.assertEqual([n["id"] for n in candidate_files], [INSTRUCTION_FILE])
        self.assertEqual(candidate_files[0]["relay_event_count"], 186)
        # 候选文件不得出现在 files（= 有正文状态结论的文件）里
        self.assertEqual([item["file_id"] for item in payload["files"]], [TARGET_FILE])


class Mc2FileTrackTest(unittest.TestCase):
    """文件轨迹与事件流使用同一筛选上下文。"""

    def setUp(self) -> None:
        helpers.require_db(self)

    def test_track_matches_content_status(self) -> None:
        payload = file_track("MC2", TARGET_FILE, RawFilter(), 100, None, "asc")
        self.assertEqual(payload["meta"]["matched_events"], 3)
        self.assertEqual(len(payload["items"]), 3)
        self.assertEqual(payload["relation_counts"], {"file_path": 2, "post_content_source": 1})
        self.assertEqual(payload["file"]["content_status"], "metadata_only")

    def test_track_respects_half_open_window(self) -> None:
        """半开窗口 [start,end)：起点之后只剩删除事件，帖子本身被排除。"""
        with get_conn() as conn:
            start = conn.execute(
                "SELECT time_sort_us FROM events WHERE dataset_id='MC2' AND event_id=?",
                (TARGET_POST,),
            ).fetchone()["time_sort_us"]
        payload = file_track("MC2", TARGET_FILE, RawFilter(start_us=start + 1), 100, None, "asc")
        self.assertEqual(payload["meta"]["matched_events"], 1)
        self.assertEqual([item["event_id"] for item in payload["items"]], ["MC2:event:373913"])
        self.assertEqual(payload["event_type_counts"], {"delete_file": 1})
        self.assertEqual(payload["file"]["event_count"], 3)  # global summary remains explicit

    def test_non_mc2_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            file_track("MC1", TARGET_FILE, RawFilter(), 100, None, "asc")
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
