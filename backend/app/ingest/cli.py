"""导入命令行：python -m app.ingest.cli --all"""

from __future__ import annotations

import argparse
import os
import sqlite3
import time

from ..config import DB_PATH
from . import schema
from .loader import load_dataset
from .manifest import ALL


def open_db(path: str, fresh: bool) -> sqlite3.Connection:
    if fresh and os.path.exists(path):
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(path + suffix):
                os.remove(path + suffix)
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA cache_size=-131072;
        PRAGMA temp_store=MEMORY;
        """
    )
    return conn


def ensure_schema(conn: sqlite3.Connection, fresh: bool) -> None:
    if fresh:
        conn.executescript(schema.TABLES)
        return
    exists = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
    ).fetchone()
    if not exists:
        conn.executescript(schema.TABLES)


def main() -> None:
    parser = argparse.ArgumentParser(description="导入 VAST 2026 数据集到 SQLite")
    parser.add_argument("--dataset", choices=list(ALL), help="只导入指定数据集")
    parser.add_argument("--all", action="store_true", help="导入全部数据集")
    parser.add_argument("--db", default=DB_PATH)
    parser.add_argument("--fresh", action="store_true", help="删除旧库后重建")
    args = parser.parse_args()

    targets = list(ALL) if args.all or not args.dataset else [args.dataset]
    conn = open_db(args.db, args.fresh)
    ensure_schema(conn, args.fresh)

    started = time.perf_counter()
    all_ok = True
    for dataset_id in targets:
        manifest = ALL[dataset_id]
        print(f"\n== {manifest.name} ==")
        t0 = time.perf_counter()
        stats = load_dataset(conn, manifest)
        conn.commit()
        elapsed = time.perf_counter() - t0

        print(
            f"  事件 {stats.events:,} · 实体 {stats.entities:,} · 参与者 {stats.participants:,} "
            f"· 关系 {stats.relations:,} · 全文 {stats.fts_rows:,} · 耗时 {elapsed:.2f}s"
        )
        if stats.unresolved_refs:
            print(f"  未解析引用 {stats.unresolved_refs} 条（已计数，未丢弃）")
        if stats.missing_source_id:
            print(f"  source_record_id 缺失 {stats.missing_source_id} 条（回落为 event_id）")
        for name, ok, detail in stats.checks:
            mark = "OK  " if ok else "FAIL"
            print(f"  [{mark}] {name}{' — ' + detail if detail else ''}")
            all_ok = all_ok and ok

    conn.executescript(schema.INDEXES)
    conn.executescript(schema.POST)
    conn.commit()
    conn.execute("PRAGMA journal_mode=WAL;")

    total = time.perf_counter() - started
    size_mb = os.path.getsize(args.db) / 1024 / 1024
    print(f"\n数据库 {args.db} · {size_mb:.1f} MB · 总计 {total:.2f}s")
    if not all_ok:
        raise SystemExit("存在校验失败项，请检查上面的输出")
    print("全部校验通过")


if __name__ == "__main__":
    main()
