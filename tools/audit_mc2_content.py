"""MC2 内容可用性审计（M2-01）。

回答一个问题：**日志能否支持“帖子正文含义”这一主张？**
输出 build/mc2-content-audit.json，供复核；不是人工结论，也不填充任何推测文本。

用法（项目根目录）：
    python tools/audit_mc2_content.py
    python tools/audit_mc2_content.py --db build/mas.db --out build/mc2-content-audit.json
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import zipfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app.domain import mc2_files  # noqa: E402

TARGET_POSTS = ("MC2:event:373902", "MC2:event:27290", "MC2:event:98591")
METHOD_VERSION = "mc2-content-audit/1"
CONTENT_KEYS = mc2_files.CONTENT_KEYS


def _zip_inventory(path: str) -> dict:
    if not os.path.exists(path):
        return {"path": path, "exists": False, "members": []}
    with zipfile.ZipFile(path) as zf:
        members = [
            {"name": info.filename, "size": info.file_size}
            for info in zf.infolist()
            if not info.filename.startswith("__MACOSX")
        ]
    return {
        "path": path,
        "exists": True,
        "members": members,
        # 只声明“没有独立附件”，不据此推断正文一定不存在于 events 中
        "attachment_like": [
            item["name"]
            for item in members
            if not item["name"].endswith((".json", ".md", ".htm", ".html", "/"))
        ],
    }


def _content_field_scan(conn: sqlite3.Connection) -> dict:
    """统计 details 中真正是文本的字段，而不是只做子串匹配（否则 content_source 会被误算）。"""
    stats = []
    for key in CONTENT_KEYS:
        row = conn.execute(
            "SELECT COUNT(*), MAX(LENGTH(json_extract(details_json, ?))) FROM events "
            "WHERE dataset_id='MC2' AND json_type(details_json, ?) = 'text'",
            (f"$.{key}", f"$.{key}"),
        ).fetchone()
        if not row or not row[0]:
            continue
        stats.append({"field": key, "event_count": int(row[0]), "max_length": int(row[1] or 0)})
    return {
        "fields": stats,
        # 只把“文本长度足以承载正文”的字段算作可用正文
        "usable_text_fields": [item for item in stats if item["max_length"] >= mc2_files.MIN_CONTENT_LEN],
    }


def _post_content_presence(conn: sqlite3.Connection) -> dict:
    """同类发布事件里有多少带 content，目标帖是否带——这是可核查的字段差异，不是含义推断。"""
    rows = []
    for post_id in TARGET_POSTS:
        row = conn.execute(
            "SELECT e.event_type, "
            "  json_type(e.details_json, '$.content') AS content_type, "
            "  LENGTH(json_extract(e.details_json, '$.content')) AS content_length "
            "FROM events e WHERE e.dataset_id='MC2' AND e.event_id=?",
            (post_id,),
        ).fetchone()
        if row is None:
            continue
        peers = conn.execute(
            "SELECT COUNT(*) AS total, "
            "  SUM(CASE WHEN json_type(details_json,'$.content')='text' THEN 1 ELSE 0 END) AS with_content "
            "FROM events WHERE dataset_id='MC2' AND event_type=?",
            (row["event_type"],),
        ).fetchone()
        rows.append(
            {
                "event_id": post_id,
                "event_type": row["event_type"],
                "has_content": row["content_type"] == "text",
                "content_length": row["content_length"],
                "peers_total": int(peers["total"] or 0),
                "peers_with_content": int(peers["with_content"] or 0),
            }
        )
    return {
        "targets": rows,
        "note": (
            "content 是标题级文本（实测最长 101 字符），不是文件正文；"
            "带 content 的同类型事件说明字段存在，但不代表能还原来源文件内容。"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.path.join(ROOT, "build", "mas.db"))
    parser.add_argument("--out", default=os.path.join(ROOT, "build", "mc2-content-audit.json"))
    parser.add_argument(
        "--zip",
        default=os.path.join(ROOT, "final-data", "raw", "official_data", "MC2", "VAST_Challenge_2026_MC2.zip"),
    )
    args = parser.parse_args()

    if not os.path.exists(args.db):
        print(f"缺少主库 {args.db}，请先执行 cd backend && python -m app.ingest.cli --all --fresh")
        return 2

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        posts = []
        for event_id in TARGET_POSTS:
            row = conn.execute(
                "SELECT event_id, event_type, time_sort_us, actor_id FROM events "
                "WHERE dataset_id='MC2' AND event_id=?",
                (event_id,),
            ).fetchone()
            if row is None:
                posts.append({"event_id": event_id, "exists": False})
                continue
            links = [
                {"file_id": item["dst_id"], "relation": item["relation"]}
                for item in conn.execute(
                    "SELECT dst_id, relation FROM relations WHERE dataset_id='MC2' "
                    "AND event_id=? AND relation='post_content_source'",
                    (event_id,),
                )
            ]
            files = []
            for link in links:
                try:
                    files.append(mc2_files.content_status(conn, "MC2", link["file_id"]))
                except KeyError:
                    files.append({"file_id": link["file_id"], "content_status": "unresolved"})
            posts.append(
                {
                    "event_id": event_id,
                    "exists": True,
                    "event_type": row["event_type"],
                    "time_us": row["time_sort_us"],
                    "actor_id": row["actor_id"],
                    "content_source_links": links,
                    "files": files,
                }
            )

        scan = _content_field_scan(conn)
        presence = _post_content_presence(conn)
    finally:
        conn.close()

    zip_info = _zip_inventory(args.zip)
    statuses = {}
    for post in posts:
        for item in post.get("files", []):
            statuses[item.get("content_status")] = statuses.get(item.get("content_status"), 0) + 1

    payload = {
        "method_version": METHOD_VERSION,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "db": args.db,
        "targets": posts,
        "content_status_counts": statuses,
        "content_field_scan": scan,
        "post_content_presence": presence,
        "official_package": zip_info,
        "checked_sources": [
            "events.details_json（全部 MC2 事件）",
            "relations.relation='post_content_source'",
            "官方 MC2 ZIP 成员清单与数据说明",
        ],
        "missing_fields": ["文件正文", "编码或格式说明"],
        "supports": [
            "三条帖子的内容来源文件名可追踪（post_content_source）",
            "来源文件的创建/读取/删除等操作可按时间排序",
            "三条帖子的发布事件都没有 content 字段，而同类发布事件多数带有标题级 content（可核查的字段差异）",
        ],
        "cannot_support": [
            "帖子正文的具体文本（来源文件的正文不在数据中）",
            "帖子含义、以及“乱码”的成因解释",
            "内容在 agent 之间传递的完整因果链（只有排队任务记录）",
        ],
        "conclusion": (
            "content_status=metadata_only：来源文件的正文不在日志和官方包内，"
            "只能支持“来源可追踪”与“异常帖子缺少同类事件的 content 字段”，"
            "不能支持“含义已确认”。异常帖子无 content 是字段差异，不足以单独断定蓄意或故障。"
        ),
        "limits": [
            "content 字段为标题级文本（实测最长 101 字符），不能当正文使用",
            "本报告统计 details 中出现的是文本型字段，不解析编码载荷",
            "同名前缀文件只作检索提示，不构成传播证据",
            "未提供正文时不填充推测文本",
        ],
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    print(f"目标帖 {len([p for p in posts if p.get('exists')])}/{len(TARGET_POSTS)} 存在")
    print(f"内容状态计数 {statuses}")
    print(f"文本型字段 {scan['fields']}")
    for item in presence["targets"]:
        print(
            f"  {item['event_id']} type={item['event_type']} "
            f"content={item['has_content']} 同类 {item['peers_with_content']}/{item['peers_total']} 带 content"
        )
    print(f"官方包附件 {zip_info.get('attachment_like') or '无'}")
    print(f"报告 {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
