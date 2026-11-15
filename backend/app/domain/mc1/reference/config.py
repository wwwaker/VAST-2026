MERGER_KEYWORDS = [
    "merger",
    "civicloom",
    "elenamarquez",  # CEO of CivicLoom
    "harborcrest",   # project name
    "embargo",
]

TEXT_SOURCE_OPTIONS = ["content", "reacting", "rationalizing", "deliberating"]

AGENT_LABELS = {
    "legal_agent": "法务 Agent",
    "quality_agent": "平台信任 Agent",
    "social_media_agent": "社媒经理 Agent",
    "judge_agent": "合规监察 Agent",
    "pr_agent": "公关 Agent",
    "pr_intern_agent": "公关实习生 Agent",
    "intern_agent": "实习生 Agent",
}

CHANNEL_LABELS = {
    "comms_huddle": "内部通讯频道",
    "one_on_one_chat": "一对一私聊",
    "side_huddle": "私下小群",
    "personal_post": "个人动态",
    "official_post": "官方动态",
    "anonymous_post": "匿名动态",
}

RECIPIENT_ROLE_TO_AGENT = {
    "legal": "legal_agent",
    "pr": "pr_agent",
    "platform_trust": "quality_agent",
    "social_manager": "social_media_agent",
    "pr_intern": "pr_intern_agent",
    "intern": "intern_agent",
    "judge": "judge_agent",
}

def _vocative_pattern(*aliases: str) -> str:
    alt = "|".join(aliases)
    return rf"(?is)^\s*@?(?:{alt})\s*(?:—|–|::?|,|-{{1,2}})\s.*"

AGENT_VOCATIVE_PATTERNS = {
    "legal_agent": _vocative_pattern("legal"),
    "pr_agent": _vocative_pattern("pr"),
    "quality_agent": _vocative_pattern("platform_trust", "platform-trust", "platform trust"),
    "social_media_agent": _vocative_pattern("social_manager", "social-manager", "social manager"),
    "pr_intern_agent": _vocative_pattern("pr_intern", "pr-intern"),
    "intern_agent": _vocative_pattern("intern"),
    "judge_agent": _vocative_pattern("judge"),
}

SENTIMENT_LABEL_TO_VALUE = {
    "positive": 1.0,
    "recovering": 0.5,
    "optimistic": 0.5,
    "neutral": 0.0,
    "cautious": -0.25,
    "low": -0.4,
    "negative": -0.5,
    "critical": -1.0,
}

CRISIS_KEYWORDS = [
    "embargo", "CivicLoom", "HarborCrest", "SaltWind", "GO", "staged",
    "anonymous", "legal", "NHPI", "Retention Optimizer", "PR-Intern",
    "intern", "side_huddle", "official_post", "personal_post",
]

CHANNEL_WINDOW_MINUTES = 120

NEIGHBOR_COUNT = 3
