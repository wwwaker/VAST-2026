"""One authoritative selection for local-process plots and exact member pages."""
from collections import Counter, defaultdict
from dataclasses import replace
import hashlib
import json

from fastapi import HTTPException

from . import mc2_cache
from ..db import require_dataset
from ..query import filters

VERSION = 2
FILE_ROLES = {"file_path", "queued_file_path", "post_content_source"}
TASK_ROLES = {"queue_target_agent", "queue_target_person"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def collect(conn, raw, anchor, file_id=None, no_file=False, relation=None, source=None,
            target=None, action=None, seconds=60, context=False, expand=False, actors="", bins=240, selected_event=None):
    # Local imports avoid a second implementation of the workspace scope contract.
    from ..routers.mc2_workspace import selected, participation_clause
    from ..routers.events import summarize

    options = (file_id, no_file, relation, source, target, action)
    parent = selected(raw, *options)
    non_time_raw = replace(raw, start_us=None, end_us=None, cursor_us=None, masking=False)
    non_time = selected(non_time_raw, *options)
    stamp = digest(mc2_cache.database_identity(conn))
    key = digest([VERSION, stamp, vars(raw), anchor, options, seconds, context, expand,
                  sorted(set(actors.split(',')) - {''}), bins, selected_event])

    def compute():
        root = conn.execute("SELECT * FROM events WHERE dataset_id='MC2' AND event_id=?", (anchor,)).fetchone()
        def matches(sel):
            return conn.execute(f"SELECT 1 FROM events e WHERE {sel.where_sql} AND e.event_id=:pa", {**sel.params, "pa": anchor}).fetchone() is not None
        reasons = []
        if root is None:
            reasons.append({"code": "missing", "label": "锚点记录已不存在，请重新选择"})
        else:
            # Validate dimensions separately so combined conflicts remain explainable.
            dimensions = [
                ("type", "类型或类别不符", replace(non_time_raw, actor=None, participant=None, keyword=None), (None, False, None, None, None, None)),
                ("actor", "执行者不符", filters.RawFilter(actor=raw.actor), (None, False, None, None, None, None)),
                ("participant", "参与者不符", filters.RawFilter(participant=raw.participant), (None, False, None, None, None, None)),
                ("keyword", "关键词不符", filters.RawFilter(keyword=raw.keyword), (None, False, None, None, None, None)),
                ("file", "文件条件不符", filters.RawFilter(), (file_id, no_file, None, None, None, None)),
                ("relation", "角色、端点或动作不符", filters.RawFilter(), (None, False, relation, source, target, action)),
            ]
            for code, label, dimension, opts in dimensions:
                if not matches(selected(dimension, *opts)):
                    reasons.append({"code": code, "label": label})
            if not matches(non_time) and not reasons:
                reasons.append({"code": "scope", "label": "不符合当前非时间条件"})
            time_ok = (parent.start_us is None or root['time_sort_us'] >= parent.start_us) and (parent.end_us is None or root['time_sort_us'] < parent.end_us)
            if not time_ok and not expand:
                reasons.append({"code": "time", "label": "锚点不在当前父时间内"})
        common = {"anchor": anchor, "anchor_time": root['time_sort_us'] if root else None,
                  "selection_key": key, "data_version": stamp, "invalid_reasons": reasons}
        if reasons:
            return {**common, "valid": False, "items": [], "aggregates": [], "lanes": [], "links": [],
                    "note": "；".join(r['label'] for r in reasons), "_all_items": []}
        start, end = root['time_sort_us'] - seconds * 1_000_000, root['time_sort_us'] + seconds * 1_000_000 + 1
        if not expand:
            start = max(start, parent.start_us if parent.start_us is not None else start)
            end = min(end, parent.end_us if parent.end_us is not None else end)
        seed = {root['actor_id']} if root['actor_id'] else set()
        for role in conn.execute(
            "SELECT r.src_id,r.dst_id,s.entity_type st,d.entity_type dt FROM relations r "
            "LEFT JOIN entities s ON s.dataset_id=r.dataset_id AND s.entity_id=r.src_id "
            "LEFT JOIN entities d ON d.dataset_id=r.dataset_id AND d.entity_id=r.dst_id "
            "WHERE r.dataset_id='MC2' AND r.event_id=? AND r.target_kind='entity' AND r.derivation LIKE 'source:%'", (anchor,)):
            if role['st'] in ('agent', 'person'): seed.add(role['src_id'])
            if role['dt'] in ('agent', 'person'): seed.add(role['dst_id'])
        seed.update(x for x in actors.split(',') if x)
        if len(seed) > 150:
            raise HTTPException(400, '局部实体过多，请缩小选择')
        p = {"ps": start, "pe": end, "pa": anchor}
        part = participation_clause(sorted(seed), p, 'seed')
        window = f"e.time_sort_us>=:ps AND e.time_sort_us<:pe AND ({part} OR e.event_id=:pa)"
        main = parent.extend(window, p, key)
        main_ids = {r[0] for r in conn.execute(f"SELECT e.event_id FROM events e WHERE {main.where_sql}", main.params)}
        eligible = selected(filters.RawFilter()) if context else non_time if expand else parent
        query = eligible.extend(window, p, key)
        rows = conn.execute("SELECT e.*,en.label actor_label FROM events e LEFT JOIN entities en ON en.dataset_id=e.dataset_id AND en.entity_id=e.actor_id "
                            f"WHERE {query.where_sql} ORDER BY e.time_sort_us,e.event_id", query.params).fetchall()
        roles = defaultdict(list)
        for offset in range(0, len(rows), 500):
            ids = [r['event_id'] for r in rows[offset:offset + 500]]
            for role in conn.execute("SELECT event_id,relation,src_id,dst_id,derivation FROM relations WHERE dataset_id='MC2' AND target_kind='entity' AND event_id IN (" + ','.join('?' for _ in ids) + ')', ids):
                role = dict(role); roles[role.pop('event_id')].append(role)
        items, aggregates, groups, singles, links = [], [], defaultdict(list), [], []
        lane_first = {}
        for row in rows:
            rs = roles[row['event_id']]
            outside = (parent.start_us is not None and row['time_sort_us'] < parent.start_us) or (parent.end_us is not None and row['time_sort_us'] >= parent.end_us)
            ctx = row['event_id'] not in main_ids
            item = {**summarize(row, 'MC2', []), 'kind': 'event', 'context': ctx, 'roles': rs,
                    'files': sorted({r['dst_id'] for r in rs if r['relation'] in FILE_ROLES}),
                    'context_sources': (['时间扩展'] if ctx and outside else []) + (['附近参与'] if ctx and context else [])}
            items.append(item)
            lane = row['actor_id'] or '__missing__'
            lane_first.setdefault(lane, row['time_sort_us'])
            for role in rs:
                if role['relation'] in TASK_ROLES: lane_first.setdefault(role['dst_id'], row['time_sort_us'])
            if len(rows) > 600 and row['event_id'] not in (anchor, selected_event):
                bucket = (row['time_sort_us'] - start) * bins // (end - start)
                groups[lane, bucket, ctx].append(item)
            else:
                singles.append(item)
                for role in rs:
                    if role['relation'] in TASK_ROLES:
                        links.append({'event_id': row['event_id'], 'source': lane, 'target': role['dst_id'], 'relation': role['relation'], 'time_us': row['time_sort_us']})
        for (lane, bucket, ctx), members in groups.items():
            aggregates.append({'kind': 'aggregate', 'aggregate_id': digest([key, lane, bucket, ctx]),
                'lane_id': lane, 'bucket_start': start + (bucket * (end - start) + bins - 1) // bins,
                'bucket_end': start + ((bucket + 1) * (end - start) + bins - 1) // bins,
                'count': len(members), 'context': ctx, 'types': dict(Counter(i['event_type'] for i in members)),
                'file_count': len({f for i in members for f in i['files']}),
                'task_count': sum(i['event_type'] == 'queue_subordinate_task' for i in members),
                'task_targets': sum(sum(r['relation'] in TASK_ROLES for r in i['roles']) for i in members)})
        lane_ids = set(seed) | set(lane_first)
        order = sorted(lane_ids, key=lambda x: (0 if x == root['actor_id'] else 1 if x in seed else 2, lane_first.get(x, start), x))
        executed = {i['actor_id'] for i in items}
        lanes = []
        for entity in order:
            en = conn.execute("SELECT label,entity_type FROM entities WHERE dataset_id='MC2' AND entity_id=?", (entity,)).fetchone()
            lanes.append({'id': entity, 'label': en['label'] if en else '缺少执行者', 'entity_type': en['entity_type'] if en else 'missing', 'role_only': entity not in executed})
        return {**common, 'valid': True, 'start': start, 'end': end, 'items': singles, 'aggregates': aggregates,
                'lanes': lanes, 'links': links, 'total': len(items), 'main_count': len(main_ids),
                'context_count': len(items) - len(main_ids), 'seed_actors': sorted(seed),
                'outside_main': sum('时间扩展' in i['context_sources'] for i in items), 'anchor_outside_time': not time_ok,
                'expanded': expand, 'bins': bins, 'note': '执行者及日志明确来源/目标的一跳参与；时间相邻不表示因果。', '_all_items': items}
    return mc2_cache.cached(conn, ('process-v2', key), compute)


def public(packet):
    return {k: v for k, v in packet.items() if not k.startswith('_')}


def members(packet, aggregate_id, data_version, selection_key, cursor=None, action=None):
    if not packet['valid'] or packet['data_version'] != data_version or packet['selection_key'] != selection_key:
        raise HTTPException(409, '过程选择或数据版本已变化，请重新加载过程')
    items = packet['_all_items']
    if aggregate_id != 'all':
        group = next((a for a in packet['aggregates'] if a['aggregate_id'] == aggregate_id), None)
        if group is None: raise HTTPException(409, '聚合已失效，请重新加载过程')
        items = [i for i in items if (i['actor_id'] or '__missing__') == group['lane_id'] and i['context'] == group['context']
                 and group['bucket_start'] <= i['time_us'] < group['bucket_end'] and i['event_id'] not in {s['event_id'] for s in packet['items']}]
    if action: items = [i for i in items if i['event_type'] == action]
    scope = digest([selection_key, aggregate_id, action])
    after = None
    if cursor:
        try:
            import base64
            value = json.loads(base64.urlsafe_b64decode(cursor))
            if value['scope'] != scope: raise ValueError()
            after = (value['time'], value['id'])
        except (ValueError, KeyError, TypeError):
            raise HTTPException(400, '成员游标不属于当前过程桶')
    remaining = [i for i in items if after is None or (i['time_us'], i['event_id']) > after]
    page, nxt = remaining[:40], None
    if len(remaining) > 40:
        import base64
        nxt = base64.urlsafe_b64encode(json.dumps({'scope': scope, 'time': page[-1]['time_us'], 'id': page[-1]['event_id']}).encode()).decode()
    return {'items': page, 'total': len(items), 'next_cursor': nxt, 'selection_key': selection_key, 'data_version': data_version}
