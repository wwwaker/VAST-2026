"""导入管线：manifest 驱动的 adapter，把三套数据写入同一套规范表（schema v2）。

原则（对应《数据适配规则》C1–C16）：
- 只对确实缺失的源信息写 null，不臆造 actor / target / parent。
- 每条派生关系都带 derivation，界面上属于“规范化解释”而非原始观测。
- 无法解析的引用计数上报，不静默丢弃。
- 时间统一用整数微秒排序（time_sort_us），并保留整数秒 time_sort_key 供按天/小时聚合。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..config import DATA_DIR, IMPORT_VERSION
from ..domain import event_types
from . import derived, schema
from .manifest import DatasetManifest

TEXT_KEYS = (
    "content",
    "subject",
    "title",
    "reason",
    "feedback",
    "purpose",
    "assignment",
    "task",
    # 帖子类事件没有正文，正文在文件里，但 content_source 本身是可检索的关键线索
    "content_source",
    "action",
    "path",
)

_EVENT_COLUMNS = (
    "dataset_id",
    "event_id",
    "source_record_id",
    "timestamp_raw",
    "timestamp_normalized",
    "time_sort_us",
    "time_sort_key",
    "timezone_status",
    "actor_id",
    "actor_rule",
    "event_type",
    "task_id",
    "run_id",
    "document_id",
    "target_id",
    "version",
    "channel_id",
    "parent_event_id",
    "details_json",
    "source_file",
    "source_ordinal",
    "source_json_pointer",
    "source_missing_id",
    "has_deliberation",
)

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_FRACTION = re.compile(r"\.(\d+)")


@dataclass
class DatasetStats:
    dataset_id: str
    events: int = 0
    entities: int = 0
    participants: int = 0
    relations: int = 0
    fts_rows: int = 0
    annotations: int = 0
    unresolved_refs: int = 0
    missing_source_id: int = 0
    deliberations: int = 0
    ts_min: str | None = None
    ts_max: str | None = None
    ts_min_us: int | None = None
    ts_max_us: int | None = None
    data_version: str = ""
    runs: int = 0
    pairs: int = 0
    parent_links: int = 0
    artifact_status: str = "not_configured"
    artifact_id: str | None = None
    unknown_types: list[str] = field(default_factory=list)
    checks: list[tuple[str, bool, str]] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append((name, ok, detail))


def parse_epoch_us(ts: str) -> int:
    """把源时间转成整数微秒。

    - 不使用 datetime.timestamp() * 1e6，避免浮点舍入；用 days/seconds/microseconds 整数运算。
    - MC1 时区未知：按字面量当成本数据集内部坐标轴，不与其他数据集混排。
    - 源时间超过 6 位小数时直接报错，不静默截断。
    """
    match = _FRACTION.search(ts)
    if match and len(match.group(1)) > 6:
        raise ValueError(f"时间精度超过微秒，拒绝静默截断：{ts}")
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        dt = datetime.fromisoformat(ts)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = dt.astimezone(timezone.utc) - _EPOCH
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def parse_epoch(ts: str) -> int:
    """整数秒：只保留给按天/小时聚合与旧锚点区间，不用于新查询排序。"""
    return parse_epoch_us(ts) // 1_000_000


def _norm_ts(ts: str, tz_status: str) -> str:
    if tz_status == "utc" and ts.endswith("Z"):
        return ts.replace("Z", "+00:00")
    return ts


def _text_of(details, raw) -> str:
    parts: list[str] = []
    if isinstance(details, dict):
        for key in TEXT_KEYS:
            value = details.get(key)
            if isinstance(value, str) and value:
                parts.append(value)
            elif isinstance(value, dict):
                for sub in ("content", "subject", "title"):
                    inner = value.get(sub)
                    if isinstance(inner, str) and inner:
                        parts.append(inner)
    if isinstance(raw, dict):
        state = raw.get("internal_state")
        if isinstance(state, dict):
            for value in state.values():
                if isinstance(value, str) and value:
                    parts.append(value)
    return "\n".join(parts)


def _as_int(value) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_entities(conn, manifest: DatasetManifest, stats: DatasetStats) -> tuple[dict[str, str], dict[str, str]]:
    """写入实体表，返回 role→entity_id 与 source_value→entity_id 两张映射。"""
    path = os.path.join(DATA_DIR, manifest.entities_file)
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    if manifest.entity_container is None:
        entities, org_edges = payload, []
    else:
        entities = payload.get(manifest.entity_container) or []
        org_edges = payload.get("org_edges") or []

    rows = []
    role_map: dict[str, str] = {}
    value_map: dict[str, str] = {}
    for ent in entities:
        eid = ent.get("entity_id")
        if not eid:
            continue
        roles = ent.get("roles")
        attrs = {
            k: v
            for k, v in ent.items()
            if k not in ("entity_id", "entity_type", "source_value", "label", "labels", "roles")
        }
        label = ent.get("label")
        if not label and isinstance(ent.get("labels"), list) and ent["labels"]:
            label = ent["labels"][0]
        if not label and isinstance(ent.get("role"), str):
            label = ent["role"]
        rows.append(
            (
                manifest.dataset_id,
                eid,
                ent.get("entity_type"),
                ent.get("source_value"),
                label,
                json.dumps(roles, ensure_ascii=False) if roles else None,
                json.dumps(attrs, ensure_ascii=False) if attrs else None,
            )
        )
        value_map[str(ent.get("source_value"))] = eid
        for role in roles or []:
            role_map[str(role)] = eid

    conn.executemany(
        "INSERT INTO entities (dataset_id,entity_id,entity_type,source_value,label,roles_json,attrs_json) "
        "VALUES (?,?,?,?,?,?,?)",
        rows,
    )

    rel_rows = []
    for edge in org_edges:
        src, dst, rel = edge.get("source"), edge.get("target"), edge.get("relation")
        if src and dst:
            rel_rows.append(
                (manifest.dataset_id, None, src, dst, rel or "org_edge", "source:org_edges", "entity")
            )
    if rel_rows:
        conn.executemany(
            "INSERT INTO relations (dataset_id,event_id,src_id,dst_id,relation,derivation,target_kind) "
            "VALUES (?,?,?,?,?,?,?)",
            rel_rows,
        )

    stats.entities = len(rows)
    stats.relations += len(rel_rows)
    return role_map, value_map


def _build_record_index(manifest: DatasetManifest) -> dict[str, str]:
    """MC1 的 responding_to 指向 source_record_id，需要先建映射。"""
    index: dict[str, str] = {}
    path = os.path.join(DATA_DIR, manifest.events_file)
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            src = obj.get("source_record_id")
            if src is not None:
                index[str(src)] = obj["event_id"]
    return index


def load_dataset(conn, manifest: DatasetManifest) -> DatasetStats:
    stats = DatasetStats(dataset_id=manifest.dataset_id)
    dataset_id = manifest.dataset_id
    tz = manifest.timezone_status

    for table in (
        "events",
        "event_raw",
        "entities",
        "participants",
        "relations",
        "event_fts",
        "runs",
        "run_pairs",
        "event_links",
        "artifact_sources",
    ):
        conn.execute(f"DELETE FROM {table} WHERE dataset_id=?", (dataset_id,))
    conn.execute("DELETE FROM annotations WHERE dataset_id=?", (dataset_id,))
    conn.execute("DELETE FROM annotation_events WHERE dataset_id=?", (dataset_id,))
    conn.execute("DELETE FROM time_buckets WHERE dataset_id=?", (dataset_id,))
    conn.execute("DELETE FROM stat_counts WHERE dataset_id=?", (dataset_id,))
    conn.execute("DELETE FROM datasets WHERE dataset_id=?", (dataset_id,))

    role_map, _ = _load_entities(conn, manifest, stats)
    # 别名表的值就是实体 ID
    alias = dict(manifest.recipient_alias)

    record_index = (
        _build_record_index(manifest) if manifest.participant_rule == "mc1_recipients" else {}
    )

    events_path = os.path.join(DATA_DIR, manifest.events_file)
    stats.data_version = _sha256(events_path)

    buffers = {"ev": [], "raw": [], "part": [], "rel": [], "fts": []}
    type_counter: Counter[str] = Counter()
    runs: set[str] = set()

    event_sql = (
        "INSERT INTO events (" + ",".join(_EVENT_COLUMNS) + ") VALUES ("
        + ",".join("?" * len(_EVENT_COLUMNS)) + ")"
    )

    def flush():
        if buffers["ev"]:
            conn.executemany(event_sql, buffers["ev"])
        if buffers["raw"]:
            conn.executemany(
                "INSERT INTO event_raw (dataset_id,event_id,raw_json) VALUES (?,?,?)", buffers["raw"]
            )
        if buffers["part"]:
            conn.executemany(
                "INSERT INTO participants (dataset_id,event_id,entity_id,role,derivation,time_sort_key,time_sort_us) "
                "VALUES (?,?,?,?,?,?,?)",
                buffers["part"],
            )
        if buffers["rel"]:
            conn.executemany(
                "INSERT INTO relations (dataset_id,event_id,src_id,dst_id,relation,derivation,target_kind) "
                "VALUES (?,?,?,?,?,?,?)",
                buffers["rel"],
            )
        if buffers["fts"]:
            conn.executemany(
                "INSERT INTO event_fts (event_id,dataset_id,body) VALUES (?,?,?)", buffers["fts"]
            )
        for value in buffers.values():
            value.clear()

    with open(events_path, "r", encoding="utf-8") as f:
        for ordinal, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            eid = obj["event_id"]
            ts = obj["timestamp"]
            details = obj.get("details")
            raw = obj.get("raw")
            actor = obj.get("actor_id")
            etype = obj.get("event_type") or "unknown"
            ts_us = parse_epoch_us(ts)
            tsk = ts_us // 1_000_000
            type_counter[etype] += 1

            if stats.ts_min_us is None or ts_us < stats.ts_min_us:
                stats.ts_min = ts
                stats.ts_min_us = ts_us
            if stats.ts_max_us is None or ts_us > stats.ts_max_us:
                stats.ts_max = ts
                stats.ts_max_us = ts_us

            source_record = obj.get("source_record_id")
            missing_id = source_record is None
            if missing_id:
                stats.missing_source_id += 1

            run_id = obj.get("run_id")
            if run_id:
                runs.add(str(run_id))

            deliberation = 0
            if isinstance(raw, dict) and isinstance(raw.get("internal_state"), dict):
                if any(isinstance(v, str) and v for v in raw["internal_state"].values()):
                    deliberation = 1
                    stats.deliberations += 1

            buffers["ev"].append(
                (
                    dataset_id,
                    eid,
                    str(source_record) if source_record is not None else None,
                    ts,
                    _norm_ts(ts, tz),
                    ts_us,
                    tsk,
                    tz,
                    actor,
                    obj.get("actor_rule"),
                    etype,
                    obj.get("task_id"),
                    str(run_id) if run_id is not None else None,
                    obj.get("document_id") or obj.get("file_id"),
                    obj.get("target_id"),
                    _as_int(obj.get("version")),
                    obj.get("channel_id"),
                    obj.get("parent_event_id"),
                    json.dumps(details, ensure_ascii=False) if details else None,
                    obj.get("source_file"),
                    ordinal,
                    obj.get("source_json_pointer"),
                    int(missing_id),
                    deliberation,
                )
            )

            if raw is not None:
                buffers["raw"].append((dataset_id, eid, json.dumps(raw, ensure_ascii=False)))

            # 去重键是实体本身：actor / party / 关系目标可能指向同一实体，只保留最先出现的角色。
            # 频道不进参与者列表，改为 in_channel / broadcast_to 关系边（频道是上下文，不是参与方）。
            seen: set[str] = set()

            def add_participant(pid: str | None, role: str, derivation: str) -> None:
                if pid and pid not in seen:
                    buffers["part"].append((dataset_id, eid, pid, role, derivation, tsk, ts_us))
                    seen.add(pid)

            add_participant(actor, "actor", "source:actor_id")

            if manifest.participant_rule == "party_ids":
                for pid in obj.get("party_ids") or []:
                    add_participant(pid, "party", "source:party_ids")
            elif manifest.participant_rule == "custom":
                add_participant(obj.get("target_id"), "target", "source:target_id")
            elif manifest.participant_rule == "mc1_recipients":
                channel = obj.get("channel_id")
                if channel:
                    buffers["rel"].append(
                        (dataset_id, eid, actor, channel, "in_channel", "source:channel_id", "entity")
                    )
                broadcast = False
                for token in (raw or {}).get("recipients") or []:
                    if token == "ALL":
                        broadcast = True
                        continue
                    target_entity = alias.get(token) or role_map.get(token)
                    if target_entity:
                        add_participant(target_entity, "recipient", "adapter:recipients")
                    else:
                        stats.unresolved_refs += 1
                if broadcast and channel:
                    buffers["rel"].append(
                        (dataset_id, eid, actor, channel, "broadcast_to", "adapter:recipients", "entity")
                    )

            # 源关系边
            for rel in obj.get("relationships") or []:
                dst = rel.get("entity_id")
                if not dst:
                    continue
                derivation = "source:relationships" if actor else "source:relationships:actor_null"
                buffers["rel"].append(
                    (dataset_id, eid, actor, dst, rel.get("relation") or "unknown", derivation, "entity")
                )
                add_participant(dst, rel.get("relation") or "related", "source:relationships")

            # MC1 responding_to 双语义（C1）
            responding_to = (details or {}).get("responding_to") if isinstance(details, dict) else None
            if isinstance(responding_to, str):
                if responding_to in record_index:
                    buffers["rel"].append(
                        (
                            dataset_id,
                            eid,
                            actor,
                            record_index[responding_to],
                            "reply_to",
                            "adapter:responding_to",
                            # 回复指向另一条事件，不是实体，关系图必须排除
                            "event",
                        )
                    )
                elif responding_to.startswith("@"):
                    for token in responding_to.replace(",", " ").split():
                        if not token.startswith("@"):
                            continue
                        name = token.lstrip("@")
                        target_entity = alias.get(name) or role_map.get(name)
                        if target_entity:
                            buffers["rel"].append(
                                (
                                    dataset_id,
                                    eid,
                                    actor,
                                    target_entity,
                                    "mention",
                                    "adapter:mention_text",
                                    "entity",
                                )
                            )
                        else:
                            stats.unresolved_refs += 1
                else:
                    stats.unresolved_refs += 1

            body = _text_of(details, raw)
            if body:
                buffers["fts"].append((eid, dataset_id, body))
                stats.fts_rows += 1

            stats.events += 1
            stats.participants += len(seen)
            if stats.events % 5000 == 0:
                flush()

    flush()

    # 关系边由实体组织边和逐事件派生边共同构成，统一以库内实际行数计
    stats.relations = conn.execute(
        "SELECT COUNT(*) FROM relations WHERE dataset_id=?", (dataset_id,)
    ).fetchone()[0]

    # 预聚合与统计：这里继续使用整数秒 time_sort_key，桶语义不变
    for granularity, div in (("hour", 3600), ("day", 86400)):
        conn.execute(
            "INSERT INTO time_buckets (dataset_id, granularity, bucket_key, event_type, event_count) "
            "SELECT dataset_id, ?, (time_sort_key/?)*?, event_type, COUNT(*) FROM events "
            "WHERE dataset_id=? GROUP BY 3, event_type",
            (granularity, div, div, dataset_id),
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

    stats.runs = len(runs)
    stats.unknown_types = event_types.unknown_types(dataset_id, list(type_counter))

    if manifest.labels_file:
        _load_annotations(conn, manifest, stats)

    # 派生数据依赖已入库事件与标签：哈希核验通过才写 runs / run_pairs / event_links
    if manifest.dataset_id == "CUSTOM":
        derived.load_custom(conn, stats)

    conn.execute(
        "INSERT INTO datasets (dataset_id,name,question,timezone_status,event_count,entity_count,"
        "ts_min,ts_max,deliberation_count,import_version,data_version,schema_version,imported_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            dataset_id,
            manifest.name,
            manifest.question,
            tz,
            stats.events,
            stats.entities,
            stats.ts_min,
            stats.ts_max,
            stats.deliberations,
            IMPORT_VERSION,
            stats.data_version,
            schema.SCHEMA_VERSION,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ),
    )

    _run_checks(conn, manifest, stats)
    return stats


def _load_annotations(conn, manifest: DatasetManifest, stats: DatasetStats) -> None:
    path = os.path.join(DATA_DIR, manifest.labels_file)
    with open(path, "r", encoding="utf-8") as f:
        labels = json.load(f)

    ids = set()
    for label in labels:
        cursor = conn.execute(
            "INSERT INTO annotations (dataset_id, run_id, scenario, anomaly_type, observed, reason) "
            "VALUES (?,?,?,?,?,?)",
            (
                manifest.dataset_id,
                label.get("run_id"),
                label.get("scenario"),
                label.get("anomaly_type"),
                int(bool(label.get("observed"))),
                label.get("reason"),
            ),
        )
        annotation_id = cursor.lastrowid
        for event_id in label.get("affected_event_ids") or []:
            conn.execute(
                "INSERT INTO annotation_events (annotation_id,dataset_id,event_id) VALUES (?,?,?)",
                (annotation_id, manifest.dataset_id, event_id),
            )
            ids.add(event_id)
        stats.annotations += 1

    stats.check(
        "标签引用的受影响事件全部可解析",
        all(
            conn.execute(
                "SELECT 1 FROM events WHERE dataset_id=? AND event_id=?", (manifest.dataset_id, eid)
            ).fetchone()
            for eid in ids
        ),
        f"{len(ids)} 个事件",
    )


def _run_checks(conn, manifest: DatasetManifest, stats: DatasetStats) -> None:
    dataset_id = manifest.dataset_id

    buckets = conn.execute(
        "SELECT COUNT(*) FROM time_buckets WHERE dataset_id=? AND granularity='hour'", (dataset_id,)
    ).fetchone()[0]
    stats.check("生成小时聚合", buckets > 0, f"{buckets} 个桶")

    stat_rows = conn.execute(
        "SELECT COUNT(*) FROM stat_counts WHERE dataset_id=?", (dataset_id,)
    ).fetchone()[0]
    stats.check("生成概览统计", stat_rows > 0, f"{stat_rows} 行")

    if manifest.timezone_status == "unknown":
        stats.check(
            "MC1 时间未被转换为 UTC",
            stats.ts_min is not None and "T" in (stats.ts_min or ""),
            f"源时间 {stats.ts_min} → {stats.ts_max}",
        )

    if dataset_id == "CUSTOM":
        distinct_us = conn.execute(
            "SELECT COUNT(DISTINCT time_sort_us) FROM events WHERE dataset_id=?", (dataset_id,)
        ).fetchone()[0]
        stats.check(
            "微秒排序键未折叠",
            distinct_us == stats.events,
            f"{distinct_us}/{stats.events} 个不同微秒",
        )
        missing_run = conn.execute(
            "SELECT COUNT(*) FROM events WHERE dataset_id=? AND run_id IS NULL", (dataset_id,)
        ).fetchone()[0]
        stats.check(
            "运行维度完整",
            missing_run == 0 and stats.runs > 0,
            f"{stats.runs} 个运行，缺失 run_id {missing_run} 条",
        )

    stats.check(
        "事件类型均在字典内",
        not stats.unknown_types,
        "未知：" + "、".join(stats.unknown_types[:5]) if stats.unknown_types else f"{len(event_types.types_for(dataset_id))} 类已知",
    )

    for anchor in manifest.anchor_list:
        anchor_us = parse_epoch_us(anchor.time_raw)
        hit = conn.execute(
            "SELECT COUNT(*) FROM events WHERE dataset_id=? AND time_sort_us BETWEEN ? AND ?",
            (dataset_id, anchor_us - 3_600_000_000, anchor_us + 3_600_000_000),
        ).fetchone()[0]
        stats.check(f"锚点可定位：{anchor.key}", hit > 0, f"±1h 内 {hit} 条")
