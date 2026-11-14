"""Persistent MC2 projections, built once alongside the imported database.

The source stays authoritative. Unsupported scopes and stale/missing projections
fall back to the normal queries; no projection is built during an HTTP request.
"""
from collections import Counter, defaultdict
from contextlib import contextmanager
import argparse
import json
import os
import sqlite3
import time
import uuid

from .mc2_cache import database_identity
from ..query.filters import DAY_US, build_selection, resolve_types

VERSION = 2
FILE_ROLES = {"file_path", "queued_file_path", "post_content_source"}
TYPE_LABELS = {"agent": "智能体", "person": "人员", "file_path": "文件", "system": "系统",
               "room": "场所", "team": "团队", "department": "部门", "company": "公司",
               "world": "环境", "unknown": "缺失角色"}


def projection_path(source):
    return source + ".mc2.sqlite"


def identity(conn):
    return json.dumps((VERSION, database_identity(conn)), ensure_ascii=False)


def empty_bucket():
    return {"total": 0, "mapped": 0, "missing": Counter(), "roles": Counter(), "role_sets": Counter(),
            "edges": {}, "members": defaultdict(set),
            "facets": {kind: Counter() for kind in ("file", "actor", "system")},
            "absent": Counter()}


def serialize(bucket, section):
    if section == "overview":
        return {"total": bucket["total"], "mapped": bucket["mapped"],
                "missing": list(bucket["missing"].items()), "roles": dict(bucket["roles"]),
                "role_sets": list(bucket["role_sets"].items()),
                "edges": [[*key, *value] for key, value in bucket["edges"].items()],
                "members": {k: sorted(v) for k, v in bucket["members"].items()}}
    return {"total": bucket["total"], "absent": dict(bucket["absent"]),
            "items": {k: dict(v) for k, v in bucket["facets"].items()}}


def build(source):
    """Write a replaceable sidecar, without changing the main database."""
    source = os.path.abspath(source)
    target = projection_path(source)
    temporary = target + "." + uuid.uuid4().hex + ".tmp"
    started = time.perf_counter()
    origin = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    origin.row_factory = sqlite3.Row
    dest = None
    try:
        stamp = identity(origin)
        origin.execute("BEGIN")
        objects = {r["entity_id"]: dict(r) for r in origin.execute(
            "SELECT entity_id,entity_type,COALESCE(source_value,label,entity_id) label "
            "FROM entities WHERE dataset_id='MC2'")}
        buckets = defaultdict(empty_bucket)
        dest = sqlite3.connect(temporary)
        dest.executescript("""
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE buckets(day INTEGER, action TEXT, overview TEXT, facets TEXT,
                                 PRIMARY KEY(day,action));
            CREATE TABLE objects(id TEXT PRIMARY KEY,label TEXT,kind TEXT);
            CREATE TABLE facts(event_id TEXT,event_type TEXT,time_sort_us INTEGER,
                relation TEXT,src_id TEXT,dst_id TEXT,target_kind TEXT,source_kind TEXT,dest_kind TEXT);
        """)
        rows = origin.execute(
            "SELECT e.event_id,e.event_type,e.time_sort_us,e.actor_id,r.relation,r.src_id,r.dst_id,r.target_kind "
            "FROM events e LEFT JOIN relations r ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
            "WHERE e.dataset_id='MC2' ORDER BY e.event_id")
        current = None
        event_rows = []
        fact_buffer = []

        def consume(records):
            event, action, timestamp, actor = records[0][:4]
            bucket = buckets[timestamp // DAY_US * DAY_US, action]
            bucket["total"] += 1
            roles, missing, edges = set(), set(), set()
            facets = {"file": set(), "actor": {actor} if actor else set(), "system": set()}
            for _, _, _, _, role, src, dst, target_kind in records:
                if role is None:
                    continue
                source_kind = objects.get(src, {}).get("entity_type") or "unknown"
                dest_kind = objects.get(dst, {}).get("entity_type") or "unknown"
                fact_buffer.append((event, action, timestamp, role, src, dst, target_kind, source_kind, dest_kind))
                if src is None:
                    missing.add(role)
                if target_kind != "entity":
                    continue
                roles.add(role)
                edges.add((source_kind, dest_kind, role, action))
                for entity in (src, dst):
                    if entity in objects:
                        bucket["members"][objects[entity]["entity_type"]].add(entity)
                if role in FILE_ROLES:
                    facets["file"].add(dst)
                if dest_kind == "system":
                    facets["system"].add(dst)
            bucket["mapped"] += bool(roles)
            bucket["roles"].update(roles)
            bucket["role_sets"][json.dumps(sorted(roles))] += 1
            bucket["missing"][json.dumps(sorted(missing))] += bool(missing)
            for edge in edges:
                value = bucket["edges"].setdefault(edge, [0, timestamp, timestamp])
                value[0] += 1
                value[1] = min(value[1], timestamp)
                value[2] = max(value[2], timestamp)
            for kind, ids in facets.items():
                bucket["facets"][kind].update(ids)
                bucket["absent"][kind] += not ids
            if len(fact_buffer) >= 5000:
                dest.executemany("INSERT INTO facts VALUES(?,?,?,?,?,?,?,?,?)", fact_buffer)
                fact_buffer.clear()

        for row in rows:
            if current is not None and current != row[0]:
                consume(event_rows)
                event_rows = []
            current = row[0]
            event_rows.append(tuple(row))
        if event_rows:
            consume(event_rows)
        dest.executemany("INSERT INTO facts VALUES(?,?,?,?,?,?,?,?,?)", fact_buffer)
        dest.executemany("INSERT INTO objects VALUES(?,?,?)",
                         [(key, value["label"], value["entity_type"]) for key, value in objects.items()])
        dest.executemany("INSERT INTO buckets VALUES(?,?,?,?)", [
            (day, action, json.dumps(serialize(bucket, "overview"), ensure_ascii=False),
             json.dumps(serialize(bucket, "facets"), ensure_ascii=False))
            for (day, action), bucket in buckets.items()])
        bounds = origin.execute("SELECT MIN(time_sort_us),MAX(time_sort_us) FROM events WHERE dataset_id='MC2'").fetchone()
        dest.executemany("INSERT INTO metadata VALUES(?,?)", [("identity", stamp), ("bounds", json.dumps(list(bounds)))])
        dest.executescript("""
            CREATE TABLE endpoint_days AS
                SELECT (time_sort_us/86400000000)*86400000000 day,
                    event_type action,relation,COALESCE(src_id,'__missing__') source,dst_id target,
                    COUNT(DISTINCT event_id) count,MIN(time_sort_us) first_us,MAX(time_sort_us) last_us
                FROM facts WHERE target_kind='entity'
                GROUP BY day,action,relation,source,target;
            CREATE INDEX endpoint_role_day ON endpoint_days(relation,day,action);
            CREATE INDEX facts_event ON facts(event_id);
            CREATE INDEX facts_source ON facts(src_id,time_sort_us);
            CREATE INDEX facts_target ON facts(dst_id,time_sort_us);
            CREATE INDEX facts_role ON facts(relation,time_sort_us);
            CREATE INDEX facts_time ON facts(time_sort_us,event_type);
            ANALYZE;
        """)
        dest.commit()
        if dest.execute("PRAGMA quick_check").fetchone()[0] != "ok" or identity(origin) != stamp:
            raise RuntimeError("MC2 projection validation failed or source changed during build")
        dest.close()
        dest = None
        origin.rollback()
        os.replace(temporary, target)
        return {"path": target, "buckets": len(buckets), "seconds": round(time.perf_counter() - started, 3)}
    finally:
        origin.close()
        if dest:
            dest.close()
        if os.path.exists(temporary):
            os.remove(temporary)


@contextmanager
def connection(conn):
    path = projection_path(conn.execute("PRAGMA database_list").fetchone()[2])
    projection = None
    valid = False
    try:
        if os.path.isfile(path):
            projection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            projection.row_factory = sqlite3.Row
            row = projection.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
            valid = bool(row and row[0] == identity(conn))
    except (sqlite3.Error, OSError, KeyError):
        pass
    try:
        yield projection if valid else None
    finally:
        if projection:
            projection.close()


def read_buckets(conn, selection, section):
    ctx = selection.context
    if (ctx.actor_id or ctx.participant_id or ctx.run_id or ctx.channels or ctx.keyword
            or selection.filter_hash != build_selection(ctx).filter_hash):
        return None
    with connection(conn) as projection:
        if projection is None:
            return None
        low, high = json.loads(projection.execute("SELECT value FROM metadata WHERE key='bounds'").fetchone()[0])
        start, end = selection.start_us, selection.end_us
        if low is not None and ((start is not None and start > low and start % DAY_US)
                                or (end is not None and end <= high and end % DAY_US)):
            return None
        clauses, params = [], []
        if start is not None:
            clauses.append("day>=?")
            params.append(start // DAY_US * DAY_US)
        if end is not None:
            clauses.append("day<?")
            params.append((end + DAY_US - 1) // DAY_US * DAY_US)
        types = resolve_types(ctx)
        if selection.zero or types == set():
            return [], {}
        if types is not None:
            clauses.append("action IN (" + ",".join("?" for _ in types) + ")")
            params.extend(sorted(types))
        where = " AND ".join(clauses) or "1"
        rows = [json.loads(row[0]) for row in projection.execute(f"SELECT {section} FROM buckets WHERE {where}", params)]
        objects = {r["id"]: (r["label"], r["kind"]) for r in projection.execute("SELECT * FROM objects")} if section == "facets" else {}
        return rows, objects


def details(conn, selection, file_id, mode, relation, labels):
    """Aggregate prepared endpoint days; event signatures keep role unions exact."""
    result = read_buckets(conn, selection, "overview")
    if result is None:
        return None
    rows, _ = result
    counts = Counter()
    for row in rows:
        counts.update(row["roles"])
    valid = sorted(counts, key=lambda role: (-counts[role], role))
    if mode == "relay":
        allowed = [r for r in valid if r in ("queue_target_agent", "queue_target_person")]
    elif mode == "operations":
        allowed = [r for r in valid if r in ("file_path", "post_content_source")]
    else:
        allowed = [relation] if relation in valid else valid[:1]
    needs_file = mode == "system" and not file_id and any(r in FILE_ROLES for r in allowed)
    allowed_set = set(allowed)
    mapped = sum(n for row in rows for signature, n in row["role_sets"] if set(json.loads(signature)) & allowed_set)
    missing = sum(n for row in rows for signature, n in row["missing"] if set(json.loads(signature)) & allowed_set)
    edges = []
    if allowed and not needs_file and not selection.zero:
        clauses = ["relation IN (" + ",".join("?" for _ in allowed) + ")"]
        params = list(allowed)
        if selection.start_us is not None:
            clauses.append("day>=?")
            params.append(selection.start_us // DAY_US * DAY_US)
        if selection.end_us is not None:
            clauses.append("day<?")
            params.append((selection.end_us + DAY_US - 1) // DAY_US * DAY_US)
        types = resolve_types(selection.context)
        if types is not None:
            if not types:
                clauses.append("0")
            else:
                clauses.append("action IN (" + ",".join("?" for _ in types) + ")")
                params.extend(sorted(types))
        if mode == "operations":
            clauses.append("target=?")
            params.append(file_id)
            # No file means no operations, including the mapped/missing counts.
            if file_id is None:
                mapped = missing = 0
        with connection(conn) as projection:
            if projection is None:
                return None
            edges = [dict(r) for r in projection.execute(
                "SELECT source,target,relation,action,SUM(count) count,MIN(first_us) first_us,MAX(last_us) last_us "
                "FROM endpoint_days WHERE " + " AND ".join(clauses) +
                " GROUP BY source,target,relation,action ORDER BY count DESC,source,target,relation,action", params)]
    ids = sorted({e[k] for e in edges for k in ("source", "target")})
    entities = {}
    if ids:
        entities = {r["entity_id"]: r for r in conn.execute(
            "SELECT entity_id,label,source_value,entity_type FROM entities WHERE dataset_id='MC2' AND entity_id IN (" +
            ",".join("?" for _ in ids) + ")", ids)}
    nodes = []
    for entity in ids:
        row = entities.get(entity)
        nodes.append({"id": entity, "label": (row["source_value"] if row["entity_type"] == "file_path" else row["label"]) or entity,
                      "entity_type": row["entity_type"]} if row else {"id": entity, "label": "缺少发起者", "entity_type": "missing"})
    total = sum(r["total"] for r in rows)
    return {"meta": {"matched_events": total, "selection_hash": selection.filter_hash,
                     "applied_filters": selection.context.applied(), "data_version": conn.execute("SELECT data_version FROM datasets WHERE dataset_id='MC2'").fetchone()[0]},
            "nodes": nodes, "edges": edges, "mapped_events": mapped, "unmapped_events": total - mapped,
            "missing_source_events": missing, "relation_counts": [{"relation": r, "count": counts[r], "label": labels.get(r, r)} for r in valid],
            "selected_relations": allowed, "mode": mode, "needs_file": needs_file}


def relation_rows(conn, selection):
    """Use indexed, prepared facts for scopes that cannot use whole-day buckets."""
    with connection(conn) as projection:
        if projection is None:
            return None
    if not any(row[1] == "mc2_prepared" for row in conn.execute("PRAGMA database_list")):
        path = projection_path(conn.execute("PRAGMA database_list").fetchone()[2])
        conn.execute("ATTACH DATABASE ? AS mc2_prepared", (path,))
    return conn.execute(
        "SELECT event_id,event_type,time_sort_us,relation,src_id,dst_id,target_kind "
        "FROM mc2_prepared.facts WHERE event_id IN "
        f"(SELECT e.event_id FROM events e WHERE {selection.where_sql})", selection.params)


def overview(conn, selection, labels):
    result = read_buckets(conn, selection, "overview")
    if result is None:
        return None
    rows, _ = result
    roles, members, edges = Counter(), defaultdict(set), {}
    for row in rows:
        roles.update(row["roles"])
        for kind, ids in row["members"].items():
            members[kind].update(ids)
        for source, target, role, action, count, first, last in row["edges"]:
            value = edges.setdefault((source, target, role, action), [0, first, last])
            value[0] += count
            value[1] = min(value[1], first)
            value[2] = max(value[2], last)
    allowed = sorted(roles, key=lambda role: (-roles[role], role))
    missing = sum(count for row in rows for signature, count in row["missing"] if set(json.loads(signature)) & roles.keys())
    total, mapped = sum(r["total"] for r in rows), sum(r["mapped"] for r in rows)
    edge_list = [dict(source=s, target=t, relation=r, action=a, count=v[0], first_us=v[1], last_us=v[2])
                 for (s, t, r, a), v in edges.items()]
    edge_list.sort(key=lambda e: (-e["count"], e["source"], e["target"], e["relation"], e["action"]))
    kinds = sorted({e[k] for e in edge_list for k in ("source", "target")})
    return {"meta": {"matched_events": total, "selection_hash": selection.filter_hash,
                     "applied_filters": selection.context.applied(), "data_version": conn.execute("SELECT data_version FROM datasets WHERE dataset_id='MC2'").fetchone()[0]},
            "nodes": [{"id": k, "label": f"{TYPE_LABELS.get(k, k)} · {len(members[k])} 个活跃实体", "entity_type": k} for k in kinds],
            "edges": edge_list, "mapped_events": mapped, "unmapped_events": total - mapped,
            "missing_source_events": missing, "relation_counts": [{"relation": r, "count": roles[r], "label": labels.get(r, r)} for r in allowed],
            "selected_relations": allowed, "mode": "types", "needs_file": False}


def facets(conn, selection, kind):
    result = read_buckets(conn, selection, "facets")
    if result is None:
        return None
    rows, objects = result
    counts = Counter()
    for row in rows:
        counts.update(row["items"][kind])
    items = [{"id": key, "label": objects.get(key, (key, None))[0],
              "entity_type": objects.get(key, (None, None))[1], "count": count} for key, count in counts.items()]
    # Actor labels use entities.label, unlike file/system source_value labels.
    if kind == "actor":
        names = {r[0]: r[1] for r in conn.execute("SELECT entity_id,label FROM entities WHERE dataset_id='MC2'")}
        for item in items:
            item["label"] = names.get(item["id"])
    items.sort(key=lambda item: (-item["count"], item["id"]))
    return {"meta": {"matched_events": sum(r["total"] for r in rows), "selection_hash": selection.filter_hash,
                     "applied_filters": selection.context.applied(), "data_version": conn.execute("SELECT data_version FROM datasets WHERE dataset_id='MC2'").fetchone()[0]},
            "items": items, "total": len(items), "missing": sum(r["absent"].get(kind, 0) for r in rows), "kind": kind}


if __name__ == "__main__":
    from ..config import DB_PATH
    parser = argparse.ArgumentParser(description="Build persistent MC2 relationship projections")
    parser.add_argument("--db", default=DB_PATH)
    print(json.dumps(build(parser.parse_args().db), ensure_ascii=False))
