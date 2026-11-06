from __future__ import annotations

import unittest

try:
    from . import helpers
except ImportError:  # 允许 python -m unittest discover -s tests 直接发现
    import helpers

from fastapi import HTTPException

from app.routers.system_overview import (
    clear_cache,
    system_overview,
    system_overview_members,
)

TARGET = "MC2:event:373902"


class SystemMapTest(unittest.TestCase):
    """M2-03：聚合节点不伪装成源实体，静态组织边与操作边分开。"""

    def setUp(self) -> None:
        # 主库只读、数据不变，模块级缓存可跨用例复用；只有验证命中标记时才清空
        helpers.require_db(self)

    def test_groups_cover_all_entities_once(self) -> None:
        payload = system_overview("MC2", None)
        scale = payload["scale"]
        self.assertEqual(scale["entities_total"], 15538)
        self.assertEqual(scale["files_aggregated"], 15310)
        real = [item for item in payload["groups"] if not item.get("unresolved")]
        self.assertEqual(sum(item["member_count"] for item in real), scale["entities_total"])
        files = next(item for item in payload["groups"] if item["entity_type"] == "file_path")
        self.assertTrue(files["aggregated"])

    def test_unresolved_endpoints_are_visible(self) -> None:
        payload = system_overview("MC2", None)
        unknown = [item for item in payload["groups"] if item.get("unresolved")]
        self.assertEqual(payload["scale"]["unresolved_endpoints"], 0)
        if unknown:
            self.assertEqual(unknown[0]["member_count"], 0)
            self.assertGreater(unknown[0]["event_count"], 0)

    def test_group_ids_are_not_source_entities(self) -> None:
        payload = system_overview("MC2", None)
        group_ids = {item["group_id"] for item in payload["groups"]}
        self.assertTrue(all(gid.startswith("group:") for gid in group_ids))
        for edge in payload["interaction_edges"]:
            self.assertIn(edge["source"], group_ids)
            self.assertIn(edge["target"], group_ids)
            self.assertGreater(edge["event_count"], 0)

    def test_key_interaction_edges_match_relations(self) -> None:
        payload = system_overview("MC2", None)
        by_key = {
            (edge["source"], edge["target"], edge["relation"]): edge["event_count"]
            for edge in payload["interaction_edges"]
        }
        self.assertEqual(by_key[("group:agent", "group:file_path", "file_path")], 51399)
        self.assertEqual(by_key[("group:agent", "group:system", "system_party")], 45464)

    def test_org_edges_are_static(self) -> None:
        payload = system_overview("MC2", None)
        self.assertEqual(len(payload["org_edges"]), 74)
        for edge in payload["org_edges"]:
            self.assertEqual(edge["temporal_status"], "static")
            self.assertTrue(edge["source"].startswith("MC2:"))
        relations = {edge["relation"] for edge in payload["org_edges"]}
        self.assertEqual(relations, {"contains", "led_by"})

    def test_spotlight_maps_target_chain_to_groups(self) -> None:
        payload = system_overview("MC2", TARGET)
        spotlight = payload["spotlight"]
        self.assertEqual(spotlight["root_event_id"], TARGET)
        self.assertEqual(len(spotlight["entities"]), 3)
        self.assertEqual(
            spotlight["groups"],
            ["group:agent", "group:file_path", "group:system"],
        )
        ids = {item["entity_id"] for item in spotlight["entities"]}
        self.assertIn("MC2:file_path:SwiftWren.txt", ids)
        self.assertIn("MC2:system:system:saidit", ids)

    def test_expand_returns_real_ids(self) -> None:
        payload = system_overview_members("MC2", "agent", 20)
        self.assertEqual(payload["group_id"], "group:agent")
        self.assertEqual(len(payload["members"]), 20)
        self.assertTrue(payload["truncated"])
        for member in payload["members"]:
            self.assertTrue(member["entity_id"].startswith("MC2:agent:"))

    def test_cache_marks_hits(self) -> None:
        clear_cache()
        first = system_overview("MC2", None)
        second = system_overview("MC2", None)
        self.assertFalse(first["meta"]["cache_hit"])
        self.assertTrue(second["meta"]["cache_hit"])
        self.assertEqual(first["scale"], second["scale"])

    def test_non_mc2_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            system_overview("MC1", None)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_unknown_entity_type_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            system_overview_members("MC2", "not_a_type", 10)
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
