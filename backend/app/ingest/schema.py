"""建库 DDL（schema v3）。

v3 相对 v2 的变化：
- events 增加 reply_class / reply_target_event_id：MC1 的 responding_to 在入库时分类为
  reply_valid / reply_future_reference / mention / unresolved_reference / empty_reference，
  原始 details_json 保持不变，未来引用不得进入历史传播主链。
- 新增 transition_pairs：经 manifest 哈希核验的 MC2 相邻操作对，供转移矩阵查询；
  lag_us 为整数微秒，查询按 5/30 分钟两个子集过滤。
- datasets 增加 data_version（源事件文件 SHA-256）与 schema_version。
- time_sort_key 继续保存“整数秒”，只服务 time_buckets 等旧聚合，新查询一律走 time_sort_us。
"""

import re

SCHEMA_VERSION = 3

TABLES = """
CREATE TABLE datasets (
    dataset_id       TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    question         TEXT NOT NULL,
    timezone_status  TEXT NOT NULL,
    event_count      INTEGER NOT NULL,
    entity_count     INTEGER NOT NULL,
    ts_min           TEXT,
    ts_max           TEXT,
    -- 含内部审议文本的事件数：MC1 的双声道覆盖率只有 9.4%，界面必须能提示这一点
    deliberation_count INTEGER NOT NULL DEFAULT 0,
    import_version   TEXT NOT NULL,
    data_version     TEXT NOT NULL DEFAULT '',
    schema_version   INTEGER NOT NULL DEFAULT 3,
    imported_at      TEXT NOT NULL
);

CREATE TABLE events (
    dataset_id           TEXT NOT NULL,
    event_id             TEXT NOT NULL,
    source_record_id     TEXT,
    timestamp_raw        TEXT NOT NULL,
    timestamp_normalized TEXT NOT NULL,
    -- 新的唯一排序键：整数微秒，半开窗口 [start_us, end_us)
    time_sort_us         INTEGER NOT NULL,
    -- 旧键保留为整数秒，只用于 time_buckets 等按天/小时聚合
    time_sort_key        INTEGER NOT NULL,
    timezone_status      TEXT NOT NULL,
    actor_id             TEXT,
    actor_rule           TEXT,
    event_type           TEXT NOT NULL,
    task_id              TEXT,
    run_id               TEXT,
    document_id          TEXT,
    target_id            TEXT,
    version              INTEGER,
    channel_id           TEXT,
    parent_event_id      TEXT,
    details_json         TEXT,
    source_file          TEXT,
    source_ordinal       INTEGER,
    source_json_pointer  TEXT,
    source_missing_id    INTEGER NOT NULL DEFAULT 0,
    has_deliberation     INTEGER NOT NULL DEFAULT 0,
    -- MC1 回复引用分类（仅 MC1 填充）；原始 details_json.responding_to 不做改写
    reply_class          TEXT,
    reply_target_event_id TEXT,
    PRIMARY KEY (dataset_id, event_id)
);

CREATE TABLE event_raw (
    dataset_id TEXT NOT NULL,
    event_id   TEXT NOT NULL,
    raw_json   TEXT,
    PRIMARY KEY (dataset_id, event_id)
);

CREATE TABLE entities (
    dataset_id   TEXT NOT NULL,
    entity_id    TEXT NOT NULL,
    entity_type  TEXT,
    source_value TEXT,
    label        TEXT,
    roles_json   TEXT,
    attrs_json   TEXT,
    PRIMARY KEY (dataset_id, entity_id)
);

CREATE TABLE participants (
    dataset_id    TEXT NOT NULL,
    event_id      TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    role          TEXT NOT NULL,
    derivation    TEXT NOT NULL,
    time_sort_key INTEGER NOT NULL,
    time_sort_us  INTEGER NOT NULL
);

CREATE TABLE relations (
    dataset_id TEXT NOT NULL,
    event_id   TEXT,
    src_id     TEXT,
    dst_id     TEXT NOT NULL,
    relation   TEXT NOT NULL,
    derivation TEXT NOT NULL,
    -- entity = 指向实体（可进关系图）；event = 指向另一条事件（reply_to，只能进时间线）
    target_kind TEXT NOT NULL DEFAULT 'entity'
);

CREATE TABLE annotations (
    annotation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id    TEXT NOT NULL,
    run_id        TEXT,
    scenario      TEXT,
    anomaly_type  TEXT,
    observed      INTEGER NOT NULL,
    reason        TEXT
);

CREATE TABLE annotation_events (
    annotation_id INTEGER NOT NULL,
    dataset_id    TEXT NOT NULL,
    event_id      TEXT NOT NULL
);

CREATE TABLE time_buckets (
    dataset_id  TEXT NOT NULL,
    granularity TEXT NOT NULL,
    bucket_key  INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    PRIMARY KEY (dataset_id, granularity, bucket_key, event_type)
);

CREATE TABLE stat_counts (
    dataset_id TEXT NOT NULL,
    kind       TEXT NOT NULL,
    key        TEXT NOT NULL,
    cnt        INTEGER NOT NULL,
    PRIMARY KEY (dataset_id, kind, key)
);

CREATE TABLE event_fts (
    event_id UNINDEXED,
    dataset_id UNINDEXED,
    body     TEXT
);

-- 派生数据版本：记录 manifest 哈希与可用状态，避免“事件没变、派生文件变了”时沿用旧结论
CREATE TABLE artifact_sources (
    artifact_id   TEXT PRIMARY KEY,
    dataset_id    TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    method_version TEXT NOT NULL,
    status        TEXT NOT NULL,
    verified_at   TEXT NOT NULL
);

-- 自建数据的运行维度：主题、模型、fixture、场景与观测结果
CREATE TABLE runs (
    dataset_id   TEXT NOT NULL,
    run_id       TEXT NOT NULL,
    model        TEXT,
    fixture      TEXT,
    scenario     TEXT,
    observed     INTEGER NOT NULL DEFAULT 0,
    anomaly_type TEXT,
    start_us     INTEGER,
    end_us       INTEGER,
    event_count  INTEGER NOT NULL,
    metrics_json TEXT,
    artifact_id  TEXT,
    PRIMARY KEY (dataset_id, run_id)
);

CREATE TABLE run_pairs (
    dataset_id    TEXT NOT NULL,
    run_id        TEXT NOT NULL,
    normal_run_id TEXT NOT NULL,
    model         TEXT,
    fixture       TEXT,
    artifact_id   TEXT,
    PRIMARY KEY (dataset_id, run_id, normal_run_id)
);

-- 明确记录的父子/回复关系；不包含推测关联
CREATE TABLE event_links (
    dataset_id      TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    target_event_id TEXT NOT NULL,
    relation        TEXT NOT NULL,
    derivation      TEXT NOT NULL,
    artifact_id     TEXT,
    PRIMARY KEY (dataset_id, source_event_id, target_event_id, relation, derivation)
);

-- MC2 相邻操作对（manifest 哈希核验后导入）。同执行者的时间相邻不等于因果。
CREATE TABLE transition_pairs (
    dataset_id      TEXT NOT NULL,
    actor_id        TEXT,
    source_event_id TEXT NOT NULL,
    next_event_id   TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    next_type       TEXT NOT NULL,
    lag_us          INTEGER NOT NULL,
    artifact_id     TEXT,
    PRIMARY KEY (dataset_id, source_event_id, next_event_id)
);
"""

INDEXES = """
CREATE INDEX IF NOT EXISTS idx_events_time_us   ON events(dataset_id, time_sort_us, event_id);
CREATE INDEX IF NOT EXISTS idx_events_actor_us  ON events(dataset_id, actor_id, time_sort_us, event_id);
CREATE INDEX IF NOT EXISTS idx_events_type_us   ON events(dataset_id, event_type, time_sort_us, event_id);
CREATE INDEX IF NOT EXISTS idx_events_run_us    ON events(dataset_id, run_id, time_sort_us, event_id);
CREATE INDEX IF NOT EXISTS idx_events_time      ON events(dataset_id, time_sort_key, event_id);
CREATE INDEX IF NOT EXISTS idx_events_actor     ON events(dataset_id, actor_id, time_sort_key);
CREATE INDEX IF NOT EXISTS idx_events_type      ON events(dataset_id, event_type, time_sort_key);
CREATE INDEX IF NOT EXISTS idx_events_run       ON events(dataset_id, task_id, time_sort_key);
CREATE INDEX IF NOT EXISTS idx_part_entity      ON participants(dataset_id, entity_id, time_sort_key);
CREATE INDEX IF NOT EXISTS idx_part_entity_us   ON participants(dataset_id, entity_id, time_sort_us);
CREATE INDEX IF NOT EXISTS idx_part_event       ON participants(dataset_id, event_id);
CREATE INDEX IF NOT EXISTS idx_part_event_entity ON participants(dataset_id, event_id, entity_id);
-- 按实体统计去重事件数；缺它时每条 participants 都要回表（实测 875 ms）
CREATE INDEX IF NOT EXISTS idx_part_entity_event ON participants(dataset_id, entity_id, event_id);
CREATE INDEX IF NOT EXISTS idx_rel_src          ON relations(dataset_id, src_id);
CREATE INDEX IF NOT EXISTS idx_rel_dst          ON relations(dataset_id, dst_id);
-- 事件详情按事件取关系边，缺索引会退化为全表扫描（实测 1.1s）
CREATE INDEX IF NOT EXISTS idx_rel_event        ON relations(dataset_id, event_id);
-- 按关系类型筛选文件轨迹/来源链；缺索引时每次全扫 relations（实测 40–60 ms/次）
CREATE INDEX IF NOT EXISTS idx_rel_relation     ON relations(dataset_id, relation);
-- 允许用 source_record_id 反查事件（MC1 的 responding_to 就指向它）
CREATE INDEX IF NOT EXISTS idx_events_srcid     ON events(dataset_id, source_record_id);
CREATE INDEX IF NOT EXISTS idx_events_file      ON events(dataset_id, source_file);
CREATE INDEX IF NOT EXISTS idx_anno_event       ON annotation_events(dataset_id, event_id);
CREATE INDEX IF NOT EXISTS idx_links_target     ON event_links(dataset_id, target_event_id);
CREATE INDEX IF NOT EXISTS idx_runs_scenario    ON runs(dataset_id, scenario, model, fixture);
-- 转移矩阵主索引：先按类型对与时间上限裁剪，再统计 actor
CREATE INDEX IF NOT EXISTS idx_transition_matrix ON transition_pairs(dataset_id, source_type, next_type, lag_us, actor_id);
-- MC1 回复分类审计
CREATE INDEX IF NOT EXISTS idx_events_reply_class ON events(dataset_id, reply_class);
CREATE INDEX IF NOT EXISTS idx_fts_dataset      ON event_fts(dataset_id);
CREATE INDEX IF NOT EXISTS idx_bucket           ON time_buckets(dataset_id, granularity, bucket_key);
CREATE VIRTUAL TABLE IF NOT EXISTS event_fts_idx USING fts5(
    body, content='event_fts', content_rowid='rowid', tokenize='unicode61'
);
"""

POST = """
INSERT INTO event_fts_idx(event_fts_idx) VALUES('rebuild');
PRAGMA user_version=3;
ANALYZE;
"""

_TABLE_RE = re.compile(r"CREATE TABLE\s+(\w+)", re.IGNORECASE)


def required_tables() -> set[str]:
    """TABLES 里声明的表名。

    只比对 user_version 不足以发现“版本号已写成 2、但缺 runs 等新表”的半成品库：
    这种库会让 /api/health 显示正常，而 /api/runs 直接 500。启动时用本函数比对。
    """
    return {match.group(1) for match in _TABLE_RE.finditer(TABLES)}
