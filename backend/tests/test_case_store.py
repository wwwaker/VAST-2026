from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest.mock import patch

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from fastapi import HTTPException

from app import case_store, notes_store
from app.db import get_conn
from app.domain import export as export_domain
from app.routers.cases import CaseCreate, create_case, delete_case, export_case, get_case, list_cases
from app.routers.findings import FindingCreate, create_finding, delete_finding, list_findings

CASE_PAYLOAD = CaseCreate(
    dataset_id="MC2",
    title="目标帖来源链",
    snapshot={
        "filters": {"keyword": "windward", "categories": [2]},
        "canvas_view": "trace",
        "selected_event_id": "MC2:event:373902",
        "focused_entity_id": "MC2:agent:Agent/person:john_windward",
        "trace_root_id": "MC2:event:373902",
        "pinned_evidence": [{"event_id": "MC2:event:373902", "role": "support"}],
    },
)


def new_case(**kwargs):
    return create_case(CaseCreate(**kwargs))


def new_finding(**kwargs):
    return create_finding(FindingCreate(**kwargs))


class CaseStoreTest(unittest.TestCase):
    """E-01：保存 → 重新读取 → 导出；证据缺失或哈希变化要显式报告。"""

    def setUp(self) -> None:
        helpers.require_db(self)
        handle, self.path = tempfile.mkstemp(suffix=".notes.db")
        os.close(handle)
        self.patcher = patch.object(notes_store, "NOTES_DB", self.path)
        self.patcher.start()
        notes_store.ensure_schema()
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        self.patcher.stop()
        if os.path.exists(self.path):
            os.remove(self.path)

    def _version(self, dataset: str = "MC2") -> str:
        with get_conn() as conn:
            return conn.execute(
                "SELECT data_version FROM datasets WHERE dataset_id=?", (dataset,)
            ).fetchone()["data_version"]

    def test_snapshot_roundtrip(self) -> None:
        created = new_case(dataset_id="MC2", title="目标帖来源链", snapshot=CASE_PAYLOAD.snapshot)
        self.assertTrue(created["case_id"].startswith("case-"))
        self.assertEqual(created["data_version"], self._version())

        fetched = get_case(created["case_id"])
        self.assertEqual(fetched["title"], "目标帖来源链")
        self.assertEqual(fetched["snapshot"]["canvas_view"], "trace")
        self.assertEqual(fetched["snapshot"]["trace_root_id"], "MC2:event:373902")
        self.assertEqual(fetched["status"], "ok")

    def test_list_merges_user_cases(self) -> None:
        new_case(dataset_id="MC2", title="A", snapshot={})
        payload = list_cases("MC2")
        self.assertEqual(len(payload["user_items"]), 1)
        self.assertEqual(payload["user_items"][0]["kind"], "user")
        self.assertEqual(payload["items"], [])  # MC2 没有预置案例

    def test_finding_with_support_and_counter(self) -> None:
        case = new_case(dataset_id="MC2", title="目标帖", snapshot={})
        finding = new_finding(
            case_id=case["case_id"],
            claim="目标帖的内容来自 SwiftWren.txt",
            status="supported",
            explanation="post_content_source 直接指向该文件",
            limitations="没有正文，无法确认含义",
            evidence=[
                {"reference_id": "MC2:event:373902", "role": "support", "excerpt": "content_source"},
                {"reference_id": "MC2:event:21202", "role": "counter", "excerpt": "创建者不是发布者"},
            ],
        )
        self.assertEqual(len(finding["evidence"]), 2)
        self.assertEqual({item["role"] for item in finding["evidence"]}, {"support", "counter"})
        for item in finding["evidence"]:
            self.assertEqual(len(item["source_hash"]), 40)

        listed = list_findings(case["case_id"])
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["status_counts"]["supported"], 1)

    def test_missing_evidence_is_rejected(self) -> None:
        case = new_case(dataset_id="MC2", title="x", snapshot={})
        with self.assertRaises(HTTPException) as ctx:
            new_finding(
                case_id=case["case_id"],
                claim="c",
                status="hypothesis",
                explanation="e",
                evidence=[{"reference_id": "MC2:event:not-exist", "role": "support"}],
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("not-exist", ctx.exception.detail)
        self.assertEqual(list_findings(case["case_id"])["total"], 0)

    def test_export_json_and_markdown(self) -> None:
        case = new_case(dataset_id="MC2", title="目标帖", snapshot=CASE_PAYLOAD.snapshot)
        new_finding(
            case_id=case["case_id"],
            claim="目标帖 <script>来自</script> SwiftWren.txt",
            status="supported",
            explanation="来源字段直指文件",
            evidence=[{"reference_id": "MC2:event:373902", "role": "support"}],
        )
        payload = export_case(case["case_id"], "json")
        body = json.loads(payload.body)
        self.assertEqual(body["kind"], "user")
        self.assertFalse(body["stale"])
        self.assertEqual(body["summary"]["claim_count"], 1)
        self.assertEqual(body["findings"][0]["evidence"][0]["resolved"]["event_type"], "saidit_post")
        self.assertFalse(body["findings"][0]["evidence"][0]["changed"])

        markdown = export_case(case["case_id"], "md")
        text = markdown.body.decode("utf-8") if isinstance(markdown.body, bytes) else markdown.body
        self.assertIn("目标帖", text)
        self.assertIn("有证据支持", text)
        self.assertIn("MC2:event:373902", text)
        # 日志正文里的标签必须转义，不能原样出现在导出文件里
        self.assertNotIn("<script>", text)
        self.assertIn("&lt;script&gt;", text)

    def test_export_marks_stale_version(self) -> None:
        case = new_case(dataset_id="MC2", title="x", snapshot={})
        with get_conn() as conn:
            payload = export_domain.build(conn, case["case_id"], "sha256-of-another-build")
        self.assertTrue(payload["stale"])

    def test_preset_case_accepts_findings_and_exports(self) -> None:
        finding = new_finding(
            case_id="custom-normal",
            claim="正常运行有有效审核",
            status="supported",
            explanation="REVIEW-01 重算为 valid",
            evidence=[{"reference_id": "4e0e4449-e7e2-4e8b-a415-d0faa908c2b6", "role": "support"}],
        )
        self.addCleanup(case_store.delete_finding, finding["finding_id"])
        payload = export_case("custom-normal", "json")
        body = json.loads(payload.body)
        self.assertEqual(body["kind"], "preset")
        self.assertEqual(body["preset"]["status"], "ok")
        self.assertEqual(body["summary"]["claim_count"], 1)

    def test_delete_case_removes_findings(self) -> None:
        case = new_case(dataset_id="MC2", title="x", snapshot={})
        finding = new_finding(
            case_id=case["case_id"],
            claim="c",
            status="hypothesis",
            explanation="e",
            evidence=[],
        )
        delete_case(case["case_id"])
        self.assertIsNone(case_store.get_finding(finding["finding_id"]))
        self.assertIsNone(case_store.get_case(case["case_id"]))

    def test_preset_case_cannot_be_deleted(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            delete_case("custom-normal")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_delete_finding(self) -> None:
        case = new_case(dataset_id="MC2", title="x", snapshot={})
        finding = new_finding(
            case_id=case["case_id"],
            claim="c",
            status="hypothesis",
            explanation="e",
            evidence=[],
        )
        delete_finding(finding["finding_id"])
        self.assertEqual(list_findings(case["case_id"])["total"], 0)


if __name__ == "__main__":
    unittest.main()
