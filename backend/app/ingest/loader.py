"""导入管线：manifest 驱动的 adapter，把三套数据写入同一套规范表。

原则（对应《数据适配规则》C1–C16）：
- 只对确实缺失的源信息写 null，不臆造 actor / target / parent。
- 每条派生关系都带 derivation，界面上属于"规范化解释"而非原始观测。
- 无法解析的引用计数上报，不静默丢弃。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..config import DATA_DIR, IMPORT_VERSION
from . import schema
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
    checks: list[tuple[str, bool, str]] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append((name, ok, detail))


def parse_epoch(ts: str) -> int:
    """把源时间转成排序用 epoch。MC1 时区未知，按字面量处理，仅用于本数据集内排序。"""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        dt = datetime.fromisoformat(ts)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


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

    conn.executemany("INSERT INTO entities VALUES (?,?,?,?,?,?,?)", rows)

    rel_rows = []
    for edge in org_edges:
        src, dst, rel = edge.get("source"), edge.get("target"), edge.get("relation")
        if src and dst:
            rel_rows.append(
                (manifest.dataset_id, None, src, dst, rel or "org_edge", "source:org_edges", "entity")
            )
    if rel_rows:
        conn.executemany("INSERT INTO relations VALUES (?,?,?,?,?,?,?)", rel_rows)

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

    for table in ("events", "event_raw", "entities", "participants", "relations", "event_fts"):
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

    buffers = {"ev": [], "raw": [], "part": [], "rel": [], "fts": []}

    def flush():
        if buffers["ev"]:
            conn.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", buffers["ev"])
        if buffers["raw"]:
            conn.executemany("INSERT INTO event_raw VALUES (?,?,?)", buffers["raw"])
        if buffers["part"]:
            conn.executemany("INSERT INTO participants VALUES (?,?,?,?,?,?)", buffers["part"])
        if buffers["rel"]:
            conn.executemany("INSERT INTO relations VALUES (?,?,?,?,?,?,?)", buffers["rel"])
        if buffers["fts"]:
            conn.executemany("INSERT INTO event_fts (event_id, dataset_id, body) VALUES (?,?,?)", buffers["fts"])
        for value in buffers.values():
            value.clear()

    path = os.path.join(DATA_DIR, manifest.events_file)
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
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
            tsk = parse_epoch(ts)

            stats.ts_min = ts if stats.ts_min is None or ts < stats.ts_min else stats.ts_min
            stats.ts_max = ts if stats.ts_max is None or ts > stats.ts_max else stats.ts_max

            source_record = obj.get("source_record_id")
            missing_id = source_record is None
            if missing_id:
                stats.missing_source_id += 1

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
                    tsk,
                    tz,
                    actor,
                    obj.get("actor_rule"),
                    etype,
                    obj.get("task_id"),
                    obj.get("document_id") or obj.get("file_id"),
                    obj.get("parent_event_id"),
                    json.dumps(details, ensure_ascii=False) if details else None,
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
                    buffers["part"].append((dataset_id, eid, pid, role, derivation, tsk))
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

    # 预聚合与统计
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

    conn.execute(
        "INSERT INTO datasets VALUES (?,?,?,?,?,?,?,?,?,?,?)",
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
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ),
    )

    if manifest.labels_file:
        _load_annotations(conn, manifest, stats)

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
                "INSERT INTO annotation_events VALUES (?,?,?)",
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

    for anchor in manifest.anchor_list:
        hit = conn.execute(
            "SELECT COUNT(*) FROM events WHERE dataset_id=? AND time_sort_key BETWEEN ? AND ?",
            (dataset_id, parse_epoch(anchor.time_raw) - 3600, parse_epoch(anchor.time_raw) + 3600),
        ).fetchone()[0]
        stats.check(f"锚点可定位：{anchor.key}", hit > 0, f"±1h 内 {hit} 条")
