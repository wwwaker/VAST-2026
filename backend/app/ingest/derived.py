"""派生数据入库：CUSTOM 运行、配对与明确父事件边。

规则：
- 只有 manifest 哈希核验通过才写入派生表；否则仅记录 artifact_status，让界面退化为日志浏览。
- runs 的模型与 fixture 从源事件交叉核查，不从 run_id 推断；不一致时写进 metrics_json，不修改源值。
- event_links 只收明确记录的 parent_event_id，并与派生 workflow_edges 逐条比对。
"""

from __future__ import annotations

import json

from . import artifacts


def _scalar(conn, sql: str, params: tuple):
    row = conn.execute(sql, params).fetchone()
    return row[0] if row else None


def _load_links(conn, stats) -> None:
    dataset = "CUSTOM"
    conn.execute(
        "INSERT OR IGNORE INTO event_links "
        "(dataset_id, source_event_id, target_event_id, relation, derivation, artifact_id) "
        "SELECT dataset_id, parent_event_id, event_id, 'recorded_parent', "
        "'source:parent_event_id', ? FROM events "
        "WHERE dataset_id=? AND parent_event_id IS NOT NULL "
        "AND parent_event_id IN (SELECT event_id FROM events WHERE dataset_id=?)",
        (stats.artifact_id, dataset, dataset),
    )
    stats.parent_links = conn.execute(
        "SELECT COUNT(*) FROM event_links WHERE dataset_id=?", (dataset,)
    ).fetchone()[0]


def _load_runs(conn, stats, views: dict) -> None:
    dataset = "CUSTOM"
    runs_view = views.get("runs") or []
    aggregates = {
        row["run_id"]: row
        for row in conn.execute(
            "SELECT run_id, COUNT(*) AS c, MIN(time_sort_us) AS lo, MAX(time_sort_us) AS hi "
            "FROM events WHERE dataset_id=? AND run_id IS NOT NULL GROUP BY run_id",
            (dataset,),
        )
    }
    labels = {
        row["run_id"]: row
        for row in conn.execute(
            "SELECT run_id, scenario, observed, anomaly_type FROM annotations WHERE dataset_id=?",
            (dataset,),
        )
    }

    inserted = 0
    for item in runs_view:
        run_id = item.get("run_id")
        if not run_id or run_id not in aggregates:
            continue
        aggregate = aggregates[run_id]
        label = labels.get(run_id)
        scenario = (label["scenario"] if label else None) or item.get("scenario")
        observed = int(bool(label["observed"])) if label else int(bool(item.get("source_label", {}).get("observed")))

        source_model = _scalar(
            conn,
            "SELECT json_extract(details_json,'$.model') FROM events "
            "WHERE dataset_id=? AND run_id=? AND event_type='run_started' LIMIT 1",
            (dataset, run_id),
        )
        source_fixture = _scalar(
            conn,
            "SELECT json_extract(details_json,'$.path') FROM events "
            "WHERE dataset_id=? AND run_id=? AND event_type='file_read' "
            "AND actor_id LIKE '%:researcher' ORDER BY time_sort_us LIMIT 1",
            (dataset, run_id),
        )
        type_counts = {
            row["event_type"]: row["c"]
            for row in conn.execute(
                "SELECT event_type, COUNT(*) AS c FROM events WHERE dataset_id=? AND run_id=? "
                "GROUP BY event_type",
                (dataset, run_id),
            )
        }
        metrics = {
            "views_event_count": item.get("event_count"),
            "source_event_count": aggregate["c"],
            "event_count_match": item.get("event_count") == aggregate["c"],
            "views_model": item.get("model"),
            "source_model": source_model,
            "model_match": item.get("model") == source_model,
            "views_fixture": item.get("fixture"),
            "source_fixture": source_fixture,
            "fixture_match": item.get("fixture") == source_fixture,
            "views_duration_seconds": item.get("duration_seconds"),
            "source_duration_seconds": round((aggregate["hi"] - aggregate["lo"]) / 1_000_000, 6),
            "type_counts": type_counts,
        }
        conn.execute(
            "INSERT OR REPLACE INTO runs "
            "(dataset_id, run_id, model, fixture, scenario, observed, anomaly_type, "
            "start_us, end_us, event_count, metrics_json, artifact_id) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                dataset,
                run_id,
                item.get("model"),
                item.get("fixture"),
                scenario,
                observed,
                label["anomaly_type"] if label else item.get("source_label", {}).get("anomaly_type"),
                aggregate["lo"],
                aggregate["hi"],
                aggregate["c"],
                json.dumps(metrics, ensure_ascii=False),
                stats.artifact_id,
            ),
        )
        inserted += 1

    stats.runs = inserted
    total_events = sum(row["c"] for row in aggregates.values())
    stats.check(
        "运行汇总与事件总数一致",
        inserted == len(aggregates) and total_events == stats.events,
        f"{inserted} 个运行 / {total_events} 条事件",
    )
    missing = conn.execute(
        "SELECT COUNT(*) FROM events WHERE dataset_id=? AND run_id IS NULL", (dataset,)
    ).fetchone()[0]
    stats.check("所有事件归属运行", missing == 0, f"缺失 run_id {missing} 条")


def _load_pairs(conn, stats, views: dict) -> None:
    dataset = "CUSTOM"
    runs = {
        row["run_id"]: row
        for row in conn.execute(
            "SELECT run_id, model, fixture, scenario FROM runs WHERE dataset_id=?", (dataset,)
        )
    }
    invalid = 0
    inserted = 0
    for pair in views.get("matched_comparisons") or []:
        run_id = pair.get("run_id")
        normal_id = pair.get("normal_run_id")
        left, right = runs.get(run_id), runs.get(normal_id)
        if not left or not right:
            invalid += 1
            continue
        same_model = (pair.get("model") or left["model"]) == right["model"] == left["model"]
        same_fixture = (pair.get("fixture") or left["fixture"]) == right["fixture"] == left["fixture"]
        normal_ok = (right["scenario"] or "") == "normal"
        if not (same_model and same_fixture and normal_ok):
            invalid += 1
            continue
        conn.execute(
            "INSERT OR REPLACE INTO run_pairs "
            "(dataset_id, run_id, normal_run_id, model, fixture, artifact_id) VALUES (?,?,?,?,?,?)",
            (dataset, run_id, normal_id, left["model"], left["fixture"], stats.artifact_id),
        )
        inserted += 1

    stats.pairs = inserted
    stats.check(
        "配对运行合法（同模型/同任务/正常对照）",
        invalid == 0 and inserted == len(views.get("matched_comparisons") or []),
        f"{inserted} 对合法，{invalid} 对跳过",
    )


def _check_edges(conn, stats, views: dict) -> None:
    dataset = "CUSTOM"
    source_edges = {
        (row["source_event_id"], row["target_event_id"])
        for row in conn.execute(
            "SELECT source_event_id, target_event_id FROM event_links WHERE dataset_id=?",
            (dataset,),
        )
    }
    derived_edges = {
        (edge.get("source_event_id"), edge.get("target_event_id"))
        for edge in views.get("workflow_edges") or []
    }
    kinds = {edge.get("kind") for edge in views.get("workflow_edges") or []}
    stats.check(
        "父事件边与派生 workflow_edges 一致",
        source_edges == derived_edges and kinds <= {"recorded_parent"},
        f"源 {len(source_edges)} 条 / 派生 {len(derived_edges)} 条 / kind={sorted(kinds)}",
    )


def load_custom(conn, stats) -> None:
    bundle = artifacts.load_bundle("CUSTOM", stats.data_version)
    artifacts.persist(conn, bundle)
    stats.artifact_status = bundle.status
    stats.artifact_id = bundle.artifact_id
    if bundle.status != "ok" or not bundle.views:
        stats.check("派生视图可用", True, f"未接入（{bundle.status}：{bundle.detail}）")
        return

    stats.check("派生视图可用", True, bundle.detail)
    _load_links(conn, stats)
    _load_runs(conn, stats, bundle.views)
    _load_pairs(conn, stats, bundle.views)
    _check_edges(conn, stats, bundle.views)
