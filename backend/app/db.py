"""SQLite 访问层：每请求一个只读连接，WAL 下多读一写。"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterator

from .config import DB_PATH


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def require_dataset(conn: sqlite3.Connection, dataset_id: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM datasets WHERE dataset_id=?", (dataset_id,)
    ).fetchone()
    if row is None:
        raise KeyError(dataset_id)
    return row
