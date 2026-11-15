"""Compatibility endpoints for the directly migrated reference MC1 frontend."""
from collections import Counter, defaultdict
from fastapi import APIRouter, Request, HTTPException

import app.domain.mc1.reference.data as data
from app.domain.mc1.reference.config import MERGER_KEYWORDS, TEXT_SOURCE_OPTIONS
from app.domain.mc1.reference.context import build_message_context, build_reply_thread

router = APIRouter(prefix='/api/mc1-reference/api', tags=['mc1-reference'])


@router.get('/options')
def options():
    rows, _ = data.snapshot()
    types = Counter((m['channel'], m['message_type']) for m in rows)
    return {'agents': data.agents(), 'message_types': sorted({m['message_type'] for m in rows}),
            'channels': sorted({m['channel'] for m in rows}), 'text_sources': TEXT_SOURCE_OPTIONS,
            'channel_types': [{'channel': c, 'message_type': t, 'key': f'{c}|{t}', 'count': n} for (c,t),n in sorted(types.items())],
            'total_count': len(rows), 'merger_count': sum(m['is_merger_related'] for m in rows),
            'internal_merger_count': sum(m['internal_merger_related'] for m in rows),
            'combined_merger_count': sum(m['is_merger_related'] or m['internal_merger_related'] for m in rows),
            'min_time': min((m['timestamp'] for m in rows), default=''), 'max_time': max((m['timestamp'] for m in rows), default=''),
            'merger_keywords': MERGER_KEYWORDS}


@router.get('/timeline')
def timeline():
    return {'rounds': data.snapshot()[1]}


@router.get('/rounds')
def rounds(bucket: str, granularity: str = 'hourly'):
    return [r for r in data.snapshot()[1] if data.bucket(r['hour'], granularity) == bucket]


@router.get('/heatmap')
def heatmap(request: Request):
    p = request.query_params; rows = data.selection(p); buckets = data.axes(p)
    grouped = defaultdict(list)
    for m in rows: grouped[(m['agent_id'], data.bucket(m['timestamp'],p.get('granularity','hourly')))].append(m)
    cells = [{'agent_id': a['agent_id'], 'agent_label': a['agent_label'], 'bucket': b,
              'message_count': len(grouped[(a['agent_id'],b)]),
              'bert_sentiment_score': data.sentiment(grouped[(a['agent_id'],b)],p.getlist('text_sources')),
              'cosine_similarity_prev': None, 'cosine_similarity_next': None,
              'semantic_distance_prev': None, 'semantic_distance_next': None}
             for a in data.agents() for b in buckets]
    return {'agents': data.agents(), 'buckets': buckets, 'time_buckets': buckets,
            'cells': cells, 'max_count': max((c['message_count'] for c in cells), default=0), 'sentiment_method': 'source_lexicon'}


@router.get('/line-chart')
def line_chart(request: Request):
    from app.domain.mc1.reference.market import series
    p = request.query_params
    buckets = data.axes(p)
    return {'time_buckets': buckets, 'series': series(data.snapshot()[1], buckets, p.get('granularity', 'hourly'),
            p.get('start_time', ''), p.get('end_time', ''))}


@router.get('/messages')
def messages(request: Request, agent_id: str, bucket: str):
    return [data.public(m) for m in sorted(data.selection(request.query_params,agent=agent_id,cell=bucket),key=lambda m:(-m['keyword_score'], m['timestamp'],m['message_id']))]


@router.get('/node-messages')
def node_messages(request: Request, agent_id: str):
    return [data.public(m) for m in data.selection(request.query_params,agent=agent_id)]


@router.get('/edge-messages')
def edge_messages(request: Request, source: str, target: str, channel: str = '', edge_message_type: str = '', via_channel: str = ''):
    return [data.public(m) for m,t,ch,mt,via in data.links(data.selection(request.query_params,agent=source))
            if t == target and (not channel or ch == channel) and (not edge_message_type or mt == edge_message_type) and (not via_channel or via == via_channel)]


@router.get('/network')
def network(request: Request):
    return data.network(request.query_params)


@router.get('/message-id-map')
def id_map():
    return {m['message_id']: m['comm_id'] for m in data.snapshot()[0]}


@router.get('/messages-by-ids')
def by_ids(request: Request):
    by_id = {m['message_id']: m for m in data.snapshot()[0]}
    return [data.public(by_id[mid]) for mid in request.query_params.getlist('ids') if mid in by_id]


@router.get('/messages/{message_id}/context')
def context(message_id: str):
    rows, _ = data.snapshot()
    if not any(m['message_id'] == message_id for m in rows): raise HTTPException(404,'未知 MC1 消息')
    result = build_message_context(rows,message_id)
    result['thread'] = build_reply_thread(rows,message_id)
    result['link_method'] = 'recorded_chronologically_valid_reply'
    return result


@router.get('/keywords')
def keywords(request: Request, agent_id: str, bucket: str, top_n: int = 10):
    return data.keywords(data.selection(request.query_params,agent=agent_id,cell=bucket), request.query_params.getlist('text_sources'), min(30,max(1,top_n)))
