"""派生数据入库：CUSTOM 运行、配对与明确父事件边。

规则：
- 只有 manifest 哈希核验通过才写入派生表；否则仅记录 artifact_status，让界面退化为日志浏览。
- runs 的模型与 fixture 从源事件交叉核查，不从 run_id 推断；不一致时写进 metrics_json，不修改源值。
- event_links 只收明确记录的 parent_event_id，并与派生 workflow_edges 逐条比对。
"""

from __future__ import annotations

import json
import os

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


# ------------------------------------------------------------------ MC2 转移对

MC2_TRANSITIONS = "process/views/mc2/transition_pairs.jsonl"
TRANSITION_LAG_LIMIT_US = 1_800_000_000  # 30 分钟：文件本身的子集上限
TRANSITION_BATCH = 5_000


def _set_stat(conn, dataset: str, kind: str, key: str, value: int) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO stat_counts (dataset_id, kind, key, cnt) VALUES (?,?,?,?)",
        (dataset, kind, key, value),
    )


def load_mc2(conn, stats) -> None:
    """M2-04：导入经验证的 transition_pairs。

    规则：
    - manifest 未声明、缺失或哈希不符时直接判失败，不静默跳过（派生文件变化会改变矩阵结论）。
    - 端点必须存在于本库事件中；lag 必须为正且不超过 30 分钟；同一 (source,next) 只收一次。
    - 被排除的样本按原因计数写入 stat_counts，接口必须显式返回，不能只留下“看起来干净”的矩阵。
    """
    dataset = "MC2"
    info = artifacts.verify_manifest_file(MC2_TRANSITIONS)
    ok = info["status"] == "ok"
    stats.check("转移对哈希核验", ok, info["detail"])
    if not ok:
        artifacts.persist_source(conn, dataset, MC2_TRANSITIONS, info.get("sha256", ""), info["status"])
        return
    artifacts.persist_source(conn, dataset, MC2_TRANSITIONS, info["sha256"], "ok")
    artifact_id = f"{dataset}:{MC2_TRANSITIONS}"

    path = os.path.join(artifacts.ARTIFACT_ROOT, MC2_TRANSITIONS)
    event_index = {
        row["event_id"]: row["time_sort_us"]
        for row in conn.execute(
            "SELECT event_id, time_sort_us FROM events WHERE dataset_id=?", (dataset,)
        )
    }
    actor_index = {
        row["event_id"]: row["actor_id"]
        for row in conn.execute(
            "SELECT event_id, actor_id FROM events WHERE dataset_id=? AND actor_id IS NOT NULL",
            (dataset,),
        )
    }
    type_index = {
        row["event_id"]: row["event_type"]
        for row in conn.execute(
            "SELECT event_id, event_type FROM events WHERE dataset_id=?", (dataset,)
        )
    }

    counts = {
        "file_rows": 0,
        "imported": 0,
        "missing_actor": 0,
        "equal_timestamp": 0,
        "unknown_event": 0,
        "out_of_range": 0,
        "duplicate": 0,
        "actor_mismatch": 0,
        "next_actor_mismatch": 0,
        "type_mismatch": 0,
    }
    batch: list[tuple] = []

    def flush() -> None:
        if not batch:
            return
        before = conn.total_changes
        conn.executemany(
            "INSERT OR IGNORE INTO transition_pairs "
            "(dataset_id, actor_id, source_event_id, next_event_id, source_type, next_type, lag_us, artifact_id) "
            "VALUES (?,?,?,?,?,?,?,?)",
            batch,
        )
        added = conn.total_changes - before
        counts["duplicate"] += len(batch) - added
        counts["imported"] += added
        batch.clear()

    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            counts["file_rows"] += 1
            item = json.loads(line)
            actor_id = item.get("actor_id")
            source_id = item.get("source_event_id")
            next_id = item.get("next_event_id")
            source_type = item.get("source_type")
            next_type = item.get("next_type")
            lag_seconds = item.get("lag_seconds")

            if not actor_id:
                counts["missing_actor"] += 1
                continue
            if source_id not in event_index or next_id not in event_index:
                counts["unknown_event"] += 1
                continue
            if actor_index.get(source_id) != actor_id:
                counts["actor_mismatch"] += 1
                continue
            if actor_index.get(next_id) != actor_id:
                counts["next_actor_mismatch"] += 1
                continue
            if type_index.get(source_id) != source_type or type_index.get(next_id) != next_type:
                counts["type_mismatch"] += 1
                continue
            try:
                lag_us = int(round(float(lag_seconds) * 1_000_000))
            except (TypeError, ValueError):
                counts["out_of_range"] += 1
                continue
            if lag_us <= 0 or event_index[source_id] == event_index[next_id]:
                counts["equal_timestamp"] += 1
                continue
            if lag_us > TRANSITION_LAG_LIMIT_US:
                counts["out_of_range"] += 1
                continue
            if not source_type or not next_type:
                counts["unknown_event"] += 1
                continue
            batch.append(
                (
                    dataset,
                    actor_id,
                    source_id,
                    next_id,
                    source_type,
                    next_type,
                    lag_us,
                    artifact_id,
                )
            )
            if len(batch) >= TRANSITION_BATCH:
                flush()
    flush()

    for key in (
        "file_rows",
        "imported",
        "missing_actor",
        "equal_timestamp",
        "unknown_event",
        "out_of_range",
        "duplicate",
        "actor_mismatch",
        "next_actor_mismatch",
        "type_mismatch",
    ):
        _set_stat(conn, dataset, "transition_exclusion", key, counts[key])

    excluded = (
        counts["missing_actor"]
        + counts["equal_timestamp"]
        + counts["unknown_event"]
        + counts["out_of_range"]
        + counts["duplicate"]
        + counts["actor_mismatch"]
        + counts["next_actor_mismatch"]
        + counts["type_mismatch"]
    )
    stats.check(
        "转移对全部导入",
        counts["imported"] + excluded == counts["file_rows"],
        f"{counts['imported']}/{counts['file_rows']} 对，排除 {excluded} 条",
    )
    stats.check(
        "转移对端点存在于事件表",
        counts["unknown_event"] == 0,
        f"未知端点 {counts['unknown_event']} 条",
    )
    stats.check(
        "转移对 actor 与两端事件一致",
        counts["actor_mismatch"] == 0 and counts["next_actor_mismatch"] == 0,
        f"源不一致 {counts['actor_mismatch']} / 后继不一致 {counts['next_actor_mismatch']} 条",
    )
    stats.check(
        "转移对类型与两端事件一致",
        counts["type_mismatch"] == 0,
        f"不一致 {counts['type_mismatch']} 条",
    )
    stats.check(
        "转移对 lag 在 30 分钟内",
        counts["out_of_range"] == 0,
        f"超限 {counts['out_of_range']} 条",
    )
