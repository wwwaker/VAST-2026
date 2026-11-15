"""MC2 系统背景地图（M2-03）。

首版不画 15,538 个实体：按实体类型聚合成独立 `group_id`，成员数单独给出，
展开后才返回真实 `entity_id`。组织关系（`event_id IS NULL`）是静态结构，
不带时间戳，不能描述成“游标时刻重新观测到的结构”。
"""

from __future__ import annotations

TYPE_LABELS = {
    "agent": "Agent 执行者",
    "person": "人员",
    "department": "部门",
    "team": "团队",
    "system": "系统",
    "room": "场所",
    "file_path": "文件",
    "world": "外部日历",
    "company": "公司",
}

MAX_INTERACTION_EDGES = 60
MAX_ORG_EDGES = 80
MAX_MEMBERS = 50


def group_id(entity_type: str) -> str:
    return f"group:{entity_type}"


def label_of(entity_type: str | None) -> str:
    if not entity_type:
        return "未知类型"
    return TYPE_LABELS.get(entity_type, entity_type)


def _groups(conn, dataset: str) -> list[dict]:
    type_of: dict[str, str] = {}
    member_rows: dict[str, int] = {}
    for row in conn.execute(
        "SELECT entity_id, entity_type FROM entities WHERE dataset_id=?", (dataset,)
    ):
        entity_type = row["entity_type"] or "unknown"
        type_of[row["entity_id"]] = entity_type
        member_rows[entity_type] = member_rows.get(entity_type, 0) + 1

    # 按实体去重事件数，再在内存里按类型相加；走 idx_part_entity_event 的覆盖索引
    event_rows: dict[str, int] = {}
    for row in conn.execute(
        "SELECT entity_id, COUNT(DISTINCT event_id) AS events FROM participants "
        "WHERE dataset_id=? GROUP BY entity_id",
        (dataset,),
    ):
        entity_type = type_of.get(row["entity_id"])
        if entity_type is None:
            continue
        event_rows[entity_type] = event_rows.get(entity_type, 0) + int(row["events"] or 0)
    total_events = conn.execute(
        "SELECT COUNT(*) AS total FROM events WHERE dataset_id=?", (dataset,)
    ).fetchone()["total"]
    groups = []
    for entity_type, members in sorted(member_rows.items(), key=lambda item: -item[1]):
        groups.append(
            {
                "group_id": group_id(entity_type),
                "entity_type": entity_type,
                "label": label_of(entity_type),
                "member_count": members,
                # 参与次数：同一事件里有多个同类型参与者会各计一次，不等于去重事件数
                "participation_count": event_rows.get(entity_type, 0),
                "aggregated": entity_type == "file_path" and members > MAX_MEMBERS,
                "unresolved": False,
            }
        )

    # 关系端点不在实体表里的部分不能悄悄丢掉：单列一个“未解析”组，规模可见
    unresolved = conn.execute(
        "SELECT COUNT(*) AS members FROM ("
        "  SELECT DISTINCT src_id AS id FROM relations WHERE dataset_id=? AND src_id IS NOT NULL "
        "  EXCEPT SELECT entity_id FROM entities WHERE dataset_id=? "
        "  UNION "
        "  SELECT DISTINCT dst_id AS id FROM relations WHERE dataset_id=? "
        "  EXCEPT SELECT entity_id FROM entities WHERE dataset_id=?"
        ")",
        (dataset, dataset, dataset, dataset),
    ).fetchone()["members"]
    # 有些关系只有目标、没有源（如部分回执类关系），同样不能算到某个真实类型上
    unresolved_events = conn.execute(
        "SELECT COUNT(DISTINCT event_id) AS events FROM relations "
        "WHERE dataset_id=? AND src_id IS NULL",
        (dataset,),
    ).fetchone()["events"]
    if unresolved:
        # 端点未解析的规模很小（当前为 0）；只为这些 ID 补计数，避免再全扫 relations
        ids = [
            row["id"]
            for row in conn.execute(
                "SELECT id FROM (SELECT DISTINCT src_id AS id FROM relations "
                "  WHERE dataset_id=? AND src_id IS NOT NULL "
                "  EXCEPT SELECT entity_id FROM entities WHERE dataset_id=?) "
                "UNION SELECT id FROM (SELECT DISTINCT dst_id AS id FROM relations "
                "  WHERE dataset_id=? EXCEPT SELECT entity_id FROM entities WHERE dataset_id=?) "
                "LIMIT 201",
                (dataset, dataset, dataset, dataset),
            )
        ]
        placeholders = ",".join("?" * len(ids))
        unresolved_events += conn.execute(
            "SELECT COUNT(DISTINCT event_id) AS events FROM relations WHERE dataset_id=? "
            f"AND (src_id IN ({placeholders}) OR dst_id IN ({placeholders}))",
            (dataset, *ids, *ids),
        ).fetchone()["events"] or 0
    if unresolved or unresolved_events:
        groups.append(
            {
                "group_id": "group:unknown",
                "entity_type": "unknown",
                "label": "未解析端点",
                "member_count": int(unresolved),
                "participation_count": 0,
                "event_count": int(unresolved_events or 0),
                "aggregated": False,
                "unresolved": True,
            }
        )
    return groups, int(total_events)


def _interaction_edges(conn, dataset: str) -> tuple[list[dict], int]:
    rows = conn.execute(
        "SELECT src.entity_type AS src_type, dst.entity_type AS dst_type, r.relation, "
        "       COUNT(DISTINCT r.event_id) AS events, MIN(r.event_id) AS sample_event_id "
        "FROM relations r "
        "LEFT JOIN entities src ON src.dataset_id = r.dataset_id AND src.entity_id = r.src_id "
        "LEFT JOIN entities dst ON dst.dataset_id = r.dataset_id AND dst.entity_id = r.dst_id "
        "WHERE r.dataset_id=? AND r.event_id IS NOT NULL AND r.target_kind='entity' "
        "GROUP BY src.entity_type, dst.entity_type, r.relation "
        "ORDER BY events DESC",
        (dataset,),
    ).fetchall()
    edges = [
        {
            "source": group_id(row["src_type"] or "unknown"),
            "target": group_id(row["dst_type"] or "unknown"),
            "relation": row["relation"],
            "event_count": int(row["events"]),
            # MIN(event_id) 只作下钻样本，不能当作“最早事件”
            "sample_event_id": row["sample_event_id"],
        }
        for row in rows
    ]
    return edges[:MAX_INTERACTION_EDGES], len(edges)


def _org_edges(conn, dataset: str) -> list[dict]:
    rows = conn.execute(
        "SELECT r.src_id, r.dst_id, r.relation, "
        "       src.label AS src_label, src.source_value AS src_value, "
        "       dst.label AS dst_label, dst.source_value AS dst_value, "
        "       src.entity_type AS src_type, dst.entity_type AS dst_type "
        "FROM relations r "
        "LEFT JOIN entities src ON src.dataset_id = r.dataset_id AND src.entity_id = r.src_id "
        "LEFT JOIN entities dst ON dst.dataset_id = r.dataset_id AND dst.entity_id = r.dst_id "
        "WHERE r.dataset_id=? AND r.event_id IS NULL AND r.target_kind='entity' "
        "ORDER BY r.relation, r.src_id LIMIT ?",
        (dataset, MAX_ORG_EDGES),
    ).fetchall()
    return [
        {
            "source": row["src_id"],
            "target": row["dst_id"],
            "relation": row["relation"],
            "source_label": row["src_label"] or row["src_value"] or row["src_id"],
            "target_label": row["dst_label"] or row["dst_value"] or row["dst_id"],
            "source_type": row["src_type"],
            "target_type": row["dst_type"],
            "provenance_kind": "recorded",
            "temporal_status": "static",
        }
        for row in rows
    ]


def expand_group(conn, dataset: str, entity_type: str, limit: int = MAX_MEMBERS) -> dict:
    rows = conn.execute(
        "SELECT en.entity_id, en.source_value, en.label, COUNT(DISTINCT p.event_id) AS events "
        "FROM entities en JOIN participants p "
        "  ON p.dataset_id = en.dataset_id AND p.entity_id = en.entity_id "
        "WHERE en.dataset_id=? AND en.entity_type=? "
        "GROUP BY en.entity_id ORDER BY events DESC, en.entity_id LIMIT ?",
        (dataset, entity_type, limit + 1),
    ).fetchall()
    members = [
        {
            "entity_id": row["entity_id"],
            "label": row["label"] or row["source_value"] or row["entity_id"],
            "event_count": int(row["events"]),
            "group_id": group_id(entity_type),
        }
        for row in rows[:limit]
    ]
    return {
        "group_id": group_id(entity_type),
        "entity_type": entity_type,
        "members": members,
        "truncated": len(rows) > limit,
    }


def spotlight(conn, dataset: str, root_event_id: str) -> dict:
    """目标链涉及的实体 → 对应聚合组，用于在背景图上高亮。"""
    rows = conn.execute(
        "SELECT p.entity_id, p.role, en.entity_type, en.source_value, en.label "
        "FROM participants p LEFT JOIN entities en "
        "  ON en.dataset_id = p.dataset_id AND en.entity_id = p.entity_id "
        "WHERE p.dataset_id=? AND p.event_id=? ORDER BY p.role",
        (dataset, root_event_id),
    ).fetchall()
    entities = [
        {
            "entity_id": row["entity_id"],
            "role": row["role"],
            "entity_type": row["entity_type"],
            "label": row["label"] or row["source_value"] or row["entity_id"],
            "group_id": group_id(row["entity_type"] or "unknown"),
        }
        for row in rows
    ]
    return {
        "root_event_id": root_event_id,
        "entities": entities,
        "groups": sorted({item["group_id"] for item in entities}),
    }


def overview(
    conn,
    dataset: str,
    expand: str | None = None,
    limit: int = MAX_MEMBERS,
    root_event_id: str | None = None,
) -> dict:
    """整张背景图；`expand` 只为兼容旧调用保留，新接口改用 expand_group。"""
    groups, total_events = _groups(conn, dataset)
    edges, edge_total = _interaction_edges(conn, dataset)
    org = _org_edges(conn, dataset)
    files = next((item for item in groups if item["entity_type"] == "file_path"), None)
    unknown = next((item for item in groups if item.get("unresolved")), None)
    real_groups = [item for item in groups if not item.get("unresolved")]
    payload = {
        "groups": groups,
        "interaction_edges": edges,
        "org_edges": org,
        "spotlight": spotlight(conn, dataset, root_event_id) if root_event_id else None,
        "scale": {
            "events_total": total_events,
            "entities_total": sum(item["member_count"] for item in real_groups),
            "group_count": len(real_groups),
            "unresolved_endpoints": unknown["member_count"] if unknown else 0,
            "unresolved_event_count": unknown["event_count"] if unknown else 0,
            "files_aggregated": files["member_count"] if files else 0,
            "interaction_edges_total": edge_total,
            "interaction_edges_returned": len(edges),
            "org_edges_returned": len(org),
            "truncated": edge_total > len(edges),
            "reasons": ["interaction_edges"] if edge_total > len(edges) else [],
        },
        "notes": [
            "交互边按 (源类型, 目标类型, 关系) 聚合，计数为去重事件数，不能相加当成事件总数。",
            "组织边来自 org_chart，没有时间戳，属于静态背景。",
            "文件默认聚合为一个组；展开后才返回真实文件路径。",
        ],
    }
    if expand:
        payload["expanded"] = expand_group(conn, dataset, expand, limit)
    return payload
