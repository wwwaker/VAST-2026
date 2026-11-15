"""Persistent projections must agree with evidence-backed live aggregation."""
import os
import sqlite3
import unittest
from unittest.mock import patch

from . import helpers
import app.domain.mc2.projection as mc2_projection
from app.domain.mc2.relations import type_overview
from app.query.filters import DAY_US, RawFilter
from app.routers.mc2_workspace import RELATIONS, selected, meta, _facet_data, _relations


class Mc2ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.path = helpers.build_tiny_db([
            {"event_id": "a", "time_us": 10, "actor_id": "agent:a", "event_type": "queue_subordinate_task"},
            {"event_id": "b", "time_us": DAY_US + 20, "actor_id": None, "event_type": "queue_subordinate_task"},
            {"event_id": "c", "time_us": DAY_US + 30, "actor_id": "person:b", "event_type": "read_file"},
            {"event_id": "d", "time_us": 2 * DAY_US + 40, "actor_id": "person:b", "event_type": "saidit_post"},
        ], dataset="MC2")
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executemany("INSERT INTO entities(dataset_id,entity_id,entity_type,label,source_value) VALUES('MC2',?,?,?,?)", [
            ("agent:a", "agent", "A", "A-source"), ("person:b", "person", "B", "B-source"),
            ("file:f", "file_path", "F", "file.txt"), ("sys:s", "system", "S", "mail"),
        ])
        self.conn.executemany("INSERT INTO relations(dataset_id,event_id,src_id,dst_id,relation,derivation,target_kind) VALUES('MC2',?,?,?,?, 'test',?)", [
            ("a", "agent:a", "person:b", "queue_target_person", "entity"),
            ("a", "agent:a", "person:b", "queue_target_person", "entity"),
            ("a", "agent:a", "file:f", "queued_file_path", "entity"),
            ("a", None, "b", "queue_target_person", "event"),
            ("b", None, "person:b", "queue_target_person", "entity"),
            ("c", "person:b", "file:f", "file_path", "entity"),
            ("c", "person:b", "file:f", "post_content_source", "entity"),
            ("c", "person:b", "sys:s", "system_party", "entity"),
        ])
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        for path in (self.path, self.path + "-wal", self.path + "-shm", mc2_projection.projection_path(self.path)):
            if os.path.exists(path):
                os.remove(path)

    def test_daily_full_category_and_replay_scopes_match_live_results(self):
        mc2_projection.build(self.path)
        for raw in [RawFilter(), RawFilter(start_us=DAY_US, end_us=2 * DAY_US),
                    RawFilter(types="queue_subordinate_task"), RawFilter(categories="4"),
                    RawFilter(masking=True, cursor_us=2 * DAY_US - 1), RawFilter(types="unknown-type")]:
            with self.subTest(raw=raw):
                sel = selected(raw)
                expected = type_overview(self.conn, sel, meta(self.conn, sel), RELATIONS)
                actual = mc2_projection.overview(self.conn, sel, RELATIONS)
                self.assertEqual(actual, expected)
        # The same event supports several roles, but only counts once as mapped.
        actual = mc2_projection.overview(self.conn, selected(RawFilter()), RELATIONS)
        self.assertEqual(actual["mapped_events"], 3)
        self.assertEqual(actual["missing_source_events"], 2)

    def test_object_counts_and_missing_groups_match_live_queries(self):
        raw = RawFilter()
        expected = {kind: _facet_data(self.conn, selected(raw), raw, kind) for kind in ("file", "actor", "system")}
        mc2_projection.build(self.path)
        for kind in expected:
            self.assertEqual(mc2_projection.facets(self.conn, selected(raw), kind), expected[kind])

    def test_endpoint_details_match_live_queries_for_modes_and_daily_scopes(self):
        mc2_projection.build(self.path)
        for raw in [RawFilter(), RawFilter(start_us=DAY_US, end_us=2 * DAY_US),
                    RawFilter(types="queue_subordinate_task"), RawFilter(types="unknown-type"),
                    RawFilter(categories="4"), RawFilter(masking=True, cursor_us=2 * DAY_US - 1)]:
            for mode, role in [("system", "queue_target_person"), ("system", "system_party"),
                               ("system", "file_path"), ("system", "unknown"),
                               ("relay", None), ("operations", None)]:
                with self.subTest(raw=raw, mode=mode, role=role):
                    sel = selected(raw)
                    actual = mc2_projection.details(self.conn, sel, None, mode, role, RELATIONS)
                    with patch("app.domain.mc2.projection.details", return_value=None):
                        expected = _relations(self.conn, sel, None, mode, role)
                    self.assertIsNotNone(actual)
                    # SQL ties do not specify edge order; compare full records by key.
                    for payload in (actual, expected):
                        payload["edges"].sort(key=lambda e: (e["source"], e["target"], e["relation"], e["action"]))
                    self.assertEqual(actual, expected)
        result = mc2_projection.details(self.conn, selected(RawFilter()), None, "system", "queue_target_person", RELATIONS)
        self.assertEqual(result["mapped_events"], 2)
        self.assertEqual(result["missing_source_events"], 2)  # Includes the recorded event target.
        self.assertEqual(sum(e["count"] for e in result["edges"]), 2)  # Duplicate role rows deduplicate.

    def test_endpoint_role_unions_deduplicate_events_and_keep_file_fallback(self):
        self.conn.execute("INSERT INTO relations(dataset_id,event_id,src_id,dst_id,relation,derivation,target_kind) "
                          "VALUES('MC2','a',NULL,'agent:a','queue_target_agent','test','entity')")
        self.conn.commit()
        mc2_projection.build(self.path)
        result = mc2_projection.details(self.conn, selected(RawFilter()), None, "relay", None, RELATIONS)
        self.assertEqual(result["mapped_events"], 2)
        self.assertEqual(result["missing_source_events"], 2)
        self.assertEqual(sum(e["count"] for e in result["edges"]), 3)
        self.assertEqual(result["unmapped_events"], 2)
        for sel in [selected(RawFilter(), file_id="file:f"), selected(RawFilter(), no_file=True),
                    selected(RawFilter(actor="agent:a")), selected(RawFilter(start_us=DAY_US + 21))]:
            self.assertIsNone(mc2_projection.details(self.conn, sel, "file:f", "relay", None, RELATIONS))

    def test_partial_times_extra_filters_and_file_subsets_use_exact_fallback(self):
        mc2_projection.build(self.path)
        for raw in [RawFilter(start_us=DAY_US + 21), RawFilter(keyword="test"),
                    RawFilter(actor="agent:a"), RawFilter(participant="person:b")]:
            self.assertIsNone(mc2_projection.overview(self.conn, selected(raw), RELATIONS))
        self.assertIsNone(mc2_projection.overview(self.conn, selected(RawFilter(), file_id="file:f"), RELATIONS))
        self.assertIsNone(mc2_projection.overview(self.conn, selected(RawFilter(), no_file=True), RELATIONS))
        rows = list(mc2_projection.relation_rows(self.conn, selected(RawFilter(start_us=DAY_US + 21))))
        self.assertEqual({r[0] for r in rows}, {"c"})

    def test_missing_stale_and_corrupt_projections_fall_back(self):
        sel = selected(RawFilter())
        self.assertIsNone(mc2_projection.overview(self.conn, sel, RELATIONS))
        mc2_projection.build(self.path)
        self.conn.execute("UPDATE datasets SET data_version='changed' WHERE dataset_id='MC2'")
        self.conn.commit()
        self.assertIsNone(mc2_projection.overview(self.conn, sel, RELATIONS))
        with open(mc2_projection.projection_path(self.path), "wb") as handle:
            handle.write(b"not a database")
        self.assertIsNone(mc2_projection.overview(self.conn, sel, RELATIONS))

    def test_failed_rebuild_keeps_previous_projection_and_source(self):
        mc2_projection.build(self.path)
        before = mc2_projection.overview(self.conn, selected(RawFilter()), RELATIONS)
        with patch("app.domain.mc2.projection.os.replace", side_effect=OSError("test failure")):
            with self.assertRaises(OSError):
                mc2_projection.build(self.path)
        self.assertEqual(mc2_projection.overview(self.conn, selected(RawFilter()), RELATIONS), before)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], 4)


if __name__ == "__main__":
    unittest.main()
