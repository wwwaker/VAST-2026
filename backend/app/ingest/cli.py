"""导入命令行：python -m app.ingest.cli --all --fresh

原子导入：
1. 在目标主库同目录创建 mas.next.<随机>.db，完整构建（含 --dataset 的部分重导）。
2. 在临时库上建索引、重建 FTS、校验。
3. 必需检查通过后 quick_check，关闭临时库，备份旧库并替换。
4. 任一步失败：保留旧库，删除临时库，写出 build/ingest-validation.json 并以非零码退出。

不再在导入开始前删除旧库：--fresh 只表示“不继承旧库内容”，旧库会保留到新库验收完成。
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone

from ..config import BUILD_DIR, DB_PATH
from . import schema
from .loader import DatasetStats, load_dataset
from .manifest import ALL

VALIDATION_REPORT = os.path.join(BUILD_DIR, "ingest-validation.json")


def _connect(path: str) -> sqlite3.Connection:
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


def _user_version(path: str) -> int:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def _copy_database(src: str, dst: str) -> None:
    """用 SQLite backup API 复制，避免直接拷贝主文件而漏掉 WAL 中的已提交页。"""
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    target = sqlite3.connect(dst)
    try:
        source.backup(target)
        target.commit()
    finally:
        target.close()
        source.close()


def _replace_database(tmp: str, target: str) -> None:
    for suffix in ("-wal", "-shm"):
        candidate = target + suffix
        if os.path.exists(candidate):
            os.remove(candidate)
    if os.path.exists(target):
        backup = target + ".bak"
        if os.path.exists(backup):
            os.remove(backup)
        os.replace(target, backup)
    os.replace(tmp, target)


def _write_report(payload: dict) -> None:
    os.makedirs(BUILD_DIR, exist_ok=True)
    with open(VALIDATION_REPORT, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def _validate(conn: sqlite3.Connection, stats: list[DatasetStats]) -> tuple[list[dict], list[dict]]:
    quick = conn.execute("PRAGMA quick_check").fetchone()[0]
    global_checks = [("quick_check", quick == "ok", str(quick))]
    per_dataset = []
    for item in stats:
        checks = [{"name": n, "ok": bool(ok), "detail": d} for n, ok, d in item.checks]
        per_dataset.append(
            {
                "dataset_id": item.dataset_id,
                "events": item.events,
                "entities": item.entities,
                "runs": item.runs,
                "data_version": item.data_version,
                "unknown_types": item.unknown_types,
                "checks": checks,
            }
        )
    return [
        {"name": n, "ok": bool(ok), "detail": d} for n, ok, d in global_checks
    ], per_dataset


def main() -> None:
    parser = argparse.ArgumentParser(description="导入 VAST 2026 数据集到 SQLite（schema v2）")
    parser.add_argument("--dataset", choices=list(ALL), help="只导入指定数据集")
    parser.add_argument("--all", action="store_true", help="导入全部数据集")
    parser.add_argument("--db", default=DB_PATH)
    parser.add_argument("--fresh", action="store_true", help="全量重建（旧库在校验通过后才被替换）")
    args = parser.parse_args()

    target = os.path.abspath(args.db)
    targets = list(ALL) if args.all or not args.dataset else [args.dataset]
    tmp = f"{target}.next.{uuid.uuid4().hex[:8]}.db"
    started = time.perf_counter()
    stats: list[DatasetStats] = []

    # 清理上一次失败留下的临时库，避免目录里堆积大文件
    parent = os.path.dirname(target) or "."
    for name in os.listdir(parent):
        if name.startswith(os.path.basename(target) + ".next.") and name.endswith(".db"):
            try:
                os.remove(os.path.join(parent, name))
            except OSError:
                pass

    try:
        if not args.fresh:
            if not os.path.exists(target):
                raise SystemExit(f"目标库不存在：{target}\n首次导入请加 --fresh --all")
            version = _user_version(target)
            if version != schema.SCHEMA_VERSION:
                raise SystemExit(
                    f"旧库 schema_version={version}，当前需要 {schema.SCHEMA_VERSION}。\n"
                    "请执行全量重建：python -m app.ingest.cli --all --fresh"
                )
            _copy_database(target, tmp)
        else:
            conn = _connect(tmp)
            conn.executescript(schema.TABLES)
            conn.close()

        conn = _connect(tmp)
        for dataset_id in targets:
            manifest = ALL[dataset_id]
            print(f"\n== {manifest.name} ==")
            t0 = time.perf_counter()
            item = load_dataset(conn, manifest)
            conn.commit()
            stats.append(item)
            elapsed = time.perf_counter() - t0
            print(
                f"  事件 {item.events:,} · 实体 {item.entities:,} · 参与者 {item.participants:,} "
                f"· 关系 {item.relations:,} · 全文 {item.fts_rows:,} · 运行 {item.runs} · 耗时 {elapsed:.2f}s"
            )
            if item.unresolved_refs:
                print(f"  未解析引用 {item.unresolved_refs} 条（已计数，未丢弃）")
            if item.missing_source_id:
                print(f"  source_record_id 缺失 {item.missing_source_id} 条（回落为 event_id）")
            for name, ok, detail in item.checks:
                mark = "OK  " if ok else "FAIL"
                print(f"  [{mark}] {name}{' — ' + detail if detail else ''}")

        conn.executescript(schema.INDEXES)
        conn.executescript(schema.POST)
        conn.commit()

        global_checks, per_dataset = _validate(conn, stats)
        for check in global_checks:
            print(
                f"  [{'OK  ' if check['ok'] else 'FAIL'}] {check['name']}"
                f"{' — ' + check['detail'] if check['detail'] else ''}"
            )
        all_ok = all(check["ok"] for check in global_checks) and all(
            check["ok"] for item in per_dataset for check in item["checks"]
        )
        conn.close()

        report = {
            "schema_version": schema.SCHEMA_VERSION,
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "target": target,
            "ok": all_ok,
            "datasets": per_dataset,
            "global_checks": global_checks,
        }
        _write_report(report)

        if not all_ok:
            raise SystemExit("存在校验失败项，请检查上面的输出；旧库与临时库均已保留")

        # 通过后再启用 WAL，关闭连接时自动 checkpoint
        conn = sqlite3.connect(tmp)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        conn.close()

        try:
            _replace_database(tmp, target)
        except PermissionError as exc:
            raise SystemExit(
                f"无法替换主库（可能仍有后端进程占用）：{exc}\n"
                f"请停止服务后重新执行；临时库已保留：{tmp}"
            ) from exc

        total = time.perf_counter() - started
        size_mb = os.path.getsize(target) / 1024 / 1024
        print(f"\n数据库 {target} · {size_mb:.1f} MB · 总计 {total:.2f}s · schema v{schema.SCHEMA_VERSION}")
        print(f"校验报告 {VALIDATION_REPORT}")
        print("全部校验通过")
    except SystemExit:
        raise
    except Exception:
        # 非预期失败：保留临时库供排查，旧库未被触碰
        raise


if __name__ == "__main__":
    main()
