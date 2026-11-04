"""建库 DDL。表结构与《SQLite 基准报告》一致，另外补充了标注与证据字段。"""

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
    imported_at      TEXT NOT NULL
);

CREATE TABLE events (
    dataset_id           TEXT NOT NULL,
    event_id             TEXT NOT NULL,
    source_record_id     TEXT,
    timestamp_raw        TEXT NOT NULL,
    timestamp_normalized TEXT NOT NULL,
    time_sort_key        INTEGER NOT NULL,
    timezone_status      TEXT NOT NULL,
    actor_id             TEXT,
    actor_rule           TEXT,
    event_type           TEXT NOT NULL,
    task_id              TEXT,
    document_id          TEXT,
    parent_event_id      TEXT,
    details_json         TEXT,
    source_json_pointer  TEXT,
    source_missing_id    INTEGER NOT NULL DEFAULT 0,
    has_deliberation     INTEGER NOT NULL DEFAULT 0,
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
    time_sort_key INTEGER NOT NULL
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
"""

INDEXES = """
CREATE INDEX IF NOT EXISTS idx_events_time   ON events(dataset_id, time_sort_key, event_id);
CREATE INDEX IF NOT EXISTS idx_events_actor  ON events(dataset_id, actor_id, time_sort_key);
CREATE INDEX IF NOT EXISTS idx_events_type   ON events(dataset_id, event_type, time_sort_key);
CREATE INDEX IF NOT EXISTS idx_events_run    ON events(dataset_id, task_id, time_sort_key);
CREATE INDEX IF NOT EXISTS idx_part_entity   ON participants(dataset_id, entity_id, time_sort_key);
CREATE INDEX IF NOT EXISTS idx_part_event    ON participants(dataset_id, event_id);
CREATE INDEX IF NOT EXISTS idx_rel_src       ON relations(dataset_id, src_id);
CREATE INDEX IF NOT EXISTS idx_rel_dst       ON relations(dataset_id, dst_id);
-- 事件详情按事件取关系边，缺索引会退化为全表扫描（实测 1.1s）
CREATE INDEX IF NOT EXISTS idx_rel_event     ON relations(dataset_id, event_id);
-- 允许用 source_record_id 反查事件（MC1 的 responding_to 就指向它）
CREATE INDEX IF NOT EXISTS idx_events_srcid  ON events(dataset_id, source_record_id);
CREATE INDEX IF NOT EXISTS idx_anno_event    ON annotation_events(dataset_id, event_id);
CREATE INDEX IF NOT EXISTS idx_fts_dataset   ON event_fts(dataset_id);
CREATE INDEX IF NOT EXISTS idx_bucket        ON time_buckets(dataset_id, granularity, bucket_key);
CREATE VIRTUAL TABLE IF NOT EXISTS event_fts_idx USING fts5(
    body, content='event_fts', content_rowid='rowid', tokenize='unicode61'
);
"""

POST = """
INSERT INTO event_fts_idx(event_fts_idx) VALUES('rebuild');
ANALYZE;
"""
