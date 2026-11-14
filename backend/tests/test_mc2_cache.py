"""Projection cache lifecycle and event-level aggregation on a small database."""
import os
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Barrier, Event, Lock
from unittest.mock import patch

from . import helpers
from app.domain import mc2_cache
from app.domain.mc2_relations import type_overview
from app.query.filters import RawFilter
from app.routers.mc2_workspace import RELATIONS, base, meta


class Mc2CacheTests(unittest.TestCase):
    def setUp(self):
        self.path = helpers.build_tiny_db([
            {"event_id": "e1", "time_us": 10, "actor_id": "agent:a"},
            {"event_id": "e2", "time_us": 20, "actor_id": None},
        ], dataset="MC2")
        self.conn = self.connect()
        self.calls = 0
        mc2_cache.clear_cache()

    def connect(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def tearDown(self):
        self.conn.close()
        mc2_cache.clear_cache()
        for path in (self.path, self.path + "-wal", self.path + "-shm"):
            if os.path.exists(path):
                os.unlink(path)

    def compute(self):
        self.calls += 1
        return {"call": self.calls}

    def test_repeated_reads_reuse_cache_but_distinct_keys_do_not(self):
        first = mc2_cache.cached(self.conn, ("scope-a",), self.compute)
        self.assertEqual(first, mc2_cache.cached(self.conn, ("scope-a",), self.compute))
        self.assertNotEqual(first, mc2_cache.cached(self.conn, ("scope-b",), self.compute))
        self.assertEqual(self.calls, 2)

    def test_empty_wal_recreation_does_not_invalidate_read_cache(self):
        self.conn.execute("PRAGMA journal_mode=WAL")
        first = mc2_cache.cached(self.conn, ("scope",), self.compute)
        self.conn.close()
        self.conn = self.connect()
        self.assertEqual(first, mc2_cache.cached(self.conn, ("scope",), self.compute))
        self.assertEqual(self.calls, 1)

    def test_wal_commit_and_data_version_changes_invalidate_cache(self):
        self.conn.execute("PRAGMA journal_mode=WAL")
        mc2_cache.cached(self.conn, ("scope",), self.compute)
        with closing(self.connect()) as writer:
            with writer:
                writer.execute("UPDATE events SET actor_id='changed' WHERE event_id='e1'")
        mc2_cache.cached(self.conn, ("scope",), self.compute)
        self.conn.execute("UPDATE datasets SET data_version='new-version'")
        self.conn.commit()
        mc2_cache.cached(self.conn, ("scope",), self.compute)
        self.assertEqual(self.calls, 3)

    def test_database_replacement_with_same_version_invalidates_cache(self):
        mc2_cache.cached(self.conn, ("scope",), self.compute)
        self.conn.close()
        replacement = helpers.build_tiny_db([{"event_id": "new", "time_us": 30}], dataset="MC2")
        os.replace(replacement, self.path)
        self.conn = self.connect()
        mc2_cache.cached(self.conn, ("scope",), self.compute)
        self.assertEqual(self.calls, 2)

    def test_expiry_and_entry_limit_allow_recomputation(self):
        clock = [0]
        with patch.object(mc2_cache, "monotonic", lambda: clock[0]), patch.object(mc2_cache, "_MAX_ENTRIES", 2):
            for key in ("a", "b", "c", "a"):
                mc2_cache.cached(self.conn, key, self.compute)
            self.assertEqual(self.calls, 4)
            clock[0] = 121
            mc2_cache.cached(self.conn, "a", self.compute)
            self.assertEqual(self.calls, 5)

    def test_errors_and_oversized_results_are_not_cached(self):
        with self.assertRaisesRegex(ValueError, "failed"):
            mc2_cache.cached(self.conn, "error", lambda: (_ for _ in ()).throw(ValueError("failed")))
        self.assertEqual(mc2_cache.cached(self.conn, "error", self.compute), {"call": 1})
        with patch.object(mc2_cache, "_MAX_BYTES", 1):
            mc2_cache.cached(self.conn, "large", self.compute)
            mc2_cache.cached(self.conn, "large", self.compute)
        self.assertEqual(self.calls, 3)

    def test_identical_concurrent_reads_share_one_computation(self):
        ready, started, release = Barrier(4), Event(), Event()
        count_lock = Lock()
        def compute():
            with count_lock:
                self.calls += 1
            started.set()
            self.assertTrue(release.wait(5))
            return {"ok": True}
        def read():
            conn = self.connect()
            try:
                ready.wait(5)
                return mc2_cache.cached(conn, "concurrent", compute)
            finally:
                conn.close()
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(read) for _ in range(4)]
            self.assertTrue(started.wait(5))
            release.set()
            self.assertEqual([f.result(5) for f in futures], [{"ok": True}] * 4)
        self.assertEqual(self.calls, 1)

    def test_type_overview_deduplicates_roles_edges_members_and_missing_sources(self):
        self.conn.executemany(
            "INSERT INTO entities(dataset_id,entity_id,entity_type) VALUES('MC2',?,?)",
            [("agent:a", "agent"), ("agent:b", "agent"), ("person:c", "person")])
        self.conn.executemany(
            "INSERT INTO relations(dataset_id,event_id,src_id,dst_id,relation,derivation,target_kind) "
            "VALUES('MC2',?,?,?,?, 'source:test',?)", [
                ("e1", "agent:a", "agent:b", "queue_target_agent", "entity"),
                ("e1", "agent:a", "agent:b", "queue_target_agent", "entity"),
                ("e1", "agent:a", "person:c", "queue_target_person", "entity"),
                ("e2", None, "agent:b", "queue_target_agent", "entity"),
                ("e1", None, "e2", "queue_target_agent", "event"),
            ])
        self.conn.commit()
        selection = base(RawFilter())
        result = type_overview(self.conn, selection, meta(self.conn, selection), RELATIONS)
        self.assertEqual(result["mapped_events"], 2)
        self.assertEqual(result["missing_source_events"], 2)
        counts = {r["relation"]: r["count"] for r in result["relation_counts"]}
        self.assertEqual(counts, {"queue_target_agent": 2, "queue_target_person": 1})
        self.assertEqual(len(result["edges"]), 3)
        self.assertTrue(all(edge["count"] == 1 for edge in result["edges"]))
        nodes = {n["id"]: n["label"] for n in result["nodes"]}
        self.assertIn("2 个活跃实体", nodes["agent"])
        self.assertIn("1 个活跃实体", nodes["person"])
        self.assertIn("0 个活跃实体", nodes["unknown"])


if __name__ == "__main__":
    unittest.main()
