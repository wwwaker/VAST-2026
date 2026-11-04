"""数据集 manifest。

所有数据集差异集中在这里，loader 与 API 不写 `if dataset == ...` 的字段推测逻辑。
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Anchor:
    key: str
    label: str
    time_raw: str
    timezone: str
    note: str = ""
    # 演示主线从哪个锚点开始。改这里即可换主线，不需要动前端。
    primary: bool = False


@dataclass(frozen=True)
class DatasetManifest:
    dataset_id: str
    name: str
    question: str
    events_file: str
    entities_file: str
    labels_file: str | None
    entity_container: str | None  # None 表示根即数组
    timezone_status: str  # unknown / utc
    participant_rule: str  # party_ids / mc1_recipients / custom
    anchor_list: list[Anchor] = field(default_factory=list)
    # MC1 专用：收件人短名别名（实测 social_manager 无法由 roles 推导）
    recipient_alias: dict[str, str] = field(default_factory=dict)
    # 唯一干预点的候选位置说明；null 表示该数据集不设。
    intervention: str | None = None


MC1 = DatasetManifest(
    dataset_id="MC1",
    name="MC1 · 危机沟通消息",
    question="2046-06-05 18:00 解禁前，并购消息为何已出现在 FleX？是蓄意泄露还是系统失效？",
    events_file="official_data/MC1/events.jsonl",
    entities_file="official_data/MC1/entities.json",
    labels_file=None,
    entity_container="entities",
    timezone_status="unknown",
    participant_rule="mc1_recipients",
    anchor_list=[
        Anchor(
            key="embargo_lift",
            label="解禁 18:00",
            time_raw="2046-06-05T18:00:00",
            timezone="unknown",
            note="官方口径的信息禁发期结束时刻",
        ),
        Anchor(
            key="first_confirm_post",
            label="首条确认并购的公开发帖",
            time_raw="2046-06-05T17:25:00",
            timezone="unknown",
            note="数据内首条确认 CivicLoom 并购的 public_post，早于解禁 35 分钟",
            # 主锚点选它而不是 17:00：17:00 是第三方 SaltWind 抢先发布，
            # 数据里只能看到"别人发了"；17:25 却是内部 agent 自己发的，可追到决策链。
            primary=True,
        ),
    ],
    recipient_alias={"social_manager": "MC1:agent:social_media_agent"},
)

MC2 = DatasetManifest(
    dataset_id="MC2",
    name="MC2 · 内部系统活动",
    question="2046-05-17 04:21 的乱码帖子如何产生？内容来自哪里，此前是否发生过？",
    events_file="official_data/MC2/events.jsonl",
    entities_file="official_data/MC2/entities.json",
    labels_file=None,
    entity_container="entities",
    timezone_status="utc",
    participant_rule="party_ids",
    anchor_list=[
        Anchor(
            key="target_post",
            label="目标帖子 11:21Z",
            time_raw="2046-05-17T11:21:15Z",
            timezone="utc",
            note="官方描述为 04:21 本地时间，折算 UTC 为 11:21:15Z，避免按 04:21 筛选得到空结果",
        ),
        Anchor(
            key="prior_1",
            label="既往实例 HiddenOrca.txt",
            time_raw="2046-05-10T12:45:42Z",
            timezone="utc",
            note="同为主体内以文件为内容源的帖子",
        ),
        Anchor(
            key="prior_2",
            label="既往实例 MellowOtter.txt",
            time_raw="2046-05-11T00:56:04Z",
            timezone="utc",
        ),
        Anchor(
            key="content_file",
            label="内容文件创建",
            time_raw="2046-05-09T15:02:01Z",
            timezone="utc",
            note="SwiftWren.txt 由 emma_harbor 创建，是目标帖正文的最终来源",
            primary=True,
        ),
    ],
    # 官方要求干预点至多一个。选任务接力环节而不是发帖动作本身：
    # SwiftWren_further_instructions.md 通过 queue_subordinate_task 在多个 agent 之间
    # 接力传递、跨 8 天、191 条相关事件，是"内容被搬运"的唯一入口；
    # 拦住发帖只能挡这一次，拦住接力能挡住整条传播链。
    intervention=(
        "在 queue_subordinate_task 的 queued_file_path 校验处限制"
        " SwiftWren_further_instructions.md 的转交：该文件经 8 天、多 agent 接力传递，"
        "是目标帖正文进入发布路径的唯一入口。"
    ),
)

CUSTOM = DatasetManifest(
    dataset_id="CUSTOM",
    name="自建 · 工作流审计",
    question="32 次工作流运行中，审批绕过与旧版本传播分别在哪些事件上留下证据？",
    events_file="custom_dataset/events.jsonl",
    entities_file="custom_dataset/entities.json",
    labels_file="custom_dataset/labels.json",
    entity_container=None,
    timezone_status="utc",
    participant_rule="custom",
    anchor_list=[],
)

ALL = {m.dataset_id: m for m in (MC1, MC2, CUSTOM)}
