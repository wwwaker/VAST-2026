"""Type overview from one pass over recorded roles, with event-level deduplication."""
from collections import defaultdict
from . import mc2_cache, mc2_projection


def type_overview(conn, selection, payload_meta, relation_labels):
    kinds = mc2_cache.cached(conn, ("entity-kinds",), lambda: {
        r["entity_id"]: r["entity_type"] for r in conn.execute(
            "SELECT entity_id,entity_type FROM entities WHERE dataset_id='MC2'")})
    by_role = defaultdict(set)
    missing_by_role = defaultdict(set)
    members = defaultdict(set)
    groups = {}
    rows = mc2_projection.relation_rows(conn, selection)
    if rows is None:
        rows = conn.execute(
            "SELECT e.event_id,e.event_type,e.time_sort_us,r.relation,r.src_id,r.dst_id,r.target_kind "
            "FROM events e JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
            f"WHERE {selection.where_sql}", selection.params)
    for row in rows:
        event, action, timestamp, role, source, target, target_kind = row
        # Preserve the existing missing-source contract, which also counts roles
        # with non-entity targets when this relation family is selected.
        if source is None:
            missing_by_role[role].add(event)
        if target_kind != "entity":
            continue
        by_role[role].add(event)
        source_kind, target_kind = kinds.get(source) or "unknown", kinds.get(target) or "unknown"
        if source in kinds:
            members[kinds[source]].add(source)
        if target in kinds:
            members[kinds[target]].add(target)
        key = (source_kind, target_kind, role, action)
        if key not in groups:
            groups[key] = [set(), timestamp, timestamp]
        group = groups[key]
        group[0].add(event)
        group[1] = min(group[1], timestamp)
        group[2] = max(group[2], timestamp)
    # Equal-count families get a deterministic order; SQL did not specify ties.
    allowed = sorted(by_role, key=lambda role: (-len(by_role[role]), role))
    mapped = len(set().union(*by_role.values()))
    missing = len(set().union(*(missing_by_role[role] for role in allowed)))
    edges = [{"source": source, "target": target, "relation": role, "action": action,
              "count": len(events), "first_us": first, "last_us": last}
             for (source, target, role, action), (events, first, last) in groups.items()]
    edges.sort(key=lambda edge: (-edge["count"], edge["source"], edge["target"], edge["relation"], edge["action"]))
    ids = {edge[key] for edge in edges for key in ("source", "target")}
    labels = {"agent": "智能体", "person": "人员", "file_path": "文件", "system": "系统", "room": "场所",
              "team": "团队", "department": "部门", "company": "公司", "world": "环境", "unknown": "缺失角色"}
    return {"meta": payload_meta,
            "nodes": [{"id": kind, "label": f"{labels.get(kind, kind)} · {len(members[kind])} 个活跃实体",
                       "entity_type": kind} for kind in sorted(ids)],
            "edges": edges, "mapped_events": mapped,
            "unmapped_events": payload_meta["matched_events"] - mapped,
            "missing_source_events": missing,
            "relation_counts": [{"relation": role, "count": len(by_role[role]),
                                 "label": relation_labels.get(role, role)} for role in allowed],
            "selected_relations": allowed, "mode": "types", "needs_file": False}
