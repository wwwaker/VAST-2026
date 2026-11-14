"""Repeatable API-layer samples. Application cache cold != operating-system cold.

Run from backend: python scripts/benchmark_mc2.py --out ../build/mc2-performance.json
Browser paint/layout/interaction measurements are exported separately in the UI.
"""
import argparse
import json
import platform
import statistics
import sys
from pathlib import Path
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from app.main import app
from app.db import get_conn
from app.domain import mc2_cache


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default='../build/mc2-performance.json')
    args = parser.parse_args()
    day = {'start_us': 2410128000000000, 'end_us': 2410214400000000}
    file = 'MC2:file_path:SwiftWren_further_instructions.md'
    def endpoints(scope, mode='types', relation=None):
        return [('activity', scope), ('relations', {**scope, 'mode': mode, **({'relation': relation} if relation else {})}),
                ('facets', {**scope, 'kind': 'file'}), ('count', scope), ('evidence', scope)]
    scenarios = {
        'initial-entry': endpoints({}), 'recent-return-api': endpoints({}),
        'date': endpoints(day), 'keyword': endpoints({'q': 'SwiftWren'}),
        'file': [('relations', {'file_id': file, 'mode': 'operations'}), ('evidence', {'file_id': file}), ('file-info', {'file_id': file})],
        'dense-mail': endpoints({'types': 'sent'}, 'system', 'mail_recipient'),
    }
    with get_conn() as conn:
        version = conn.execute("SELECT data_version FROM datasets WHERE dataset_id='MC2'").fetchone()[0]
    report = {'device': platform.platform(), 'processor': platform.processor(), 'python': platform.python_version(),
              'data_version': version, 'layer': 'FastAPI TestClient (no network/browser)',
              'cold_definition': 'MC2 application response cache cleared; persistent projections and OS disk cache retained',
              'timing_definition': 'db=SQLite execute/fetch; assemble=app minus db, including scheduling/serialization; wall includes response transfer inside TestClient',
              'browser_note': 'UI experience export provides request/JSON/commit/layout/next frame/long task samples. No real browser timings are claimed here.',
              'samples': [], 'summary': []}
    with TestClient(app) as client:
        for name, paths in scenarios.items():
            modes = [('application-cold', 5)] if name == 'initial-entry' else [('application-warm', 20)]
            # An explicit prime is excluded from warm samples.
            if name != 'initial-entry':
                for path, params in paths: client.get('/api/mc2/' + path, params=params).raise_for_status()
            for cache, count in modes:
                for index in range(count):
                    if cache == 'application-cold': mc2_cache.clear_cache()
                    started = perf_counter(); requests = []
                    for path, params in paths:
                        r = client.get('/api/mc2/' + path, params=params); r.raise_for_status()
                        timings = {part.split(';')[0].strip(): float(part.split('dur=')[1]) for part in r.headers['server-timing'].split(',')}
                        requests.append({'path': path, 'params': params, 'bytes': len(r.content), **timings})
                    report['samples'].append({'scenario': name, 'cache': cache, 'sample': index + 1,
                                              'wall_ms': (perf_counter() - started) * 1000, 'requests': requests})
                rows = [s for s in report['samples'] if s['scenario'] == name]
                report['summary'].append({'scenario': name, 'cache': cache, 'n': count,
                    'median_ms': round(statistics.median(s['wall_ms'] for s in rows), 3),
                    'max_ms': round(max(s['wall_ms'] for s in rows), 3),
                    'median_db_ms': round(statistics.median(sum(r['db'] for r in s['requests']) for s in rows), 3),
                    'request_count_per_sample': len(paths)})
    target = Path(args.out).resolve(); target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(target), 'summary': report['summary']}, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()
