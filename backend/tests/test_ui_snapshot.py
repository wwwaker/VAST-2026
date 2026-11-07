from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from . import helpers
from fastapi import HTTPException
from app import case_store, notes_store
from app.db import get_conn
from app.domain import ui_snapshot
from app.routers.cases import CaseCreate, create_case, export_case, get_case


def snapshot(dataset="MC2"):
    modes = {task: options[0] for task, options in ui_snapshot.CAPABILITIES[dataset].items()}
    trace = {"dataset": dataset, **({"rootEventId": "MC2:event:373902", "fileId": None} if dataset == "MC2" else {"runId": "missing-run"} if dataset == "CUSTOM" else {"windowUs": None})}
    return {
        "contract_version": 2, "ui_state_version": 1, "dataset_id": dataset,
        "task": "overview", "mode": modes["overview"], "task_modes": modes,
        "base_filters": {"startUs": None, "endUs": None, "categories": [], "eventTypes": [], "actorId": None, "participantId": None, "channels": [], "keyword": ""},
        "trace_object": trace, "selection": None, "comparison": None, "return_point": None,
        "viewports": {"time": {"startUs": 0, "endUs": 3, "expanded": ["x"]}},
        "graph_context": {"focusedEntityId": None, "depth": 2, "transform": {"x": 1, "y": 2, "k": 1.5}},
        "collection_filters": {"model": None, "fixture": None, "scenario": None, "observed": False},
        "replay": {"cursorUs": 0, "masking": False}, "intervention_position": None, "pinned_evidence": [],
    }


class UiSnapshotTest(unittest.TestCase):
    def setUp(self):
        helpers.require_db(self)
        handle, self.path = tempfile.mkstemp(suffix=".notes.db")
        os.close(handle)
        self.patcher = patch.object(notes_store, "NOTES_DB", self.path)
        self.patcher.start()
        notes_store.ensure_schema()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.patcher.stop()
        os.remove(self.path)

    def create(self, value, dataset="MC2"):
        return create_case(CaseCreate(dataset_id=dataset, title="S0 isolated", snapshot=value))

    def test_v1_save_read_export_preserves_all_fields(self):
        value = snapshot()
        value["return_point"] = {k: v for k, v in copy.deepcopy(value).items() if k not in ("contract_version", "ui_state_version", "return_point")}
        created = self.create(value)
        self.assertEqual(get_case(created["case_id"])["snapshot"], value)
        response = export_case(created["case_id"], "json")
        self.assertEqual(json.loads(response.body)["snapshot"], value)
        md = export_case(created["case_id"], "md").body.decode("utf-8")
        self.assertIn('"collection_filters"', md)
        self.assertIn('"return_point"', md)
        self.assertEqual(get_case(created["case_id"])["snapshot_status"]["status"], "v1")

    def test_typescript_fixture_contract(self):
        # The checked-in frontend script produces this artifact from its actual serializer.
        fixture = os.path.join(helpers.ROOT, "build", "ui-refactor", "S0", "snapshot-v1-fixture.json")
        if not os.path.exists(fixture):
            self.skipTest("run node frontend/scripts/check_workspace.mjs for cross-language fixture")
        with open(fixture, encoding="utf-8") as handle:
            value = json.load(handle)
        created = self.create(value, "CUSTOM")
        self.assertEqual(get_case(created["case_id"])["snapshot"], value)
        with open(os.path.join(os.path.dirname(fixture), "snapshot-mode-fixtures.json"), encoding="utf-8") as handle:
            for mode_fixture in json.load(handle):
                with self.subTest(dataset=mode_fixture["dataset_id"], mode=mode_fixture["mode"]):
                    created = self.create(mode_fixture, mode_fixture["dataset_id"])
                    self.assertEqual(get_case(created["case_id"])["snapshot"], mode_fixture)

    def test_missing_same_dataset_retained_and_reported(self):
        value = snapshot()
        value["selection"] = {"kind": "event", "id": "MC2:event:missing-s0", "timeUs": None}
        created = self.create(value)
        fetched = get_case(created["case_id"])
        self.assertEqual(fetched["snapshot"], value)
        self.assertIn({"kind": "event", "id": "MC2:event:missing-s0"}, fetched["snapshot_status"]["missing_references"])

    def test_invalid_rejected_before_any_case_is_written(self):
        fixtures = []
        for key, value in (("mode", "runPair"), ("ui_state_version", 2), ("ui_state_version", True), ("dataset_id", "MC1"), ("selection", {"kind": "event", "id": "MC1:event:missing", "timeUs": None}), ("replay", {"cursorUs": 1.1, "masking": True}), ("viewports", {"hover": {}})):
            s = snapshot(); s[key] = value; fixtures.append(s)
        s = snapshot(); s["base_filters"]["runId"] = "hidden"; fixtures.append(s)
        s = snapshot(); s["base_filters"]["keyword"] = "中" * 100000; fixtures.append(s)
        s = snapshot(); s["comparison"] = {"kind": "window", "dimension": "actor", "currentUs": [1, 2], "baselineMode": "auto", "baselineUs": None}; fixtures.append(s)
        s = snapshot(); s["task_modes"] = []; fixtures.append(s)
        s = snapshot(); s["graph_context"]["depth"] = True; fixtures.append(s)
        s = snapshot(); s["trace_object"]["rootEventId"] = []; fixtures.append(s)
        for value in fixtures:
            with self.subTest(value=str(value)[:100]):
                with self.assertRaises(HTTPException) as ctx:
                    self.create(value)
                self.assertEqual(ctx.exception.status_code, 422)
                self.assertEqual(case_store.list_cases("MC2"), [])

    def test_existing_reference_ownership_checked_from_db_even_without_prefix(self):
        # A run ID has no dataset prefix. It must still be rejected in a MC2 entity field.
        value = snapshot()
        with get_conn() as conn:
            run_id = conn.execute("SELECT run_id FROM runs LIMIT 1").fetchone()[0]
        value["graph_context"]["focusedEntityId"] = run_id
        with self.assertRaises(HTTPException):
            self.create(value)

    def test_return_point_cross_dataset_reference_rejected(self):
        value = snapshot()
        point = {k: v for k, v in copy.deepcopy(value).items() if k not in ("contract_version", "ui_state_version", "return_point")}
        point["selection"] = {"kind": "event", "id": "MC1:event:20460605_21_026", "timeUs": None}
        value["return_point"] = point
        with self.assertRaises(HTTPException):
            self.create(value)

    def test_legacy_read_and_export_preserve_unknown_fields(self):
        value = {"canvas_view": "trace", "filters": {"keyword": "x"}, "old_extra": {"x": 1}}
        created = self.create(value)
        fetched = get_case(created["case_id"])
        self.assertEqual(fetched["snapshot"]["old_extra"], {"x": 1})
        self.assertEqual(fetched["snapshot_status"]["status"], "legacy")

    def test_stored_future_versions_export_losslessly_and_cannot_post(self):
        value = {"ui_state_version": 99, "dataset_id": "MC2", "future": {"opaque": [1, 2, 3]}}
        created = case_store.create_case(dataset_id="MC2", title="future", snapshot=value, data_version="old-version")
        fetched = get_case(created["case_id"])
        self.assertTrue(fetched["stale"])
        self.assertFalse(fetched["snapshot_status"]["restorable"])
        exported = json.loads(export_case(created["case_id"], "json").body)
        self.assertEqual(exported["snapshot"], value)
        self.assertIn('"future"', export_case(created["case_id"], "md").body.decode("utf-8"))
        with self.assertRaises(HTTPException):
            self.create(value)

    def test_pinned_context_does_not_become_event_evidence(self):
        value = snapshot("MC1")
        value["pinned_evidence"] = [{"event_id": "env:21:media_events:0", "dataset": "MC1", "role": "support", "label": "background", "excerpt": ""}]
        with self.assertRaises(HTTPException):
            self.create(value, "MC1")

    def test_malformed_legacy_rejected_and_stored_copy_remains_exportable(self):
        for key, bad in (("selection", True), ("comparison", [1]), ("filters", True),
                         ("trace_object", 1), ("graph_context", []), ("return_point", True),
                         ("pinned_evidence", [True]), ("run_pair", True)):
            with self.subTest(key=key):
                value = {"canvas_view": "timeline", key: bad}
                before = len(case_store.list_cases("MC1"))
                with self.assertRaises(HTTPException) as ctx:
                    self.create(value, "MC1")
                self.assertEqual(ctx.exception.status_code, 422)
                self.assertEqual(len(case_store.list_cases("MC1")), before)
                stored = case_store.create_case(dataset_id="MC1", title="old damaged", snapshot=value, data_version="old")
                fetched = get_case(stored["case_id"])
                self.assertEqual(fetched["snapshot_status"]["status"], "invalid")
                self.assertFalse(fetched["snapshot_status"]["restorable"])
                self.assertEqual(fetched["snapshot"], value)
                self.assertEqual(json.loads(export_case(stored["case_id"], "json").body)["snapshot"], value)
                self.assertIn("完整调查快照", export_case(stored["case_id"], "md").body.decode("utf-8"))

    def test_legacy_opaque_extensions_are_preserved_and_not_scanned_as_v1(self):
        value = {"filters": {}, "comparison": {"includedRootIds": True},
                 "selection": {"eventIds": False}, "custom_extension": [True, {"x": 1}]}
        created = self.create(value)
        fetched = get_case(created["case_id"])
        self.assertEqual(fetched["snapshot_status"]["status"], "legacy")
        self.assertEqual(fetched["snapshot"], {**value, "contract_version": 2, "dataset_id": "MC2"})

    def test_canonical_modes_and_v1_aliases_validate_without_rewriting_storage(self):
        for dataset in ("MC1", "MC2", "CUSTOM"):
            self.assertIn("time", ui_snapshot.CAPABILITIES[dataset]["overview"])
            self.assertIn("relations", ui_snapshot.CAPABILITIES[dataset]["overview"])
            self.assertIn("localGraph", ui_snapshot.CAPABILITIES[dataset]["trace"])
        self.assertIn("decision", ui_snapshot.CAPABILITIES["MC1"]["trace"])
        for dataset in ui_snapshot.CAPABILITIES:
            for task, modes in ui_snapshot.CAPABILITIES[dataset].items():
                for mode in modes:
                    with self.subTest(dataset=dataset, task=task, mode=mode):
                        value = snapshot(dataset)
                        value.update(task=task, mode=mode)
                        value["task_modes"][task] = mode
                        if task == "compare":
                            value["comparison"] = {
                                "window": {"kind": "window", "dimension": "actor", "currentUs": None, "baselineMode": "auto", "baselineUs": None},
                                "history": {"kind": "history", "targetRootId": None, "includedRootIds": [], "alignment": "stage", "beforeUs": None},
                                "transitions": {"kind": "transitions", "selectedPair": None, "maxLagUs": None},
                                "runPair": {"kind": "runPair", "runId": "missing-run", "baselineRunId": None},
                            }[mode]
                        created = self.create(value, dataset)
                        self.assertEqual(get_case(created["case_id"])["snapshot_status"]["status"], "v1")
        for dataset, task, alias, canonical in (("MC1", "overview", "timeline", "time"),
                ("CUSTOM", "overview", "local", "relations"), ("MC1", "trace", "messages", "decision"),
                ("MC2", "trace", "file", "source")):
            value = snapshot(dataset); value.update(task=task, mode=alias); value["task_modes"][task] = alias
            value["return_point"] = {k: copy.deepcopy(v) for k, v in value.items() if k not in ("ui_state_version", "contract_version", "return_point")}
            created = self.create(value, dataset)
            fetched = get_case(created["case_id"])
            self.assertEqual(fetched["snapshot"], value)
            self.assertTrue(fetched["snapshot_status"]["restorable"])
            self.assertEqual(json.loads(export_case(created["case_id"], "json").body)["snapshot"], value)
