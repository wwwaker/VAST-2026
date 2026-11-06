"""MC2 历史模式与干预论证（S3B）。

只使用 `relations` 与 `events` 里的记录字段。两条边界必须保留：
- “内容文件 X.txt”与“指令文件 X_further_instructions.md”之间的对应关系来自**文件名前缀**，
  属于 name_hint，不是日志里记录的关系；本模块把它标成 ``link_basis="name_prefix"``。
- 排队转交事件与随后的发布事件之间没有显式父边，只有“同执行者 + 时间相邻”，
  因此不能做“切断确定路径”的证明，只能说某阶段在该链中出现过。
"""

from __future__ import annotations

import json
from typing import Any

from . import mc2_files

POST_RELATION = "post_content_source"
INSTRUCTION_SUFFIX = "_further_instructions.md"
NEAR_US = 60_000_000  # 60 秒内视为“紧邻发布”

STAGES = (
    ("content_created", "内容文件创建"),
    ("instruction_read", "指令文件被读取"),
    ("relay_queued", "接力任务转交"),
    ("pre_post_receipt", "发布前回执"),
    ("posted", "公开发布"),
    ("cleanup_instruction", "清理指令文件"),
    ("cleanup_content", "清理内容文件"),
)
STAGE_LABELS = dict(STAGES)


def _json(value: str | None) -> dict:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _stage(status: str, **extra: Any) -> dict:
    return {"status": status, **extra}


def instruction_file_for(conn, dataset: str, content_file_id: str) -> str | None:
    """按同名前缀找到指令文件；这是 name_hint，不是记录关系。"""
    for item in mc2_files.shared_prefix_candidates(conn, dataset, content_file_id, limit=10):
        if item["path"].endswith(INSTRUCTION_SUFFIX):
            return item["file_id"]
    return None


def _file_clause(
    file_id: str,
    types: tuple[str, ...] | None,
    start_us: int | None,
    end_us: int | None,
) -> tuple[str, list[Any]]:
    clauses = ["r.dataset_id = ?", "r.dst_id = ?", "r.event_id IS NOT NULL"]
    params: list[Any] = []
    if types:
        clauses.append("e.event_type IN (" + ",".join("?" * len(types)) + ")")
        params.extend(types)
    if start_us is not None:
        clauses.append("e.time_sort_us >= ?")
        params.append(start_us)
    if end_us is not None:
        clauses.append("e.time_sort_us <= ?")
        params.append(end_us)
    return " AND ".join(clauses), params


def _count_on_file(
    conn,
    dataset: str,
    file_id: str | None,
    types: tuple[str, ...] | None = None,
    start_us: int | None = None,
    end_us: int | None = None,
) -> int:
    if not file_id:
        return 0
    clause, params = _file_clause(file_id, types, start_us, end_us)
    row = conn.execute(
        "SELECT COUNT(DISTINCT e.event_id) AS total FROM relations r JOIN events e "
        "  ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
        "WHERE " + clause,
        [dataset, file_id, *params],
    ).fetchone()
    return int(row["total"] or 0)


def _events_on_file(
    conn,
    dataset: str,
    file_id: str | None,
    types: tuple[str, ...] | None = None,
    start_us: int | None = None,
    end_us: int | None = None,
    limit: int = 50,
    order: str = "asc",
) -> list[dict]:
    if not file_id:
        return []
    clause, params = _file_clause(file_id, types, start_us, end_us)
    direction = "DESC" if order == "desc" else "ASC"
    rows = conn.execute(
        "SELECT DISTINCT e.event_id, e.event_type, e.time_sort_us, e.actor_id, e.details_json, "
        "       r.relation, en.label AS actor_label "
        "FROM relations r JOIN events e "
        "  ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
        "LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
        "WHERE " + clause
        + f" ORDER BY e.time_sort_us {direction}, e.event_id {direction} LIMIT ?",
        [dataset, file_id, *params, limit],
    ).fetchall()
    return [
        {
            "event_id": row["event_id"],
            "event_type": row["event_type"],
            "time_us": row["time_sort_us"],
            "actor_id": row["actor_id"],
            "actor_label": row["actor_label"],
            "relation": row["relation"],
            "details": _json(row["details_json"]),
        }
        for row in rows
    ]


def signature(conn, dataset: str, post_event_id: str) -> dict:
    """单条“文件为内容源”的发布事件的阶段签名。"""
    post = conn.execute(
        "SELECT event_id, event_type, time_sort_us, actor_id, details_json, "
        "       en.label AS actor_label "
        "FROM events e LEFT JOIN entities en "
        "  ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
        "WHERE e.dataset_id=? AND e.event_id=?",
        (dataset, post_event_id),
    ).fetchone()
    if post is None:
        raise KeyError(post_event_id)

    link = conn.execute(
        "SELECT dst_id FROM relations WHERE dataset_id=? AND event_id=? AND relation=?",
        (dataset, post_event_id, POST_RELATION),
    ).fetchone()
    content_file_id = link["dst_id"] if link else None
    content = mc2_files.file_row(conn, dataset, content_file_id) if content_file_id else None
    instruction_id = instruction_file_for(conn, dataset, content_file_id) if content_file_id else None
    instruction = mc2_files.file_row(conn, dataset, instruction_id) if instruction_id else None

    post_us = post["time_sort_us"]
    actor = post["actor_id"]
    stages: dict[str, dict] = {}

    created = _events_on_file(conn, dataset, content_file_id, ("create_file",))
    stages["content_created"] = _stage(
        "present" if created else "missing",
        support_kind="recorded",
        event_ids=[item["event_id"] for item in created],
        first_us=created[0]["time_us"] if created else None,
        actor_labels=sorted({item["actor_label"] or item["actor_id"] or "—" for item in created}),
        note="" if created else "日志里没有该内容文件的创建事件",
    )

    reads = _events_on_file(conn, dataset, instruction_id, ("read_file",))
    stages["instruction_read"] = _stage(
        "present" if reads else "missing",
        support_kind="recorded",
        link_basis="name_prefix",
        event_ids=[item["event_id"] for item in reads],
        first_us=reads[0]["time_us"] if reads else None,
        actor_labels=sorted({item["actor_label"] or item["actor_id"] or "—" for item in reads}),
        note="" if reads else "该指令文件没有读取记录",
    )

    # 186 次转交不能整列入返回；只给总数、紧邻发布前的那次，以及少量样本
    relay_total = _count_on_file(conn, dataset, instruction_id, ("queue_subordinate_task",))
    relays_near = _events_on_file(
        conn,
        dataset,
        instruction_id,
        ("queue_subordinate_task",),
        start_us=post_us - NEAR_US,
        end_us=post_us,
        limit=5,
        order="desc",
    )
    relays_sample = _events_on_file(
        conn, dataset, instruction_id, ("queue_subordinate_task",), limit=10, order="asc"
    )
    stages["relay_queued"] = _stage(
        "present" if relay_total else "missing",
        support_kind="recorded",
        link_basis="name_prefix",
        sample_event_ids=[item["event_id"] for item in relays_sample],
        nearest_event_id=relays_near[0]["event_id"] if relays_near else None,
        # MC2 的 agent 实体多数没有 label，回落为 actor_id，否则界面只剩事件号
        nearest_actor=(
            relays_near[0]["actor_label"] or relays_near[0]["actor_id"]
        )
        if relays_near
        else None,
        nearest_lag_us=(post_us - relays_near[0]["time_us"]) if relays_near else None,
        total=relay_total,
        note=(
            ""
            if relays_near
            else "该指令文件有转交记录，但发布前 60 秒内没有紧邻的转交"
            if relay_total
            else "没有该指令文件的排队转交记录"
        ),
    )

    receipts = [
        {
            "event_id": row["event_id"],
            "event_type": row["event_type"],
            "time_us": row["time_sort_us"],
            "actor_id": row["actor_id"],
        }
        for row in conn.execute(
            "SELECT event_id, event_type, time_sort_us, actor_id FROM events "
            "WHERE dataset_id=? AND event_type='saidit_post_check' AND actor_id=? "
            "AND time_sort_us <= ? AND time_sort_us >= ? ORDER BY time_sort_us DESC LIMIT 5",
            (dataset, actor, post_us, post_us - NEAR_US),
        )
    ]
    stages["pre_post_receipt"] = _stage(
        "present" if receipts else "missing",
        support_kind="recorded",
        event_ids=[item["event_id"] for item in receipts],
        first_us=receipts[0]["time_us"] if receipts else None,
        note="" if receipts else "发布前 60 秒内没有同一执行者的回执事件",
    )

    stages["posted"] = _stage(
        "present",
        support_kind="recorded",
        event_ids=[post_event_id],
        first_us=post_us,
        actor_labels=[post["actor_label"] or actor or "—"],
    )

    cleanup_instruction = _events_on_file(
        conn,
        dataset,
        instruction_id,
        ("delete_file",),
        start_us=post_us,
        end_us=post_us + NEAR_US,
        limit=10,
    )
    stages["cleanup_instruction"] = _stage(
        "present" if cleanup_instruction else "missing",
        support_kind="recorded",
        link_basis="name_prefix",
        event_ids=[item["event_id"] for item in cleanup_instruction],
        first_us=cleanup_instruction[0]["time_us"] if cleanup_instruction else None,
        note="" if cleanup_instruction else "发布后 60 秒内没有删除该指令文件",
    )

    cleanup_content = _events_on_file(
        conn,
        dataset,
        content_file_id,
        ("delete_file",),
        start_us=post_us,
        end_us=post_us + NEAR_US,
        limit=10,
    )
    stages["cleanup_content"] = _stage(
        "present" if cleanup_content else "missing",
        support_kind="recorded",
        event_ids=[item["event_id"] for item in cleanup_content],
        first_us=cleanup_content[0]["time_us"] if cleanup_content else None,
        note="" if cleanup_content else "发布后 60 秒内没有删除内容文件",
    )

    present = [key for key, _ in STAGES if stages[key]["status"] == "present"]
    missing = [key for key, _ in STAGES if stages[key]["status"] != "present"]
    actors: set[str] = set()
    for item in (*created, *reads, *relays_near, *relays_sample, *cleanup_instruction, *cleanup_content):
        if item.get("actor_id"):
            actors.add(item["actor_id"])
    if actor:
        actors.add(actor)
    start_us = min(
        [stages[key]["first_us"] for key, _ in STAGES if stages[key].get("first_us")] or [post_us]
    )
    end_us = max(
        [stages[key]["first_us"] for key, _ in STAGES if stages[key].get("first_us")] or [post_us]
    )

    return {
        "post_event_id": post_event_id,
        "post_time_us": post_us,
        "post_actor_id": actor,
        "post_actor_label": post["actor_label"],
        "content_file": (
            {
                "file_id": content["entity_id"],
                "path": content["source_value"],
                "content_status": mc2_files.content_status(conn, dataset, content["entity_id"])[
                    "content_status"
                ],
            }
            if content
            else None
        ),
        "instruction_file": (
            {"file_id": instruction["entity_id"], "path": instruction["source_value"]}
            if instruction
            else None
        ),
        "link_basis": "name_prefix" if instruction_id else None,
        "stages": [
            {"stage": key, "label": label, **stages[key]} for key, label in STAGES
        ],
        "matched_stages": len(present),
        "missing_stages": missing,
        "stage_total": len(STAGES),
        "actor_count": len(actors),
        "window_us": {"start_us": start_us, "end_us": end_us},
        "duration_us": max(0, end_us - start_us),
    }


def file_posts(conn, dataset: str, before_us: int | None = None, limit: int = 20) -> dict:
    """所有以文件为内容源的发布事件，按“匹配阶段数 → 缺失阶段数 → 时间”排序。"""
    params: list[Any] = [dataset]
    clause = ""
    if before_us is not None:
        clause = "AND e.time_sort_us < ?"
        params.append(before_us)
    rows = conn.execute(
        "SELECT DISTINCT r.event_id, e.time_sort_us FROM relations r JOIN events e "
        "  ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
        "WHERE r.dataset_id=? AND r.relation=? " + clause + " ORDER BY e.time_sort_us DESC",
        [*params[:1], POST_RELATION, *params[1:]],
    ).fetchall()
    items = [signature(conn, dataset, row["event_id"]) for row in rows[:limit]]
    items.sort(key=lambda item: (-item["matched_stages"], len(item["missing_stages"]), -item["post_time_us"]))
    return {
        "items": items,
        "total": len(rows),
        "stage_dictionary": [{"stage": key, "label": label} for key, label in STAGES],
        "ordering": "matched_stages 降序 → missing_stages 升序 → 发布时间降序",
        "link_basis_note": (
            "内容文件与指令文件的对应关系来自文件名前缀（name_hint），"
            "日志没有记录两者的传播关系；阶段是否存在仍由事件本身决定。"
        ),
    }


def intervention(conn, dataset: str, position: str = "relay_queue") -> dict:
    """单点干预论证：覆盖、附带影响、可切断性、局限。"""
    chains = file_posts(conn, dataset)["items"]
    if position != "relay_queue":
        raise ValueError(f"未知干预位置 {position}")

    coverage = []
    relay_ids: list[str] = []
    for chain in chains:
        stage = next(item for item in chain["stages"] if item["stage"] == "relay_queued")
        relay_ids.extend(stage.get("sample_event_ids", []))
        if stage.get("nearest_event_id"):
            relay_ids.append(stage["nearest_event_id"])
        coverage.append(
            {
                "post_event_id": chain["post_event_id"],
                "content_file": chain["content_file"]["path"] if chain["content_file"] else None,
                "present": stage["status"] == "present",
                "nearest_event_id": stage.get("nearest_event_id"),
                "nearest_actor": stage.get("nearest_actor"),
                "nearest_lag_us": stage.get("nearest_lag_us"),
                "relay_total": stage.get("total", 0),
                "partial_chain": bool(chain["missing_stages"]),
                "missing_stages": chain["missing_stages"],
            }
        )

    covered = sum(1 for item in coverage if item["present"])
    instruction_ids = [chain["instruction_file"]["file_id"] for chain in chains if chain["instruction_file"]]

    placeholders = ",".join("?" * len(instruction_ids)) if instruction_ids else "''"
    with_path = conn.execute(
        "SELECT COUNT(DISTINCT e.event_id) AS total FROM relations r JOIN events e "
        "  ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
        "WHERE r.dataset_id=? AND r.relation='queued_file_path'",
        (dataset,),
    ).fetchone()["total"]
    on_target_files = conn.execute(
        "SELECT COUNT(DISTINCT e.event_id) AS total FROM relations r JOIN events e "
        "  ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
        "WHERE r.dataset_id=? AND r.relation='queued_file_path' "
        "AND r.dst_id IN (" + placeholders + ")",
        (dataset, *instruction_ids),
    ).fetchone()["total"]
    queue_total = conn.execute(
        "SELECT COUNT(*) AS total FROM events WHERE dataset_id=? AND event_type='queue_subordinate_task'",
        (dataset,),
    ).fetchone()["total"]
    senders = conn.execute(
        "SELECT COUNT(DISTINCT e.actor_id) AS total FROM relations r JOIN events e "
        "  ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
        "WHERE r.dataset_id=? AND r.relation='queued_file_path' AND e.actor_id IS NOT NULL "
        "AND r.dst_id IN (" + placeholders + ")",
        (dataset, *instruction_ids),
    ).fetchone()["total"]
    samples = [
        {
            "event_id": row["event_id"],
            "time_us": row["time_sort_us"],
            "actor_label": row["actor_label"],
            "path": row["path"],
        }
        for row in conn.execute(
            "SELECT DISTINCT e.event_id, e.time_sort_us, en.label AS actor_label, "
            "       json_extract(e.details_json, '$.args.path') AS path "
            "FROM relations r JOIN events e "
            "  ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
            "LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
            "WHERE r.dataset_id=? AND r.relation='queued_file_path' "
            "AND r.dst_id IN (" + placeholders + ") "
            "ORDER BY e.time_sort_us DESC LIMIT 5",
            (dataset, *instruction_ids),
        )
    ]

    # 记录层没有“转交 → 发布”的父边，只有同执行者 + 时间相邻，因此不能做切断证明
    explicit_edges = conn.execute(
        "SELECT COUNT(*) AS total FROM relations WHERE dataset_id=? AND relation='parent_event'",
        (dataset,),
    ).fetchone()["total"]

    return {
        "position": position,
        "label": "在 queue_subordinate_task 转交指令文件时校验来源",
        "predicate": {
            "event_type": "queue_subordinate_task",
            "fields": ["details.args.path", "details.target_agent"],
            "condition": "转交的文件以 _further_instructions.md 结尾，且接收方是发布/外发角色的 agent",
            "checkable_from_log": True,
        },
        "coverage": coverage,
        "coverage_summary": {
            "covered": covered,
            "denominator": len(coverage),
            "partial_chains": sum(1 for item in coverage if item["partial_chain"]),
        },
        "evidence_event_ids": sorted(set(relay_ids))[:20],
        "impact": {
            "queue_events_total": int(queue_total),
            "queue_events_with_file_path": int(with_path),
            "events_on_target_files": int(on_target_files),
            "events_on_other_files": int(with_path) - int(on_target_files),
            "distinct_senders": int(senders),
            "samples": samples,
            "note": (
                "条件要求显式 queued_file_path；没有该字段的排队任务不受影响。"
                "样本只用于说明影响范围，不计算未经验证的误报率。"
            ),
        },
        "cut_analysis": {
            "deterministic_path_exists": bool(explicit_edges),
            "explicit_parent_edges": int(explicit_edges),
            "statement": (
                "记录层没有从转交事件指向发布事件的显式边，两者仅表现为同执行者、相隔 1–2 秒。"
                "因此不能证明“切断该位置即可阻断确定路径”，只能说明该阶段在三条链中均出现于发布之前。"
            ),
        },
        "limitations": [
            "内容文件与指令文件的对应关系来自文件名前缀，不是记录关系",
            "缺少正文，无法判断转交内容本身是否异常",
            "三条链中有一条缺少内容文件创建事件，覆盖分母按“完整/部分链”分别统计",
            "若真实系统允许绕过 queue_subordinate_task 的直接发布路径，本干预不覆盖",
        ],
        "extra_info_needed": [
            "队列任务的来源校验字段（签名或权限）",
            "发布动作与队列任务的显式关联 ID",
            "文件正文或哈希，用于判断内容是否被篡改",
        ],
    }
