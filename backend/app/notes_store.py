"""调查笔记存储。

**单独一个库文件**，不与 mas.db 混放：导入命令的 --fresh 会删除整个 mas.db，
笔记属于人工产出，不能被重建数据冲掉。
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from .config import NOTES_DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    note_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id     TEXT NOT NULL,
    event_id       TEXT,
    event_time     INTEGER,
    body           TEXT NOT NULL,
    filter_summary TEXT,
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_dataset ON notes(dataset_id, note_id DESC);
"""


@contextmanager
def notes_conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(NOTES_DB, timeout=5.0)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def ensure_schema() -> None:
    with notes_conn() as conn:
        conn.executescript(SCHEMA)


def list_notes(dataset_id: str, limit: int = 200) -> list[dict]:
    with notes_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM notes WHERE dataset_id=? ORDER BY note_id DESC LIMIT ?",
            (dataset_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def create_note(
    dataset_id: str,
    body: str,
    event_id: str | None = None,
    event_time: int | None = None,
    filter_summary: str | None = None,
) -> dict:
    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with notes_conn() as conn:
        cur = conn.execute(
            "INSERT INTO notes (dataset_id, event_id, event_time, body, filter_summary, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (dataset_id, event_id, event_time, body, filter_summary, created),
        )
        note_id = cur.lastrowid
        row = conn.execute("SELECT * FROM notes WHERE note_id=?", (note_id,)).fetchone()
    return dict(row)


def delete_note(note_id: int) -> bool:
    with notes_conn() as conn:
        cur = conn.execute("DELETE FROM notes WHERE note_id=?", (note_id,))
    return cur.rowcount > 0
