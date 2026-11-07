"""案例导出：JSON（可恢复）与 Markdown（可阅读）。

原则：每条主张都要带事件或背景引用；引用解析不到时写进“未解析”而不是悄悄丢掉；
正文进入表格前做转义，避免后续转 HTML 时执行日志里的标签。
"""

from __future__ import annotations

from . import ui_snapshot

import html
import json
from datetime import datetime, timezone

from .. import case_store
from . import cases as case_domain

STATUS_TEXT = {
    "hypothesis": "假设",
    "supported": "有证据支持",
    "inconclusive": "证据不足",
}
ROLE_TEXT = {"support": "支持", "counter": "反证", "uncertain": "待核实"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _resolve_reference(conn, dataset_id: str, reference_id: str, reference_kind: str) -> dict | None:
    if reference_kind != "event":
        return None
    row = conn.execute(
        "SELECT event_id, event_type, time_sort_us, actor_id, timestamp_raw, details_json, "
        "       source_file, source_ordinal, source_json_pointer "
        "FROM events WHERE dataset_id=? AND event_id=?",
        (dataset_id, reference_id),
    ).fetchone()
    if row is None:
        return None
    current = case_store.evidence_hash(
        dataset_id, row["event_id"], row["timestamp_raw"], row["details_json"]
    )
    return {
        "event_id": row["event_id"],
        "event_type": row["event_type"],
        "time_us": row["time_sort_us"],
        "actor_id": row["actor_id"],
        "source_file": row["source_file"],
        "source_ordinal": row["source_ordinal"],
        "source_json_pointer": row["source_json_pointer"],
        "current_hash": current,
    }


def build(conn, case_id: str, data_version: str) -> dict:
    """解析案例（预置或用户保存）+ 结论 + 证据是否仍可解析。"""
    user_case = case_store.get_case(case_id)
    preset = None
    if user_case is None:
        try:
            preset = case_domain.get_case(conn, case_id, data_version)
        except KeyError:
            raise KeyError(case_id)

    dataset_id = user_case["dataset_id"] if user_case else "CUSTOM"
    case_version = user_case["data_version"] if user_case else case_domain.load_presets().get("data_version")
    stale = bool(case_version and data_version and case_version != data_version)

    findings = case_store.list_findings(case_id)
    unresolved: list[dict] = []
    enriched = []
    for finding in findings:
        items = []
        for evidence in finding["evidence"]:
            resolved = _resolve_reference(
                conn, evidence["dataset_id"], evidence["reference_id"], evidence["reference_kind"]
            )
            if resolved is None:
                unresolved.append(
                    {
                        "finding_id": finding["finding_id"],
                        "role": evidence["role"],
                        "reference_kind": evidence["reference_kind"],
                        "reference_id": evidence["reference_id"],
                    }
                )
                items.append({**evidence, "resolved": None, "changed": False})
                continue
            changed = resolved["current_hash"] != evidence["source_hash"]
            if changed:
                unresolved.append(
                    {
                        "finding_id": finding["finding_id"],
                        "role": evidence["role"],
                        "reference_kind": evidence["reference_kind"],
                        "reference_id": evidence["reference_id"],
                        "reason": "内容哈希与保存时不一致",
                    }
                )
            items.append({**evidence, "resolved": resolved, "changed": changed})
        enriched.append({**finding, "evidence": items})

    return {
        "case_id": case_id,
        "kind": "user" if user_case else "preset",
        "title": user_case["title"] if user_case else preset["title"],
        "dataset_id": dataset_id,
        "data_version": data_version,
        "case_data_version": case_version,
        "stale": stale,
        "generated_at": _now(),
        "snapshot": user_case["snapshot"] if user_case else None,
        "snapshot_status": ui_snapshot.describe(user_case["snapshot"], dataset_id, conn) if user_case else None,
        "preset": preset,
        "findings": enriched,
        "unresolved": unresolved,
        "summary": {
            "claim_count": len(enriched),
            "support": sum(1 for f in enriched for e in f["evidence"] if e["role"] == "support"),
            "counter": sum(1 for f in enriched for e in f["evidence"] if e["role"] == "counter"),
            "uncertain": sum(1 for f in enriched for e in f["evidence"] if e["role"] == "uncertain"),
        },
        "note": "导出的结论只引用当前版本核验过的证据；未解析项单独列出，不补全。",
    }


def _md(text: str | None) -> str:
    """表格单元格：转义后再压平换行，避免 | 与 HTML 标签破坏结构。"""
    if not text:
        return "—"
    return html.escape(str(text)).replace("|", "\\|").replace("\n", " ").strip()


def render_markdown(payload: dict) -> str:
    lines: list[str] = []
    lines.append(f"# 调查案例：{_md(payload['title'])}")
    lines.append("")
    lines.append(f"- 案例 ID：`{payload['case_id']}`（{'用户保存' if payload['kind'] == 'user' else '预置'}）")
    lines.append(f"- 数据集：{payload['dataset_id']} · 数据版本：`{payload['data_version']}`")
    lines.append(f"- 导出时间：{payload['generated_at']}")
    if payload["stale"]:
        lines.append("- ⚠️ 案例保存时的数据版本与当前主库不同，结论需要重新核验。")
    lines.append("")

    original_snapshot = payload.get("snapshot")
    snapshot = original_snapshot if isinstance(original_snapshot, dict) else {}
    if snapshot:
        lines.append("## 恢复状态")
        filters = snapshot.get("base_filters", snapshot.get("filters"))
        filters = filters if isinstance(filters, dict) else {}
        applied = {k: v for k, v in filters.items() if v not in (None, "", [], False)}
        lines.append(f"- 画布/任务：{_md(snapshot.get('task', snapshot.get('canvas_view')))} · {_md(snapshot.get('mode'))}")
        lines.append(f"- UI 快照：{_md(str(snapshot.get('ui_state_version', 'legacy')))}；恢复状态：{_md((payload.get('snapshot_status') or {}).get('status'))}")
        lines.append(f"- 筛选：`{_md(json.dumps(applied, ensure_ascii=False))}`")
        for key, label in (
            ("selected_event_id", "选中事件"),
            ("focused_entity_id", "聚焦实体"),
            ("selected_run_id", "运行"),
            ("trace_root_id", "来源链根"),
        ):
            if snapshot.get(key):
                lines.append(f"- {label}：`{snapshot[key]}`")
        pair = snapshot.get("run_pair")
        if isinstance(pair, list) and len(pair) == 2 and all(isinstance(item, str) for item in pair):
            lines.append(f"- 运行对照：`{pair[0]}` ↔ `{pair[1]}`")
        lines.append("")
        # Preserve all new/legacy/future fields in Markdown as well as JSON export.
        lines.append("<details><summary>完整调查快照（原样保留）</summary>\n")
        lines.append("```json\n" + json.dumps(snapshot, ensure_ascii=False, indent=2).replace("<", "\\u003c").replace(">", "\\u003e").replace("`", "\\u0060") + "\n```")
        lines.append("\n</details>\n")

    preset = payload.get("preset")
    if preset:
        lines.append("## 冻结案例")
        lines.append(f"- 运行：`{preset['run_id']}`")
        if preset.get("baseline_run_id"):
            lines.append(f"- 正常对照：`{preset['baseline_run_id']}`")
        lines.append(f"- 状态：{preset['status_label']}")
        if preset.get("audit"):
            audit = ", ".join(f"{k}={v}" for k, v in preset["audit"].items())
            lines.append(f"- 重算摘要：{_md(audit)}")
        if preset.get("note"):
            lines.append(f"- 说明：{_md(preset['note'])}")
        lines.append("")

    lines.append("## 结论")
    if not payload["findings"]:
        lines.append("_尚未记录结构化结论。_")
    for index, finding in enumerate(payload["findings"], start=1):
        lines.append("")
        lines.append(f"### {index}. {_md(finding['claim'])}")
        lines.append(
            f"- 状态：{STATUS_TEXT.get(finding['status'], finding['status'])}"
        )
        lines.append(f"- 解释：{_md(finding['explanation'])}")
        if finding.get("limitations"):
            lines.append(f"- 局限：{_md(finding['limitations'])}")
        if finding["evidence"]:
            lines.append("")
            lines.append("| 角色 | 引用 | 类型 | 时间(µs) | 来源 | 引用哈希 | 现状 |")
            lines.append("| --- | --- | --- | ---: | --- | --- | --- |")
            for evidence in finding["evidence"]:
                resolved = evidence.get("resolved")
                state = "已重新解析" if resolved and not evidence.get("changed") else (
                    "哈希已变" if evidence.get("changed") else "未解析"
                )
                lines.append(
                    "| {role} | `{ref}` | {type} | {time} | {source} | `{hash}` | {state} |".format(
                        role=ROLE_TEXT.get(evidence["role"], evidence["role"]),
                        ref=_md(evidence["reference_id"]),
                        type=_md(resolved["event_type"] if resolved else "—"),
                        time=resolved["time_us"] if resolved else "—",
                        source=_md(resolved["source_json_pointer"] if resolved else "—"),
                        hash=_md((evidence.get("source_hash") or "")[:12]),
                        state=state,
                    )
                )
            counter = [e for e in finding["evidence"] if e["role"] == "counter"]
            lines.append("")
            lines.append(f"- 反证：{'有' if counter else '无记录'}")
        else:
            lines.append("- 证据：尚无证据")

    lines.append("")
    lines.append("## 未解析与待办")
    if payload["unresolved"]:
        for item in payload["unresolved"]:
            reason = item.get("reason", "引用在当前主库中不存在")
            lines.append(f"- `{item['reference_id']}`（{ROLE_TEXT.get(item['role'], item['role'])}）：{_md(reason)}")
    else:
        lines.append("- 无")
    lines.append("")
    lines.append("## 方法与限制")
    lines.append(f"- {_md(payload['note'])}")
    lines.append("- 事件数按去重事件计；候选关联与记录关系分开标注，不把候选当已证实因果。")
    lines.append("")
    return "\n".join(lines)
