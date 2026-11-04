"""SQLite 导入与查询基准（阶段 0 交付物）。

只做基准验证，不是最终导入管线：用于确定分页大小、聚合粒度与索引是否够用。
用法：
    python tools/bench_sqlite.py --dataset MC2
结果同时写入 build/bench_result.json。
"""

import argparse
import json
import os
import sqlite3
import statistics
import sys
import time
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DATASETS = {
    "MC1": {
        "events": os.path.join(ROOT, "data", "processed", "official_data", "MC1", "events.jsonl"),
        "entities": os.path.join(ROOT, "data", "processed", "official_data", "MC1", "entities.json"),
        "entity_container": "entities",
        "timezone_status": "unknown",
    },
    "MC2": {
        "events": os.path.join(ROOT, "data", "processed", "official_data", "MC2", "events.jsonl"),
        "entities": os.path.join(ROOT, "data", "processed", "official_data", "MC2", "entities.json"),
        "entity_container": "entities",
        "timezone_status": "utc",
    },
    "CUSTOM": {
        "events": os.path.join(ROOT, "data", "processed", "custom_dataset", "events.jsonl"),
        "entities": os.path.join(ROOT, "data", "processed", "custom_dataset", "entities.json"),
        "entity_container": None,  # 根即数组
        "timezone_status": "utc",
    },
}

TEXT_KEYS = ("content", "subject", "title", "reason", "feedback", "purpose", "assignment", "task")

TABLES_SQL = """
CREATE TABLE datasets (
    dataset_id       TEXT PRIMARY KEY,
    timezone_status  TEXT NOT NULL,
    event_count      INTEGER NOT NULL,
    entity_count     INTEGER NOT NULL,
    ts_min           TEXT,
    ts_max           TEXT,
    import_version   TEXT
);

CREATE TABLE events (
    dataset_id           TEXT NOT NULL,
    event_id             TEXT NOT NULL,
    source_record_id     TEXT,
    timestamp_raw        TEXT NOT NULL,
    timestamp_normalized TEXT NOT NULL,
    time_sort_key        INTEGER NOT NULL,
    timezone_status      TEXT NOT NULL,
    actor_id             TEXT,
    event_type           TEXT NOT NULL,
    task_id              TEXT,
    document_id          TEXT,
    parent_event_id      TEXT,
    details_json         TEXT,
    source_json_pointer  TEXT,
    PRIMARY KEY (dataset_id, event_id)
);

CREATE TABLE event_raw (
    dataset_id TEXT NOT NULL,
    event_id   TEXT NOT NULL,
    raw_json   TEXT,
    PRIMARY KEY (dataset_id, event_id)
);

CREATE TABLE entities (
    dataset_id   TEXT NOT NULL,
    entity_id    TEXT NOT NULL,
    entity_type  TEXT,
    source_value TEXT,
    label        TEXT,
    roles_json   TEXT,
    attrs_json   TEXT,
    PRIMARY KEY (dataset_id, entity_id)
);

CREATE TABLE participants (
    dataset_id    TEXT NOT NULL,
    event_id      TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    role          TEXT NOT NULL,
    derivation    TEXT NOT NULL,
    time_sort_key INTEGER NOT NULL   -- 去规格化：实体时间线无需回表排序
);

CREATE TABLE time_buckets (
    dataset_id  TEXT NOT NULL,
    granularity TEXT NOT NULL,
    bucket_key  INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    PRIMARY KEY (dataset_id, granularity, bucket_key, event_type)
);

CREATE TABLE relations (
    dataset_id TEXT NOT NULL,
    event_id   TEXT,
    src_id     TEXT,          -- 允许为空：MC2 有 322 条事件的 actor_id 本身缺失，不臆造来源
    dst_id     TEXT NOT NULL,
    relation   TEXT NOT NULL,
    derivation TEXT NOT NULL
);

CREATE TABLE event_fts (
    event_id UNINDEXED,
    body     TEXT
);
"""

POST_SQL = """
CREATE INDEX idx_events_time  ON events(dataset_id, time_sort_key, event_id);
CREATE INDEX idx_events_actor ON events(dataset_id, actor_id, time_sort_key);
CREATE INDEX idx_events_type  ON events(dataset_id, event_type, time_sort_key);
CREATE INDEX idx_part_entity  ON participants(dataset_id, entity_id, time_sort_key);
CREATE INDEX idx_part_event   ON participants(dataset_id, event_id);
CREATE INDEX idx_bucket       ON time_buckets(dataset_id, granularity, bucket_key);
CREATE INDEX idx_rel_src      ON relations(dataset_id, src_id);
CREATE INDEX idx_rel_dst      ON relations(dataset_id, dst_id);
CREATE VIRTUAL TABLE event_fts_idx USING fts5(
    body, content='event_fts', content_rowid='rowid', tokenize='unicode61'
);
INSERT INTO event_fts_idx(event_fts_idx) VALUES('rebuild');
ANALYZE;
"""


def parse_epoch(ts):
    """UTC ISO 字符串转 epoch 秒；无时区标记时按 UTC 解释。"""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        dt = datetime.fromisoformat(ts.replace("Z", ""))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def extract_text(details):
    if not isinstance(details, dict):
        return ""
    parts = []
    for k in TEXT_KEYS:
        v = details.get(k)
        if isinstance(v, str) and v:
            parts.append(v)
        elif isinstance(v, dict):
            for kk in ("content", "subject", "title"):
                vv = v.get(kk)
                if isinstance(vv, str) and vv:
                    parts.append(vv)
    return "\n".join(parts)


def load_entities(conn, cfg, dataset_id):
    started = time.perf_counter()
    with open(cfg["entities"], "r", encoding="utf-8") as f:
        payload = json.load(f)
    if cfg["entity_container"] is None:
        ents, edges = payload, []
    else:
        ents = payload.get(cfg["entity_container"]) or []
        edges = payload.get("org_edges") or []

    rows = []
    for e in ents:
        eid = e.get("entity_id")
        if not eid:
            continue
        roles = e.get("roles")
        attrs = {
            k: v
            for k, v in e.items()
            if k not in ("entity_id", "entity_type", "source_value", "label", "labels", "roles")
        }
        label = e.get("label")
        if not label and isinstance(e.get("labels"), list) and e["labels"]:
            label = e["labels"][0]
        rows.append(
            (
                dataset_id,
                eid,
                e.get("entity_type"),
                e.get("source_value"),
                label,
                json.dumps(roles, ensure_ascii=False) if roles else None,
                json.dumps(attrs, ensure_ascii=False) if attrs else None,
            )
        )
    conn.executemany("INSERT INTO entities VALUES (?,?,?,?,?,?,?)", rows)

    rel_rows = []
    for edge in edges:
        src, dst, rel = edge.get("source"), edge.get("target"), edge.get("relation")
        if src and dst:
            rel_rows.append((dataset_id, None, src, dst, rel or "org_edge", "source:org_edges"))
    if rel_rows:
        conn.executemany("INSERT INTO relations VALUES (?,?,?,?,?,?)", rel_rows)

    elapsed = time.perf_counter() - started
    print(f"  entities: {len(rows):,} rows, org_edges {len(rel_rows):,}, {elapsed:.2f}s")
    return len(rows), elapsed


def load_events(conn, cfg, dataset_id):
    started = time.perf_counter()
    tz_status = cfg["timezone_status"]

    ev_sql = "INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    raw_sql = "INSERT INTO event_raw VALUES (?,?,?)"
    part_sql = "INSERT INTO participants VALUES (?,?,?,?,?,?)"
    rel_sql = "INSERT INTO relations VALUES (?,?,?,?,?,?)"
    fts_sql = "INSERT INTO event_fts (event_id, body) VALUES (?,?)"

    buffers = {"ev": [], "raw": [], "part": [], "rel": [], "fts": []}
    counts = {"events": 0, "participants": 0, "relations": 0, "fts": 0}
    ts_min = ts_max = None

    def flush():
        if buffers["ev"]:
            conn.executemany(ev_sql, buffers["ev"])
        if buffers["raw"]:
            conn.executemany(raw_sql, buffers["raw"])
        if buffers["part"]:
            conn.executemany(part_sql, buffers["part"])
        if buffers["rel"]:
            conn.executemany(rel_sql, buffers["rel"])
        if buffers["fts"]:
            conn.executemany(fts_sql, buffers["fts"])
        for v in buffers.values():
            v.clear()

    with open(cfg["events"], "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            eid = o["event_id"]
            ts = o["timestamp"]
            ts_min = ts if ts_min is None or ts < ts_min else ts_min
            ts_max = ts if ts_max is None or ts > ts_max else ts_max
            details = o.get("details")
            tsk = parse_epoch(ts)

            buffers["ev"].append(
                (
                    dataset_id,
                    eid,
                    str(o["source_record_id"]) if o.get("source_record_id") is not None else None,
                    ts,
                    ts.replace("Z", "+00:00") if tz_status == "utc" else ts,
                    tsk,
                    tz_status,
                    o.get("actor_id"),
                    o.get("event_type") or "unknown",
                    o.get("task_id"),
                    o.get("document_id") or o.get("file_id"),
                    o.get("parent_event_id"),
                    json.dumps(details, ensure_ascii=False) if details else None,
                    o.get("source_json_pointer"),
                )
            )

            raw = o.get("raw")
            if raw is not None:
                buffers["raw"].append((dataset_id, eid, json.dumps(raw, ensure_ascii=False)))

            actor = o.get("actor_id")
            seen = set()
            if actor:
                buffers["part"].append((dataset_id, eid, actor, "actor", "source:actor_id", tsk))
                seen.add(actor)
            for pid in o.get("party_ids") or []:
                if pid and pid not in seen:
                    buffers["part"].append((dataset_id, eid, pid, "party", "source:party_ids", tsk))
                    seen.add(pid)
            for rel in o.get("relationships") or []:
                dst = rel.get("entity_id")
                if not dst:
                    continue
                derivation = "source:relationships" if actor else "source:relationships:actor_null"
                buffers["rel"].append(
                    (dataset_id, eid, actor, dst, rel.get("relation") or "unknown", derivation)
                )
                if dst not in seen:
                    buffers["part"].append(
                        (dataset_id, eid, dst, rel.get("relation") or "related", "source:relationships", tsk)
                    )
                    seen.add(dst)

            body = extract_text(details)
            if body:
                buffers["fts"].append((eid, body))

            counts["events"] += 1
            counts["participants"] += len(seen)
            counts["relations"] += len(o.get("relationships") or [])
            if body:
                counts["fts"] += 1

            if counts["events"] % 5000 == 0:
                flush()

    flush()
    elapsed = time.perf_counter() - started
    print(
        f"  events: {counts['events']:,} rows, participants ~{counts['participants']:,}, "
        f"relations {counts['relations']:,}, fts {counts['fts']:,}, {elapsed:.2f}s"
    )
    return counts, elapsed, ts_min, ts_max


def run_query(conn, sql, params=(), repeat=5):
    times = []
    rows = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        rows = conn.execute(sql, params).fetchall()
        times.append((time.perf_counter() - t0) * 1000)
    return {
        "median_ms": round(statistics.median(times), 2),
        "min_ms": round(min(times), 2),
        "max_ms": round(max(times), 2),
        "rows": len(rows),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="MC2", choices=list(DATASETS))
    ap.add_argument("--build-dir", default=os.path.join(ROOT, "build"))
    args = ap.parse_args()

    cfg = DATASETS[args.dataset]
    dataset_id = args.dataset
    os.makedirs(args.build_dir, exist_ok=True)
    db_path = os.path.join(args.build_dir, f"bench_{dataset_id.lower()}.db")
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(db_path + suffix):
            os.remove(db_path + suffix)

    print(f"[1] 建库 {db_path}")
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA cache_size=-131072;
        PRAGMA temp_store=MEMORY;
        """
    )
    conn.executescript(TABLES_SQL)

    t_all = time.perf_counter()
    print("[2] 导入")
    entity_count, t_ent = load_entities(conn, cfg, dataset_id)
    counts, t_ev, ts_min, ts_max = load_events(conn, cfg, dataset_id)
    conn.commit()

    print("[3] 建索引 + FTS + ANALYZE")
    t0 = time.perf_counter()
    conn.executescript(POST_SQL)
    conn.commit()
    t_index = time.perf_counter() - t0
    print(f"  索引与 FTS: {t_index:.2f}s")

    conn.execute(
        "INSERT INTO datasets VALUES (?,?,?,?,?,?,?)",
        (dataset_id, cfg["timezone_status"], counts["events"], entity_count, ts_min, ts_max, "bench-1.0"),
    )
    conn.commit()
    conn.executescript("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")

    db_mb = sum(
        os.path.getsize(db_path + s) / 1024 / 1024 for s in ("", "-wal") if os.path.exists(db_path + s)
    )
    total_import = time.perf_counter() - t_all

    table_sizes = {}
    try:
        for name, pages in conn.execute("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC"):
            table_sizes[name] = round(pages / 1024 / 1024, 2)
    except sqlite3.OperationalError:
        table_sizes = {"_dbstat": "unavailable"}

    total_events = conn.execute(
        "SELECT COUNT(*) FROM events WHERE dataset_id=?", (dataset_id,)
    ).fetchone()[0]
    anchor = conn.execute(
        "SELECT event_id, time_sort_key FROM events WHERE dataset_id=? ORDER BY time_sort_key LIMIT 1 OFFSET ?",
        (dataset_id, total_events // 2),
    ).fetchone()
    top_actor = conn.execute(
        "SELECT actor_id, COUNT(*) c FROM events WHERE dataset_id=? AND actor_id IS NOT NULL "
        "GROUP BY actor_id ORDER BY c DESC LIMIT 1",
        (dataset_id,),
    ).fetchone()
    top_types = [
        r[0]
        for r in conn.execute(
            "SELECT event_type FROM events WHERE dataset_id=? GROUP BY event_type ORDER BY COUNT(*) DESC LIMIT 4",
            (dataset_id,),
        ).fetchall()
    ]

    q = {}
    print("[4] 查询基准")

    q["Q1_hourly_by_type"] = run_query(
        conn,
        "SELECT (time_sort_key/3600)*3600 AS bucket, event_type, COUNT(*) FROM events "
        "WHERE dataset_id=? GROUP BY bucket, event_type ORDER BY bucket",
        (dataset_id,),
        repeat=3,
    )
    q["Q2_daily_totals"] = run_query(
        conn,
        "SELECT (time_sort_key/86400)*86400 AS d, COUNT(*), COUNT(DISTINCT actor_id) FROM events "
        "WHERE dataset_id=? GROUP BY d ORDER BY d",
        (dataset_id,),
        repeat=3,
    )
    q["Q3_type_distribution"] = run_query(
        conn,
        "SELECT event_type, COUNT(*) FROM events WHERE dataset_id=? GROUP BY event_type ORDER BY 2 DESC",
        (dataset_id,),
        repeat=3,
    )
    q["Q4_top_actors"] = run_query(
        conn,
        "SELECT actor_id, COUNT(*) c FROM events WHERE dataset_id=? AND actor_id IS NOT NULL "
        "GROUP BY actor_id ORDER BY c DESC LIMIT 50",
        (dataset_id,),
        repeat=3,
    )
    q["Q5_filtered_page_100"] = run_query(
        conn,
        "SELECT event_id, timestamp_raw, actor_id, event_type FROM events "
        "WHERE dataset_id=? AND event_type IN (?,?,?,?) AND time_sort_key BETWEEN ? AND ? "
        "ORDER BY time_sort_key DESC, event_id LIMIT 100",
        (dataset_id, *top_types, anchor[1] - 86400 * 3, anchor[1]),
    )
    q["Q6_actor_timeline"] = run_query(
        conn,
        "SELECT event_id, timestamp_raw, event_type FROM events WHERE dataset_id=? AND actor_id=? "
        "ORDER BY time_sort_key DESC LIMIT 200",
        (dataset_id, top_actor[0]),
    )
    q["Q7_detail_plus_raw"] = run_query(
        conn,
        "SELECT e.*, r.raw_json FROM events e LEFT JOIN event_raw r "
        "ON r.dataset_id=e.dataset_id AND r.event_id=e.event_id "
        "WHERE e.dataset_id=? AND e.event_id=?",
        (dataset_id, anchor[0]),
    )
    q["Q8_participants_of_event"] = run_query(
        conn,
        "SELECT p.entity_id, p.role, e.label, e.entity_type FROM participants p "
        "LEFT JOIN entities e ON e.dataset_id=p.dataset_id AND e.entity_id=p.entity_id "
        "WHERE p.dataset_id=? AND p.event_id=?",
        (dataset_id, anchor[0]),
    )
    q["Q9_entity_events"] = run_query(
        conn,
        "SELECT e.event_id, e.timestamp_raw, e.event_type FROM participants p "
        "JOIN events e ON e.dataset_id=p.dataset_id AND e.event_id=p.event_id "
        "WHERE p.dataset_id=? AND p.entity_id=? ORDER BY e.time_sort_key LIMIT 300",
        (dataset_id, top_actor[0]),
    )
    q["Q10_neighbor_window"] = run_query(
        conn,
        "SELECT event_id, timestamp_raw, actor_id, event_type FROM events "
        "WHERE dataset_id=? AND time_sort_key BETWEEN ? AND ? ORDER BY time_sort_key LIMIT 500",
        (dataset_id, anchor[1] - 1800, anchor[1] + 1800),
    )
    q["Q11_count_with_filter"] = run_query(
        conn,
        "SELECT COUNT(*) FROM events WHERE dataset_id=? AND event_type=? AND time_sort_key>=?",
        (dataset_id, top_types[0], anchor[1] - 86400),
        repeat=3,
    )
    q["Q12_like_search"] = run_query(
        conn,
        "SELECT event_id FROM events WHERE dataset_id=? AND details_json LIKE ?",
        (dataset_id, "%windward%"),
        repeat=3,
    )
    q["Q13_fts_search"] = run_query(
        conn,
        "SELECT f.event_id FROM event_fts_idx i JOIN event_fts f ON f.rowid=i.rowid "
        "WHERE event_fts_idx MATCH ? LIMIT 200",
        ("windward",),
        repeat=3,
    )
    q["Q14_relations_1hop"] = run_query(
        conn,
        "SELECT src_id, dst_id, relation, COUNT(*) FROM relations WHERE dataset_id=? AND (src_id=? OR dst_id=?) "
        "GROUP BY src_id, dst_id, relation LIMIT 300",
        (dataset_id, top_actor[0], top_actor[0]),
    )
    q["Q15_anchor_lookup"] = run_query(
        conn,
        "SELECT event_id, timestamp_raw FROM events WHERE dataset_id=? AND time_sort_key BETWEEN ? AND ? "
        "AND event_type LIKE '%saidit%'",
        (dataset_id, parse_epoch("2046-05-17T11:21:00Z"), parse_epoch("2046-05-17T11:22:00Z")),
    )

    first_screen_ms = (
        q["Q1_hourly_by_type"]["median_ms"]
        + q["Q3_type_distribution"]["median_ms"]
        + q["Q4_top_actors"]["median_ms"]
    )

    # ---- 优化对照：预聚合 + 去规格化 + UNION 拆分 ----
    print("[5] 优化对照")
    t0 = time.perf_counter()
    for gran, div in (("hour", 3600), ("day", 86400)):
        conn.execute(
            "INSERT INTO time_buckets (dataset_id, granularity, bucket_key, event_type, event_count) "
            "SELECT dataset_id, ?, (time_sort_key/?)*?, event_type, COUNT(*) FROM events "
            "WHERE dataset_id=? GROUP BY 3, event_type",
            (gran, div, div, dataset_id),
        )
    conn.commit()
    conn.execute("ANALYZE")
    t_bucket = time.perf_counter() - t0
    print(f"  time_buckets 构建: {t_bucket:.2f}s")

    opt = {}
    opt["O1_hourly_from_buckets"] = run_query(
        conn,
        "SELECT bucket_key, event_type, event_count FROM time_buckets "
        "WHERE dataset_id=? AND granularity='hour' ORDER BY bucket_key",
        (dataset_id,),
        repeat=3,
    )
    opt["O2_daily_from_buckets"] = run_query(
        conn,
        "SELECT bucket_key, SUM(event_count) FROM time_buckets "
        "WHERE dataset_id=? AND granularity='day' GROUP BY bucket_key ORDER BY bucket_key",
        (dataset_id,),
        repeat=3,
    )
    opt["O9_entity_events_denorm"] = run_query(
        conn,
        "SELECT e.event_id, e.timestamp_raw, e.event_type FROM participants p "
        "JOIN events e ON e.dataset_id=p.dataset_id AND e.event_id=p.event_id "
        "WHERE p.dataset_id=? AND p.entity_id=? ORDER BY p.time_sort_key LIMIT 300",
        (dataset_id, top_actor[0]),
    )
    opt["O14_relations_1hop_capped"] = run_query(
        conn,
        "SELECT * FROM (SELECT src_id, dst_id, relation FROM relations "
        "WHERE dataset_id=? AND src_id=? LIMIT 150) "
        "UNION ALL "
        "SELECT * FROM (SELECT src_id, dst_id, relation FROM relations "
        "WHERE dataset_id=? AND dst_id=? LIMIT 150)",
        (dataset_id, top_actor[0], dataset_id, top_actor[0]),
    )
    opt["O14_relations_1hop_grouped"] = run_query(
        conn,
        "SELECT src_id, dst_id, relation, COUNT(*) FROM ("
        "SELECT * FROM (SELECT src_id, dst_id, relation FROM relations "
        "WHERE dataset_id=? AND src_id=? LIMIT 150) "
        "UNION ALL "
        "SELECT * FROM (SELECT src_id, dst_id, relation FROM relations "
        "WHERE dataset_id=? AND dst_id=? LIMIT 150)"
        ") GROUP BY 1,2,3",
        (dataset_id, top_actor[0], dataset_id, top_actor[0]),
        repeat=3,
    )
    # 概览卡片用的统计量在导入期算好，运行期只读
    t0 = time.perf_counter()
    conn.execute(
        "CREATE TABLE IF NOT EXISTS stat_counts ("
        "dataset_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, cnt INTEGER NOT NULL,"
        "PRIMARY KEY (dataset_id, kind, key))"
    )
    conn.execute(
        "INSERT INTO stat_counts SELECT dataset_id, 'type', event_type, COUNT(*) FROM events "
        "WHERE dataset_id=? GROUP BY event_type",
        (dataset_id,),
    )
    conn.execute(
        "INSERT INTO stat_counts SELECT dataset_id, 'actor', actor_id, COUNT(*) FROM events "
        "WHERE dataset_id=? AND actor_id IS NOT NULL GROUP BY actor_id",
        (dataset_id,),
    )
    conn.commit()
    t_stats = time.perf_counter() - t0
    print(f"  stat_counts 构建: {t_stats:.2f}s")

    opt["O3_type_from_stats"] = run_query(
        conn,
        "SELECT key, cnt FROM stat_counts WHERE dataset_id=? AND kind='type' ORDER BY cnt DESC",
        (dataset_id,),
        repeat=3,
    )
    opt["O4_top_actors_from_stats"] = run_query(
        conn,
        "SELECT key, cnt FROM stat_counts WHERE dataset_id=? AND kind='actor' ORDER BY cnt DESC LIMIT 50",
        (dataset_id,),
        repeat=3,
    )
    opt_first_screen = (
        opt["O2_daily_from_buckets"]["median_ms"]
        + opt["O3_type_from_stats"]["median_ms"]
        + opt["O4_top_actors_from_stats"]["median_ms"]
    )

    result = {
        "dataset": dataset_id,
        "db_size_mb": round(db_mb, 1),
        "table_sizes_mb": table_sizes,
        "counts": counts,
        "entity_count": entity_count,
        "time_range": [ts_min, ts_max],
        "import_seconds": {
            "entities": round(t_ent, 2),
            "events": round(t_ev, 2),
            "index_and_fts": round(t_index, 2),
            "time_buckets": round(t_bucket, 2),
            "total": round(total_import, 2),
        },
        "first_screen_ms": round(first_screen_ms, 2),
        "first_screen_ms_optimized": round(opt_first_screen, 2),
        "queries": q,
        "optimized": opt,
    }

    out = os.path.join(args.build_dir, f"bench_result_{dataset_id.lower()}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print("\n=== 结果 ===")
    print(f"库大小 {db_mb:.1f} MB | 导入总计 {total_import:.2f}s | 首屏三查合计 {first_screen_ms:.1f} ms")
    print(f"{'查询':<28}{'中位ms':>10}{'最小':>9}{'最大':>9}{'行数':>9}")
    for k, v in q.items():
        print(f"{k:<28}{v['median_ms']:>10.2f}{v['min_ms']:>9.2f}{v['max_ms']:>9.2f}{v['rows']:>9}")
    print("\n--- 优化后 ---")
    for k, v in opt.items():
        print(f"{k:<28}{v['median_ms']:>10.2f}{v['min_ms']:>9.2f}{v['max_ms']:>9.2f}{v['rows']:>9}")
    print(f"首屏三查合计（预聚合后）: {opt_first_screen:.1f} ms")
    print(f"\n已写入 {out}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
