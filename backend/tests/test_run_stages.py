from __future__ import annotations
import unittest
from contextlib import contextmanager
from unittest.mock import patch
from . import helpers
from app.db import get_conn
from app.domain import run_stages
from app.routers import runs


class RunStagesTest(unittest.TestCase):
    def setUp(self):
        helpers.require_db(self)

    def test_default_compatible_and_exact_pagination(self):
        default = runs.list_runs(dataset="CUSTOM", limit=32)
        self.assertEqual(len(default["items"]), 32)
        self.assertNotIn("stage_dictionary", default)
        self.assertNotIn("stage_summary", default["items"][0])
        self.assertFalse(default["meta"]["truncated"])
        cut = runs.list_runs(dataset="CUSTOM", limit=31, include_stages=True)
        self.assertEqual(cut["meta"]["matched_runs_total"], 32)
        self.assertEqual(cut["meta"]["returned_runs"], 31)
        self.assertTrue(cut["meta"]["truncated"])
        observed = runs.list_runs(dataset="CUSTOM", observed=False, limit=500)
        exact = runs.list_runs(dataset="CUSTOM", observed=False, limit=len(observed["items"]))
        self.assertFalse(exact["meta"]["truncated"])

    def test_all_32_summaries_match_comparison_and_real_events(self):
        payload = runs.list_runs(dataset="CUSTOM", limit=500, include_stages=True)
        self.assertEqual(len(payload["items"]), 32)
        self.assertEqual(payload["meta"]["summary_scope"], "full_run")
        for item in payload["items"]:
            with self.subTest(run=item["run_id"]):
                if item["normal_run_id"]:
                    comparison = runs.run_comparison(item["run_id"], item["normal_run_id"], "CUSTOM")
                    for summary, pair in zip(item["stage_summary"], comparison["stages"]):
                        self.assertEqual(summary["key"], pair["stage"])
                        for key in ("count", "start_offset_us", "duration_us"):
                            self.assertEqual(summary[key], pair["run"][key])
                with get_conn() as conn:
                    events = runs._load_run_events(conn, [item["run_id"]])[item["run_id"]]
                by_id = {e["event_id"]: e for e in events}
                for summary in item["stage_summary"]:
                    self.assertLessEqual(len(summary["sample_event_ids"]), 3)
                    self.assertIn(summary["state"], ("recorded", "no_record"))
                    for event_id in summary["sample_event_ids"]:
                        self.assertEqual(run_stages.stage_of(by_id[event_id]), summary["key"])
                    matching = [e for e in events if run_stages.stage_of(e) == summary["key"]]
                    self.assertEqual(summary["count"], len(matching))
                    if matching:
                        self.assertEqual(summary["start_offset_us"], min(e["time_sort_us"] for e in matching) - item["start_us"])
                        self.assertEqual(summary["duration_us"], max(e["time_sort_us"] for e in matching) - min(e["time_sort_us"] for e in matching))

    def test_no_per_run_sql(self):
        queries = []
        @contextmanager
        def traced():
            with get_conn() as conn:
                conn.set_trace_callback(queries.append)
                yield conn
        with patch.object(runs, "get_conn", traced):
            runs.list_runs(dataset="CUSTOM", limit=500, include_stages=True)
        event_queries = [q for q in queries if "SELECT e.* FROM events" in q]
        self.assertEqual(len(event_queries), 1)
        self.assertEqual(len([q for q in queries if q.lstrip().upper().startswith("SELECT")]), 4)

    def test_unknown_no_record_zero_and_non_stage_event(self):
        events = [{"event_id": "zero", "event_type": "run_started", "actor_id": None, "time_sort_us": 0},
                  {"event_id": "ignore", "event_type": "agent_call_finished", "actor_id": None, "time_sort_us": 4}]
        summary = run_stages.summarize_run(events, 0, complete=True)
        self.assertEqual(summary[0]["state"], "recorded")
        self.assertEqual(summary[0]["start_offset_us"], 0)
        self.assertEqual(summary[0]["duration_us"], 0)
        self.assertEqual(summary[1]["state"], "no_record")
        self.assertEqual(summary[1]["count"], 0)
        self.assertIsNone(summary[1]["duration_us"])
        unknown = run_stages.summarize_run(events, None, complete=False)
        self.assertTrue(all(s["state"] == "unknown" and s["count"] is None for s in unknown))
        self.assertIsNone(run_stages.stage_of(events[1]))
