"""Real MC2 investigation paths; reads the existing imported database only."""
from __future__ import annotations

import unittest

try:
    from . import helpers
except ImportError:
    import helpers

from fastapi.testclient import TestClient
from app.main import app

FILE = "MC2:file_path:SwiftWren_further_instructions.md"
DAY = {"start_us": 2410128000000000, "end_us": 2410214400000000, "types": "queue_subordinate_task"}


class Mc2WorkspaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        helpers.require_db(cls)
        cls.client = TestClient(app)

    def get(self, endpoint, **params):
        response = self.client.get(f"/api/mc2/{endpoint}", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_full_type_matrix_and_gap_buckets(self):
        x = self.get("activity")
        self.assertEqual(len(x["types"]), 24)
        self.assertEqual(sum(c["count"] for c in x["cells"]), 185147)
        self.assertTrue(all(b - a == x["step"] for a, b in zip(x["buckets"], x["buckets"][1:])))
        x = self.get("activity", **DAY)
        self.assertEqual(x["meta"]["matched_events"], 15)
        self.assertEqual(sum(c["count"] for c in x["cells"]), 15)

    def test_fifteen_ten_five_and_exact_edge_evidence(self):
        facets = self.get("facets", **DAY)
        self.assertEqual(facets["meta"]["matched_events"], 15)
        self.assertEqual(facets["items"][0]["id"], FILE)
        self.assertEqual(facets["items"][0]["count"], 10)
        self.assertEqual(facets["missing"], 5)
        self.assertEqual(self.get("evidence", **DAY, no_file="true")["meta"]["matched_events"], 5)
        graph = self.get("relations", **DAY, file_id=FILE, mode="relay")
        self.assertEqual(graph["mapped_events"], 10)
        for edge in graph["edges"]:
            records = self.get("evidence", **DAY, file_id=FILE, relation=edge["relation"],
                               source=edge["source"], target=edge["target"], action=edge["action"])
            self.assertEqual(records["meta"]["matched_events"], edge["count"])
        task = self.get("process", **DAY, file_id=FILE, anchor="MC2:event:373893", context="true")
        self.assertTrue(task["valid"])
        self.assertEqual(len([i for i in task["items"] if i["event_id"] == "MC2:event:373893"]), 1)
        self.assertEqual(len(task["links"]), 1)

    def test_full_relay_missing_sources_and_roles(self):
        graph = self.get("relations", file_id=FILE, mode="relay")
        self.assertEqual(graph["meta"]["matched_events"], 188)
        self.assertEqual(graph["mapped_events"], 186)
        self.assertEqual(graph["missing_source_events"], 15)
        known = [e for e in graph["edges"] if e["source"] != "__missing__"]
        self.assertEqual(len(known), 107)
        self.assertEqual(len([n for n in graph["nodes"] if n["id"] != "__missing__"]), 18)
        self.assertEqual(sum(e["count"] for e in graph["edges"]), 186)

    def test_unknown_person_names_not_required_to_discover_incoming_task(self):
        x = self.get("process", anchor="MC2:event:373902", action="saidit_post", context="true", seconds=60)
        self.assertEqual(x["main_count"], 1)
        self.assertEqual(x["context_count"], 4)
        self.assertEqual([i["event_id"] for i in x["items"]], [f"MC2:event:{n}" for n in [373893, 373899, 373902, 373909, 373913]])
        task = x["items"][0]
        self.assertTrue(task["context"])
        self.assertTrue(any(r["relation"] == "queue_target_agent" and "john" in r["dst_id"] for r in task["roles"]))
        self.assertTrue(any("chloe" in lane["id"] for lane in x["lanes"]))
        actor = next(i["actor_id"] for i in x["items"] if i["event_id"] == "MC2:event:373902")
        participating = self.get("evidence", start_us=x["start"], end_us=x["end"], participant=actor)
        self.assertIn("MC2:event:373893", [i["event_id"] for i in participating["items"]])
        local = self.get("process", anchor="MC2:event:373893", participant=actor, context="true")
        self.assertEqual(local["main_count"], 5)
        self.assertEqual(local["context_count"], 0)

    def test_expired_anchor_stops_drawing_and_zero_results_stay_empty(self):
        x = self.get("process", anchor="MC2:event:373902", start_us=2410214400000000)
        self.assertFalse(x["valid"])
        self.assertEqual(x["items"], [])
        x = self.get("activity", q="no-such-mc2-record-721983")
        self.assertEqual(x["meta"]["matched_events"], 0)
        self.assertEqual(x["cells"], [])

    def test_paging_is_stable_and_rejects_cursor_from_other_scope(self):
        first = self.get("evidence", file_id=FILE, distribution="true")
        self.assertEqual(len(first["items"]), 40)
        self.assertEqual(sum(b["count"] for b in first["timeline"]), 188)
        second = self.get("evidence", file_id=FILE, cursor=first["next_cursor"])
        self.assertFalse(set(i["event_id"] for i in first["items"]) & set(i["event_id"] for i in second["items"]))
        bad = self.client.get("/api/mc2/evidence", params={**DAY, "cursor": first["next_cursor"]})
        self.assertEqual(bad.status_code, 400)

    def test_file_family_does_not_expand_all_file_entities(self):
        x = self.get("relations", mode="system", relation="file_path")
        self.assertTrue(x["needs_file"])
        self.assertEqual(x["nodes"], [])

    def test_comparison_only_explicit_sources_and_real_intervals(self):
        x = self.get("comparison")
        self.assertEqual(x["total"], 3)
        self.assertTrue(all(i["delete_lag_us"] == 2_000_000 for i in x["items"]))
        hidden = next(i for i in x["items"] if i["path"] == "HiddenOrca.txt")
        self.assertIsNone(hidden["create_lag_us"])
        self.assertTrue(all(i["content_status"] != "available" for i in x["items"]))


if __name__ == "__main__":
    unittest.main()
