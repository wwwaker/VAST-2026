"""Readable summaries of recorded MC2 fields, without inferred outcomes."""
from __future__ import annotations

import json

ACTIONS = {"read_file": "读取文件", "create_file": "创建文件", "delete_file": "删除文件",
           "list_files": "列出文件", "access_email": "打开邮箱", "check_email": "查收邮件",
           "post_saidit": "向 SaidIt 发帖", "post_flex": "向 FleX 发帖",
           "queue_subordinate_task": "排入下属任务"}


def label(value):
    return str(value).removeprefix("MC2:").replace("Agent/person:", "").replace("agent:person:", "").replace("person:", "").replace("_", " ")


def summary(event_type: str, details_json: str | None) -> str:
    details = json.loads(details_json) if details_json else {}
    details = details if isinstance(details, dict) else {}
    parts = []
    if event_type in ("send_email", "sent", "received"):
        if details.get("from") or details.get("to"):
            parts.append(f"{label(details.get('from', '未记录发件者'))} → {label(details.get('to', '未记录收件者'))}")
        if details.get("subject"):
            parts.append(f"主题：{details['subject']}")
    elif event_type in ("queue_subordinate_task", "assign_agent_task"):
        task = details.get("task")
        nested = details.get("details") if isinstance(details.get("details"), dict) else {}
        target = details.get("target_agent") or details.get("target") or nested.get("person")
        actual = nested.get("task") or task or "未记录任务类型"
        parts.append(f"排入任务：{ACTIONS.get(actual, actual)}" + (f"；目标：{label(target)}" if target else ""))
        args = details.get("args") if isinstance(details.get("args"), dict) else {}
        if args.get("path"):
            parts.append(f"文件：{args['path']}")
    elif event_type in ("read_file", "create_file", "delete_file", "list_files"):
        parts.append(f"{ACTIONS[event_type]}：{details.get('target') or '未记录路径'}")
    elif event_type in ("check_access", "enter_room"):
        parts.append(f"地点：{details.get('room') or details.get('name') or '未记录'}")
        if isinstance(details.get("granted"), bool):
            parts.append("准入检查：允许" if details["granted"] else "准入检查：拒绝")
    for key, title in (("content", "正文"), ("question", "问题"), ("response", "答复"),
                       ("advice", "建议"), ("feedback", "反馈"), ("reason", "原因"),
                       ("topic", "话题"), ("purpose", "目的"), ("content_source", "发布内容来源")):
        value = details.get(key)
        if isinstance(value, str) and value:
            parts.append(value if key == "content" else f"{title}：{value}")
    if event_type == "propose_meeting" and isinstance(details.get("meeting"), dict):
        meeting = details["meeting"]
        parts.append(f"会议时间：{meeting.get('time', '未记录')}；参与者：{'、'.join(label(x) for x in meeting.get('participants', []))}")
    if event_type == "suggest_contacts" and isinstance(details.get("contacts"), list):
        parts.append("建议联系人：" + "、".join(label(x) for x in details["contacts"]))
    if not parts:
        if event_type == "saidit_post_check":
            parts.append("SaidIt 发帖校验记录；日志没有提供校验结果或正文。")
        elif event_type == "check_email":
            parts.append("查收邮件记录；日志没有附带邮件正文。")
        elif details.get("task"):
            task = details["task"]
            parts.append(f"记录任务：{ACTIONS.get(task, task)}")
        else:
            parts.append("日志记录了此次活动，但未提供可阅读的消息正文。")
    text = " · ".join(parts).replace("MC2:", "")
    return text[:360] + ("…" if len(text) > 360 else "")
