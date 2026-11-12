"""Read-only bridge from the current MC1 store to the reference UI contract.

Message identities/raw fields come from SQLite, contextual facts and lexical
metrics from the existing hash-verified view bundle. No graph server, import,
model download, or write to the investigation database is involved.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from functools import lru_cache
import json
import os
import re

from ...config import DB_PATH
from ...db import get_conn
from ..mc1_context import views_for
from .config import AGENT_LABELS, MERGER_KEYWORDS, TEXT_SOURCE_OPTIONS, AGENT_VOCATIVE_PATTERNS, RECIPIENT_ROLE_TO_AGENT


def related(text):
    return any(k in (text or "").lower() for k in MERGER_KEYWORDS)


def snapshot():
    # File identity plus data_version invalidates a snapshot after DB replacement.
    stat = os.stat(DB_PATH)
    with get_conn() as conn:
        row = conn.execute("SELECT data_version FROM datasets WHERE dataset_id='MC1'").fetchone()
    return _snapshot(str(row[0]) if row else "", stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=2)
def _snapshot(version, modified, size):
    with get_conn() as conn:
        views = views_for(conn) or {}
        rows = conn.execute(
            "SELECT e.event_id,e.source_record_id,e.timestamp_raw,e.reply_class,"
            "e.reply_target_event_id,e.source_json_pointer,r.raw_json "
            "FROM events e JOIN event_raw r USING(dataset_id,event_id) "
            "WHERE e.dataset_id='MC1' ORDER BY e.time_sort_us,e.event_id"
        ).fetchall()
    timeline = views.get("timeline", [])
    by_round = {r['round_index']: r for r in timeline}
    derived = views.get("messages_by_id", {})
    messages = []
    for i, row in enumerate(rows):
        raw = json.loads(row['raw_json'])
        mid = row['source_record_id']
        view = derived.get(mid, {})
        state = raw.get('internal_state') or {}
        texts = {'content': raw.get('content') or '', **{k: state.get(k) or '' for k in TEXT_SOURCE_OPTIONS[1:]}}
        idx = view.get('round_index')
        if idx is None:
            match = re.search(r'_(\d{2})_\d{3}$', mid)
            idx = int(match[1]) if match else 0
        m = {**raw, 'message_id': mid, 'event_id': row['event_id'], 'comm_id': i + 1,
             'timestamp': row['timestamp_raw'], 'visibility': 'external' if raw.get('channel') in ('personal_post','official_post','anonymous_post') else 'internal',
             'round_index': idx, 'round_hour': by_round.get(idx, {}).get('timestamp') or row['timestamp_raw'][:13] + ':00:00',
             'event_headline': by_round.get(idx, {}).get('headline', ''),
             'source_pointer': row['source_json_pointer'], 'reply_class': row['reply_class'],
             'is_merger_related': related(texts['content']),
             'internal_merger_related': any(related(texts[k]) for k in TEXT_SOURCE_OPTIONS[1:]),
             'resolved_parent_id': (row['reply_target_event_id'] or '').removeprefix('MC1:event:') if row['reply_class'] == 'reply_valid' else '',
             'reply_kind': 'direct' if row['reply_class'] == 'reply_valid' else 'root',
             '_texts': texts, '_metrics': view.get('text_metrics', {})}
        for k in TEXT_SOURCE_OPTIONS[1:]:
            m['internal_' + k] = texts[k]
            m['internal_' + k + '_merger_related'] = related(texts[k])
        messages.append(m)
    rounds = []
    market = {r['round_index']: r for r in views.get('market_by_round', [])}
    for r in timeline:
        idx = r['round_index']; price = market.get(idx, {})
        msgs = [m for m in messages if m['round_index'] == idx]
        environment = [e for e in views.get('environment_events', []) if e.get('round_index') == idx]
        rounds.append({'idx': len(rounds), 'hour': r['timestamp'],
                       'cutoff': max([m['timestamp'] for m in msgs] + [r['timestamp']]),
                       'event_headline': r.get('headline', ''),
                       'event_narrative': '\n'.join(str(e['value']) for e in environment if e.get('kind') == 'event_narrative'),
                       'total_msgs': len(msgs), 'merger_msgs': sum(m['is_merger_related'] or m['internal_merger_related'] for m in msgs),
                       'stock_price_value': price.get('raw_price_value'), 'stock_price': price.get('raw_stock_price'),
                       'market_sentiment': price.get('market_sentiment_label'),
                       'market_sentiment_value': price.get('market_sentiment_value'),
                       'has_merger_context': any(related(str(e.get('value', ''))) for e in environment),
                       'source_pointer': r.get('source_pointer'), 'provenance_kind': 'environment_narrative'})
    if not rounds:
        # Raw-only databases can still expose all messages; context is unavailable.
        for hour in sorted({m['round_hour'] for m in messages}):
            msgs = [m for m in messages if m['round_hour'] == hour]
            rounds.append({'idx': len(rounds), 'hour': hour, 'cutoff': max(m['timestamp'] for m in msgs), 'total_msgs': len(msgs), 'merger_msgs': 0, 'event_headline': ''})
    return messages, rounds


def public(m):
    return {k: v for k, v in m.items() if not k.startswith('_')}


def bucket(timestamp, granularity):
    return timestamp[:10] if granularity == 'daily' else timestamp[:13] + ':00:00'


def selection(params, *, agent=None, cell=None):
    messages, _ = snapshot()
    if '__none__' in params.getlist('text_sources'):
        return []
    types = params.getlist('message_types')
    if not types and params.get('message_type', 'all') != 'all':
        types = [params['message_type']]
    sources = [s for s in params.getlist('text_sources') if s in TEXT_SOURCE_OPTIONS] or TEXT_SOURCE_OPTIONS
    keyword = params.get('keyword', '').strip().lower()
    start, end = params.get('start_time', ''), params.get('end_time', '')
    merger = params.get('merger_only', 'false').lower() == 'true'
    visibility = params.get('visibility', 'all')
    out = []
    for m in messages:
        if agent and agent != 'ALL' and m['agent_id'] != agent: continue
        if cell and bucket(m['timestamp'], params.get('granularity', 'hourly')) != cell: continue
        if types and f"{m['channel']}|{m['message_type']}" not in types: continue
        if start and m['timestamp'] < start: continue
        if end and m['timestamp'] > end: continue  # reference cutoff includes the last message
        if visibility != 'all' and m['visibility'] != visibility: continue
        texts = [m['_texts'][s] for s in sources]
        if not any(texts): continue
        if merger and not any(related(t) for t in texts): continue
        if keyword and not any(keyword in t.lower() for t in texts): continue
        score = sum((4 - TEXT_SOURCE_OPTIONS.index(s)) for s in sources if keyword and keyword in m['_texts'][s].lower())
        out.append({**m, 'keyword_score': score})
    return out


def sentiment(messages, sources):
    sources = [s for s in sources if s in TEXT_SOURCE_OPTIONS] or TEXT_SOURCE_OPTIONS
    values = [m['_metrics'][s]['sentiment'] for m in messages for s in sources
              if m.get('_metrics', {}).get(s, {}).get('sentiment') is not None]
    return sum(values) / len(values) if values else None


def axes(params):
    messages, rounds = snapshot()
    start, end = params.get('start_time',''), params.get('end_time','')
    granularity = params.get('granularity','hourly')
    return sorted({bucket(r['hour'],granularity) for r in rounds if (not start or r['hour'] >= start) and (not end or r['hour'] <= end)} |
                  {bucket(m['timestamp'],granularity) for m in messages if (not start or m['timestamp'] >= start) and (not end or m['timestamp'] <= end)})


def agents():
    return [{'agent_id': aid, 'agent_label': AGENT_LABELS.get(aid, aid)} for aid in sorted(AGENT_LABELS)]


def links(messages):
    """Use recorded, chronologically valid reply links. Mentions stay separate."""
    all_msgs, _ = snapshot(); by_id = {m['message_id']: m for m in all_msgs}
    links = []
    for m in messages:
        parent = by_id.get(m['resolved_parent_id'])
        targets = set()
        if parent and parent['agent_id'] != m['agent_id']:
            target = parent['agent_id']; targets.add(target)
            links.append((m, target, m['channel'], m['message_type'], ''))
        for aid, pattern in AGENT_VOCATIVE_PATTERNS.items():
            if aid != m['agent_id'] and aid not in targets and re.match(pattern, m.get('content') or ''):
                links.append((m, aid, 'mention', '', m['channel']))
    return links


def network(params):
    rows = selection(params); sources = params.getlist('text_sources')
    grouped = defaultdict(list)
    for m in rows: grouped[m['agent_id']].append(m)
    edges = defaultdict(list); received = defaultdict(set); mentions = defaultdict(list)
    all_links = links(rows)
    for m, target, channel, mt, via in all_links:
        edges[(m['agent_id'], target, channel, mt, via)].append(m)
        received[target].add(m['message_id'])
        if channel == 'mention': mentions[target].append(m)
    for m in rows:
        recipients = m.get('recipients') or []
        if isinstance(recipients, str): recipients = [recipients]
        for r in recipients:
            aid = RECIPIENT_ROLE_TO_AGENT.get(r.lower())
            if aid and aid != m['agent_id']: received[aid].add(m['message_id'])
    nodes = []
    for a in agents():
        aid = a['agent_id']; msgs = grouped[aid]
        # A later post alone does not prove a mention was answered.
        answered = sum(any(n['resolved_parent_id'] == m['message_id'] for n in grouped[aid]) for m in mentions[aid])
        nodes.append({'id': aid, 'label': a['agent_label'], 'message_count': len(msgs),
                      'merger_related_count': sum(m['is_merger_related'] or m['internal_merger_related'] for m in msgs),
                      'received_count': len(received[aid]), 'mention_count': len(mentions[aid]),
                      'answered_mention_count': answered, 'unanswered_mention_count': len(mentions[aid]) - answered,
                      'bert_sentiment_score': sentiment(msgs, sources)})
    return {'nodes': nodes, 'edges': [
        {'source': s, 'target': t, 'channel': ch, 'message_type': mt, 'via_channel': via,
         'mention': ch == 'mention', 'weight': len(msgs), 'message_count': len(msgs),
         'merger_related_count': sum(m['is_merger_related'] or m['internal_merger_related'] for m in msgs)}
        for (s,t,ch,mt,via), msgs in sorted(edges.items())],
        'notes': ['仅明确且时间有效的回复进入回复边；正文点名使用独立虚线。', '情绪为词典分值，未执行 BERT 推断。']}


STOP_WORDS = set('the and that this with from have will for you your are was not but can our has had they their them all about into just what when would should could been were its her his she him we it is of to a in on as be or at by an if so do my me us no'.split())


def keywords(rows, sources, limit=10):
    sources = [s for s in sources if s in TEXT_SOURCE_OPTIONS] or TEXT_SOURCE_OPTIONS
    counts = Counter(w for m in rows for s in sources for w in re.findall(r'[a-z][a-z_\-]{2,}', m['_texts'][s].lower()) if w not in STOP_WORDS)
    ordered = sorted(counts, key=lambda w: (-counts[w], w))
    def item(word):
        return {'keyword': word, 'count': counts[word], 'similarity': counts[word]}
    return {'close_keywords': [item(w) for w in ordered[:limit]],
            'far_keywords': [item(w) for w in sorted(ordered[limit:], key=lambda w: (counts[w], w))[:limit]],
            'method': 'word_frequency'}
