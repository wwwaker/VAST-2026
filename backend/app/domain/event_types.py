"""事件类型字典（服务端唯一语义来源）。

前端只保留类别颜色，不再维护 TYPE_MAP；类别 id 与 frontend/src/theme/categories.ts 的
顺序一一对应（1..8），但“某个类型属于哪一类”只能由这里决定。

is_action / is_receipt 用于避免把动作与平台回执相加后当成“发布次数”：
- post_saidit 是 agent 的发帖动作；
- saidit_post 是平台记录；
- saidit_post_check 是平台校验记录。
三者都归“公开发布”类别，但计数含义不同。
"""

from __future__ import annotations

from dataclasses import dataclass

CATEGORIES: list[dict] = [
    {"id": 1, "key": "comm", "label": "内部沟通"},
    {"id": 2, "key": "post", "label": "公开发布"},
    {"id": 3, "key": "mail", "label": "邮件"},
    {"id": 4, "key": "file", "label": "文件操作"},
    {"id": 5, "key": "task", "label": "任务流转"},
    {"id": 6, "key": "presence", "label": "场所与协作"},
    {"id": 7, "key": "system", "label": "系统与流程"},
    {"id": 8, "key": "other", "label": "其他"},
]

OTHER_CATEGORY = 8


@dataclass(frozen=True)
class TypeDef:
    category: int
    is_action: bool
    is_receipt: bool
    display_label: str


MC1_TYPES: dict[str, TypeDef] = {
    "broadcast": TypeDef(1, True, False, "频道广播"),
    "one_on_one_chat": TypeDef(1, True, False, "一对一沟通"),
    "side_huddle": TypeDef(1, True, False, "私下交谈"),
    "action": TypeDef(1, True, False, "行动"),
    "public_post": TypeDef(2, True, False, "公开发帖"),
}

MC2_TYPES: dict[str, TypeDef] = {
    # 邮件
    "check_email": TypeDef(3, True, False, "查收邮件"),
    "access_email": TypeDef(3, True, False, "打开邮箱"),
    "send_email": TypeDef(3, True, False, "发送邮件"),
    "sent": TypeDef(3, False, True, "邮件已发送记录"),
    "received": TypeDef(3, False, True, "邮件已接收记录"),
    # 文件
    "read_file": TypeDef(4, True, False, "读取文件"),
    "create_file": TypeDef(4, True, False, "创建文件"),
    "delete_file": TypeDef(4, True, False, "删除文件"),
    "access_files": TypeDef(4, True, False, "访问文件系统"),
    "list_files": TypeDef(4, True, False, "列出文件"),
    # 任务
    "assign_agent_task": TypeDef(5, True, False, "派发 agent 任务"),
    "queue_subordinate_task": TypeDef(5, True, False, "向 subordinate 排队任务"),
    # 沟通
    "give_advice": TypeDef(1, True, False, "给出建议"),
    "ask_agent": TypeDef(1, True, False, "询问 agent"),
    # 场所与协作
    "check_in": TypeDef(6, True, False, "签到"),
    "check_access": TypeDef(6, True, False, "门禁检查"),
    "enter_room": TypeDef(6, True, False, "进入房间"),
    "propose_meeting": TypeDef(6, True, False, "提议会议"),
    "suggest_contacts": TypeDef(6, True, False, "推荐联系人"),
    # 公开发布：动作与回执分开
    "post_saidit": TypeDef(2, True, False, "向 SaidIT 发帖"),
    "saidit_post": TypeDef(2, False, True, "SaidIT 帖子记录"),
    "post_flex": TypeDef(2, True, False, "向 FleX 发帖"),
    "flex_post": TypeDef(2, False, True, "FleX 帖子记录"),
    "saidit_post_check": TypeDef(2, False, True, "SaidIT 发帖校验"),
}

CUSTOM_TYPES: dict[str, TypeDef] = {
    "run_started": TypeDef(7, False, True, "运行开始"),
    "run_finished": TypeDef(7, False, True, "运行结束"),
    "agent_call_started": TypeDef(7, False, True, "模型调用开始"),
    "agent_call_finished": TypeDef(7, False, True, "模型调用结束"),
    "agent_message": TypeDef(1, True, False, "agent 消息"),
    "task_created": TypeDef(5, True, False, "任务创建"),
    "task_handoff": TypeDef(5, True, False, "任务交接"),
    "workflow_route": TypeDef(5, True, False, "流程路由"),
    "file_read": TypeDef(4, True, False, "读取文件"),
    "file_write": TypeDef(4, True, False, "写入文件"),
    "version_updated": TypeDef(7, True, False, "版本更新"),
    "submit_review": TypeDef(7, True, False, "提交审核"),
    "review_decision": TypeDef(7, True, False, "审核决定"),
    "publish_attempt": TypeDef(7, True, False, "发布尝试"),
    "publish_result": TypeDef(7, False, True, "发布结果"),
}

TYPES: dict[str, dict[str, TypeDef]] = {
    "MC1": MC1_TYPES,
    "MC2": MC2_TYPES,
    "CUSTOM": CUSTOM_TYPES,
}


def types_for(dataset: str) -> dict[str, TypeDef]:
    return TYPES.get(dataset, {})


def type_def(dataset: str, event_type: str) -> TypeDef | None:
    return types_for(dataset).get(event_type)


def category_of(dataset: str, event_type: str) -> int:
    """未知类型仍可显示为“其他”，但会被计入 unknown_type_count，便于补字典。"""
    definition = type_def(dataset, event_type)
    return definition.category if definition else OTHER_CATEGORY


def types_in_categories(dataset: str, category_ids: list[int]) -> set[str]:
    """把类别 id 解析成该数据集的类型集合；未知类别不贡献类型。"""
    wanted = {int(c) for c in category_ids}
    if not wanted:
        return set(types_for(dataset))
    return {
        name
        for name, definition in types_for(dataset).items()
        if definition.category in wanted
    }


def unknown_types(dataset: str, observed: list[str] | set[str]) -> list[str]:
    known = types_for(dataset)
    return sorted(t for t in set(observed) if t not in known)


def capabilities(dataset: str) -> dict:
    """类型字典的公开形态；计数由调用方从库里补。"""
    return {
        "categories": CATEGORIES,
        "types": [
            {
                "type": name,
                "display_label": definition.display_label,
                "category": definition.category,
                "is_action": definition.is_action,
                "is_receipt": definition.is_receipt,
            }
            for name, definition in types_for(dataset).items()
        ],
    }
