from __future__ import annotations
import copy
import json
import sqlite3
import unittest
from unittest.mock import patch
try:
    from . import helpers
    from .test_custom_audit import event, base_events, HASH, RUN
except ImportError:
    import helpers
    from test_custom_audit import event, base_events, HASH, RUN
from app.domain.custom_audit import audit_run
from app.domain.custom_projection import project
from app.routers import runs


class AuditBoundaries(unittest.TestCase):
    def events(self):
        return base_events({"review_event_id": "review", "sha256": HASH, "expected_version": 1}, {"approved": True, "sha256": HASH}, {"status": "success", "sha256": HASH, "attempt_event_id": "attempt"})

    def test_mutual_uniqueness_prevents_result_claiming(self):
        es = self.events()
        result = next(e for e in es if e["event_id"] == "result")
        result["details"].pop("attempt_event_id")
        second = copy.deepcopy(next(e for e in es if e["event_id"] == "attempt"))
        second.update(event_id="attempt2", time_sort_us=210)
        es.append(second)
        for order in [es, list(reversed(es))]:
            attempts = audit_run(order)["attempts"]
            self.assertTrue(all(a["publish"]["pairing"] == "ambiguous" for a in attempts))
            self.assertTrue(all(a["publish"]["status"] == "unknown" for a in attempts))

    def test_multiple_explicit_results_are_conflict(self):
        es = self.events(); duplicate = copy.deepcopy(es[-1]); duplicate["event_id"] = "other-result"; es.append(duplicate)
        self.assertEqual(audit_run(es)["attempts"][0]["publish"]["status"], "conflict")

    def test_denied_with_success_write_is_conflict(self):
        es = self.events(); es[-1]["details"]["status"] = "denied"
        es.append(event("write", "file_write", 250, actor_id=f"{RUN}:publisher", parent_event_id="attempt", version=1, details={"status": "success", "sha256": HASH}))
        self.assertEqual(audit_run(es)["attempts"][0]["publish"]["status"], "conflict")

    def test_hash_conflict_is_not_old_version(self):
        es = self.events(); es[-1]["details"]["sha256"] = "b" * 64
        result = audit_run(es)["attempts"][0]["publish"]
        self.assertEqual(result["status"], "conflict")
        self.assertIsNone(result["actual_version"])

    def test_denial_cannot_hide_matching_unlinked_success_write(self):
        es = self.events(); es[-1]["details"]["status"] = "denied"
        es.append(event("write", "file_write", 250, actor_id=f"{RUN}:publisher", version=1, details={"status": "success", "sha256": HASH}))
        result = audit_run(es)["attempts"][0]["publish"]
        self.assertEqual(result["status"], "conflict")
        self.assertIn("write", result["evidence_event_ids"])
        self.assertEqual(result["write_event_ids"], [])

    def test_parent_version_cannot_be_created_after_child(self):
        es = self.events()
        es.append(event("child", "version_updated", 1, version=2, details={"previous_version": 1, "sha256": "b" * 64}))
        self.assertEqual(audit_run(es)["attempts"][0]["version_check"]["status"], "conflict")

    def test_wrong_review_actor_and_read_type(self):
        es = self.events(); es[2]["actor_id"] = f"{RUN}:writer"
        self.assertEqual(audit_run(es)["attempts"][0]["review"]["status"], "invalid")
        es.append(event("read", "agent_message", 150, actor_id=f"{RUN}:publisher", version=1, details={"sha256": HASH}))
        next(e for e in es if e["event_id"] == "attempt")["details"]["read_event_id"] = "read"
        self.assertEqual(audit_run(es)["attempts"][0]["version_check"]["read_status"], "invalid")

    def test_incomplete_current_version_is_unknown(self):
        self.assertEqual(audit_run(self.events(), complete=False)["attempts"][0]["version_check"]["status"], "unknown")

    def test_current_version_conflict(self):
        es = self.events(); es.append(event("branch", "version_updated", 20, version=3, details={"previous_version": None, "sha256": "b" * 64}))
        self.assertEqual(audit_run(es)["attempts"][0]["version_check"]["status"], "conflict")

    def test_handoffs_do_not_cross_tasks(self):
        es = [event("h1", "task_handoff", 1, actor_id=f"{RUN}:coordinator", target_id=f"{RUN}:researcher", task_id="one"), event("h2", "task_handoff", 2, actor_id=f"{RUN}:coordinator", target_id=f"{RUN}:researcher", task_id="two")]
        self.assertEqual(audit_run(es)["summary"]["repeated_handoff"], 0)


class RealProjection(unittest.TestCase):
    def setUp(self):
        self.c = sqlite3.connect(helpers.require_db(self)); self.c.row_factory = sqlite3.Row; self.addCleanup(self.c.close)

    def load(self, run):
        es = []
        for row in self.c.execute("select * from events where run_id=? order by time_sort_us,event_id", (run,)):
            e = dict(row); e["details"] = json.loads(e["details_json"] or "{}"); es.append(e)
        return project(es, len(es), "test")

    def test_stale_graph_direction_and_route(self):
        p = self.load("run-91134b6f7c5e455782a739185bd7ce8f")
        kinds = {n["id"]: n["kind"] for n in p["nodes"]}
        directions = {(kinds[e["source"]], kinds[e["target"]]) for e in p["edges"]}
        self.assertIn(("attempt", "copy"), directions); self.assertIn(("copy", "result"), directions)
        self.assertNotIn(("result", "copy"), directions)
        self.assertTrue(any(n["kind"] == "route" and n["details"]["selected_version"] == 1 for n in p["nodes"]))
        self.assertTrue(p["coverage"]["complete"])
        self.assertEqual(p["content_availability"]["version_bodies"], 0)
        self.assertEqual(p["audit"]["attempts"][0]["version_check"]["status"], "stale")
        self.assertEqual(p["content_availability"]["referenced_call_attachments"], 6)

    def test_normal_rework_preserves_both_reviews(self):
        p = self.load("run-b81ba9e2da7f4f7fa3bfab61efedee50")
        self.assertEqual(len([n for n in p["nodes"] if n["kind"] == "review"]), 2)
        self.assertEqual(p["audit"]["summary"]["published_current"], 1)

    def test_valid_review_denial_has_no_copy(self):
        p = self.load("run-a96ed3823093429882d5aac7b50d6cac")
        a = p["audit"]["attempts"][0]
        self.assertEqual(a["review"]["status"], "valid"); self.assertEqual(a["publish"]["status"], "denied")
        self.assertIsNone(a["publish"]["actual_version"])
        self.assertFalse(any(n["kind"] == "copy" for n in p["nodes"]))

    def test_batch_projection_conserves_sources_and_audit(self):
        rows = self.c.execute("SELECT run_id FROM runs WHERE dataset_id='CUSTOM'").fetchall()
        projections = [self.load(row["run_id"]) for row in rows]
        self.assertEqual(len(projections), 32)
        self.assertEqual(sum(len(p["events"]) for p in projections), 1103)
        self.assertEqual(sum(len(p["calls"]) for p in projections), 180)
        self.assertEqual(sum(len(p["versions"]) for p in projections), 42)
        for p in projections:
            self.assertTrue(p["coverage"]["complete"])
            event_ids = {e["event_id"] for e in p["events"]}
            node_ids = {n["id"] for n in p["nodes"]}
            for edge in p["edges"]:
                self.assertIn(edge["source"], node_ids)
                self.assertIn(edge["target"], node_ids)
                self.assertTrue(set(edge["source_event_ids"]).issubset(event_ids))
                self.assertTrue(edge["field"])
            for call in p["calls"]:
                self.assertTrue(set(call["source_event_ids"]).issubset(event_ids))
        total = lambda key: sum(p["audit"]["summary"][key] for p in projections)
        self.assertEqual([total(k) for k in ["review_valid", "review_invalid", "published_current", "published_stale", "denied"]], [22, 10, 24, 5, 3])

    def test_comparison_cannot_pair_a_normal_run_with_itself(self):
        run = "run-b81ba9e2da7f4f7fa3bfab61efedee50"
        self.assertFalse(runs.run_comparison(run, run, "CUSTOM")["pair"]["valid"])

    def test_comparison_respects_missing_event_coverage(self):
        run = "run-91134b6f7c5e455782a739185bd7ce8f"
        original = runs._load_run_events
        def missing(conn, ids):
            data = original(conn, ids)
            data[run] = [e for e in data[run] if e["event_type"] != "version_updated"]
            return data
        with patch.object(runs, "_load_run_events", missing):
            result = runs.run_comparison(run, dataset="CUSTOM")
        self.assertEqual(result["audit"]["run"]["version_unknown"], 1)
        self.assertEqual(result["audit"]["run"]["version_stale"], 0)


if __name__ == "__main__":
    unittest.main()
