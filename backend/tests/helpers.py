"""测试公共工具。

默认使用 build/mas.db（或 MAS_DB 指定的库）。测试必须先导入本模块，
让 MAS_DB 在 app.config 导入前生效。
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKEND = os.path.join(ROOT, "backend")
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

DB_PATH = os.environ.get("MAS_DB") or os.path.join(ROOT, "build", "mas.db")
os.environ.setdefault("MAS_DB", DB_PATH)

from app.ingest import schema  # noqa: E402

EVENT_COLUMNS = (
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


def iso_us(value: int) -> str:
    return (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=value)).isoformat()


def require_db(case: unittest.TestCase) -> str:
    if not os.path.exists(DB_PATH):
        raise unittest.SkipTest(f"缺少 v2 主库 {DB_PATH}，请先执行 app.ingest.cli --all --fresh")
    return DB_PATH


def insert_event(
    conn: sqlite3.Connection,
    dataset: str,
    event_id: str,
    time_us: int,
    event_type: str = "broadcast",
    actor_id: str | None = "MC1:agent:a",
    details: str | None = None,
    run_id: str | None = None,
    channel_id: str | None = None,
    has_deliberation: int = 0,
) -> None:
    row = {
        "dataset_id": dataset,
        "event_id": event_id,
        "source_record_id": event_id,
        "timestamp_raw": iso_us(time_us),
        "timestamp_normalized": iso_us(time_us),
        "time_sort_us": time_us,
        "time_sort_key": time_us // 1_000_000,
        "timezone_status": "utc",
        "actor_id": actor_id,
        "actor_rule": None,
        "event_type": event_type,
        "task_id": None,
        "run_id": run_id,
        "document_id": None,
        "target_id": None,
        "version": None,
        "channel_id": channel_id,
        "parent_event_id": None,
        "details_json": details,
        "source_file": "tiny.jsonl",
        "source_ordinal": 1,
        "source_json_pointer": None,
        "source_missing_id": 0,
        "has_deliberation": has_deliberation,
    }
    conn.execute(
        "INSERT INTO events (" + ",".join(EVENT_COLUMNS) + ") VALUES ("
        + ",".join("?" * len(EVENT_COLUMNS)) + ")",
        [row[name] for name in EVENT_COLUMNS],
    )


def build_tiny_db(events: list[dict], dataset: str = "MC1") -> str:
    """建一个只含 schema + 少量事件的小库，返回路径。调用方负责清理。"""
    handle, path = tempfile.mkstemp(suffix=".db")
    os.close(handle)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(schema.TABLES)
        conn.executescript(schema.INDEXES)
        start = min(item["time_us"] for item in events)
        end = max(item["time_us"] for item in events)
        conn.execute(
            "INSERT INTO datasets (dataset_id,name,question,timezone_status,event_count,entity_count,"
            "ts_min,ts_max,deliberation_count,import_version,data_version,schema_version,imported_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                dataset,
                "tiny",
                "tiny",
                "utc",
                len(events),
                0,
                iso_us(start),
                iso_us(end),
                0,
                "test",
                "tiny",
                schema.SCHEMA_VERSION,
                "2026-01-01T00:00:00+00:00",
            ),
        )
        for item in events:
            insert_event(conn, dataset=dataset, **item)
        conn.commit()
    finally:
        conn.close()
    return path
