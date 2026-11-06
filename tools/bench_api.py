"""API 性能基准（contract v2）。

用法（后端已在 8000 运行）：
    python tools/bench_api.py --base http://127.0.0.1:8000 --out build/api-bench-v2.json

规则：
- 每个查询先发一次冷启动请求（单独记录），再预热 --warmup 次，最后采样 --samples 次。
- 报告 p50/p95、响应字节数与状态码；p95 用 nearest-rank。
- 输出 build/api-bench-v2.json；不修改数据库，也不依赖 pytest/httpx。
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_QUERIES = os.path.join(ROOT, "tools", "bench_queries.json")
DEFAULT_OUT = os.path.join(ROOT, "build", "api-bench-v2.json")


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, int(round(fraction * len(ordered) + 0.4999)))
    return ordered[min(rank, len(ordered)) - 1]


def build_url(base: str, path: str, params: dict) -> str:
    query = urllib.parse.urlencode({key: value for key, value in params.items() if value is not None})
    return base.rstrip("/") + path + ("?" + query if query else "")


def request(url: str) -> tuple[int, int, float, bytes]:
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            body = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        body = exc.read() if exc.fp else b""
        status = exc.code
    elapsed_ms = (time.perf_counter() - started) * 1000
    return status, len(body), elapsed_ms, body


def extract_meta(body: bytes) -> dict:
    if len(body) > 8 * 1024 * 1024:
        return {}
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    return {
        "matched_events": meta.get("matched_events"),
        "truncated": meta.get("truncated"),
    }


def bench_query(base: str, query: dict, warmup: int, samples: int) -> dict:
    url = build_url(base, query["path"], query.get("params") or {})
    cold_status, cold_bytes, cold_ms, cold_body = request(url)
    result = {
        "name": query["name"],
        "kind": query.get("kind", "query"),
        "url": url,
        "target_p95_ms": query.get("target_p95_ms"),
        "cold_ms": round(cold_ms, 2),
        "cold_bytes": cold_bytes,
        "cold_status": cold_status,
        **extract_meta(cold_body),
    }
    if cold_status >= 400:
        result.update({"status": cold_status, "error": "cold request failed", "pass": False})
        return result

    for _ in range(max(0, warmup)):
        status, _size, _ms, _body = request(url)
        if status >= 400:
            result.update({"status": status, "error": "warmup failed", "pass": False})
            return result

    times: list[float] = []
    sizes: list[int] = []
    for _ in range(max(1, samples)):
        status, size, elapsed_ms, _body = request(url)
        if status >= 400:
            result.update({"status": status, "error": "sample failed", "pass": False})
            return result
        times.append(elapsed_ms)
        sizes.append(size)

    p50 = percentile(times, 0.50)
    p95 = percentile(times, 0.95)
    target = query.get("target_p95_ms")
    result.update(
        {
            "status": 200,
            "samples": len(times),
            "p50_ms": round(p50, 2) if p50 is not None else None,
            "p95_ms": round(p95, 2) if p95 is not None else None,
            "min_ms": round(min(times), 2),
            "max_ms": round(max(times), 2),
            "mean_ms": round(statistics.fmean(times), 2),
            "bytes": int(round(statistics.fmean(sizes))) if sizes else 0,
            "pass": (p95 is not None and target is not None and p95 <= target) if target else None,
        }
    )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="VAST 2026 API 性能基准（contract v2）")
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--queries", default=DEFAULT_QUERIES)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--only", default=None, help="只跑名称包含该子串的查询")
    args = parser.parse_args()

    with open(args.queries, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    queries = config.get("queries") or []
    if args.only:
        queries = [item for item in queries if args.only in item["name"]]

    results: list[dict] = []
    for index, query in enumerate(queries):
        print(f"[{index + 1}/{len(queries)}] {query['name']} …", flush=True)
        result = bench_query(args.base, query, args.warmup, args.samples)
        if index == 0:
            result["first_request_of_run"] = True
        results.append(result)
        print(
            f"    cold {result.get('cold_ms')} ms · p50 {result.get('p50_ms')} ms · "
            f"p95 {result.get('p95_ms')} ms · {result.get('bytes')} B · "
            f"{'PASS' if result.get('pass') else 'FAIL' if result.get('pass') is False else 'n/a'}",
            flush=True,
        )

    failures = [item["name"] for item in results if item.get("pass") is False]
    slowest = max(
        (item for item in results if item.get("p95_ms") is not None),
        key=lambda item: item["p95_ms"],
        default=None,
    )
    payload = {
        "schema_version": 2,
        "contract_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base_url": args.base,
        "warmup": args.warmup,
        "samples": args.samples,
        "notes": config.get("notes") or [],
        "summary": {
            "query_count": len(results),
            "failures": failures,
            "slowest_p95": (
                {"name": slowest["name"], "p95_ms": slowest["p95_ms"], "target_p95_ms": slowest["target_p95_ms"]}
                if slowest
                else None
            ),
            "cold_start_measured_separately": True,
        },
        "results": results,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print(f"\n报告 {args.out} · {len(results)} 条查询 · 失败 {len(failures)}")
    if failures:
        print("未达标：" + "、".join(failures))
    return 0 if not failures else 2


if __name__ == "__main__":
    sys.exit(main())
