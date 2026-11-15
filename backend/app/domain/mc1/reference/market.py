"""Market evidence adapters. Preserve source values; never promote a forecast to a quote."""
from datetime import datetime, timedelta


KINDS = {
    'estimated_from_percent': 'derived', 'narrative_price': 'narrative',
    'reported_price': 'reported', 'model_baseline': 'model_baseline',
    'conditional_forecast': 'forecast', 'after_hours_report': 'after_hours_report',
}


def source(record):
    return {'round_index': record['round_index'], 'source_pointer': record.get('source_pointer'),
            'recorded_time': record['timestamp'], 'time_precision': 'round'}


def evidence(market, messages, environment):
    """Structured bundle classifications, with explicit assumptions for the eight known cases."""
    result = {}
    previous = None
    for record in sorted(market.values(), key=lambda r: r['timestamp']):
        kind = KINDS.get(record.get('price_status'))
        raw = record.get('price_evidence') or {}
        value = raw.get('value')
        if not kind or value is None:
            if record.get('raw_price_value') is not None:
                previous = {'value': record['raw_price_value'], **source(record), 'kind': 'snapshot'}
            continue
        message = messages.get(raw.get('message_id'))
        # If a referenced message is unavailable, do not substitute its round time.
        if raw.get('message_id') and not message:
            continue
        src = {**source(record), 'source_pointer': raw.get('source_pointer')}
        if message:
            src.update(recorded_time=message['timestamp'], time_precision='message',
                       source_pointer=message['source_pointer'])
        text = message.get('content', '') if message else next((e.get('value', '') for e in environment
               if e.get('round_index') == record['round_index'] and e.get('source_pointer') == raw.get('source_pointer')), '')
        item = {**src, 'kind': kind, 'value': None if isinstance(value, list) else value,
                'range': value if isinstance(value, list) else None, 'message_id': raw.get('message_id'),
                'text': text, 'condition': None, 'claimed_time': None, 'assumptions': [], 'basis': previous if kind == 'derived' else None,
                'time_conflict': None}
        if kind == 'derived':
            item['assumptions'] = ['假设本轮报告百分比以上一条价格为基准；该基准关系未经独立核验。']
            if previous and previous['kind'] == 'derived':
                item['assumptions'].append('基准本身为推导值，属于依赖推导，不是独立观测。')
            item['reported_percent_change'] = record.get('reported_percent_change')
            previous = {'value': value, **src, 'kind': kind, 'basis': previous}
        elif kind == 'narrative':
            item['claimed_time'] = '2046-06-05T10:00:00' if record['timestamp'] == '2046-06-05T11:00:00' else None
            item['time_conflict'] = '叙述标注 10:00，所属轮次为 11:00；保留两种时间，不裁定哪个标签正确。' if item['claimed_time'] else None
        elif kind == 'model_baseline':
            item['assumptions'] = ['模型重建使用的基准，不等于成交价或行情观测。']
        elif kind == 'forecast':
            if raw.get('message_id') == '20460605_20_019':
                item['condition'] = '16:30 获 CivicLoom 同意后自行公布；替代情景为 SaltWind 于 17:00 抢先报道，原文未给该情景价格区间。'
            elif raw.get('message_id') == '20460605_21_003':
                item['condition'] = '17:15 自行公布并配套治理；替代情景为延迟至 18:00，情绪维持危急，原文未给该情景价格区间。'
            item['assumptions'] = ['这是条件预测数值范围，不是置信区间；不取中值，不用后续结果筛选当时情景。']
        elif kind == 'after_hours_report':
            item['claimed_time'] = '2046-06-05T18:40:00' if raw.get('message_id') == '20460605_22_056' else None
            item['assumptions'] = ['消息引述的盘后中间价，未作为该小时起点的行情观测。']
        result[record['round_index']] = item
    return result


def series(rounds, buckets, granularity, start='', end=''):
    """Select price and sentiment independently, carrying their own provenance."""
    from app.domain.mc1.reference.data import bucket
    selected = [r for r in rounds if (not start or r['hour'] >= start) and (not end or r['hour'] <= end)]
    out = []
    legacy_previous = None
    previous = None
    for b in buckets:
        rows = [r for r in selected if bucket(r['hour'], granularity) == b]
        price = next((r for r in reversed(rows) if r.get('stock_price_value') is not None), {})
        sentiment = next((r for r in reversed(rows) if r.get('market_sentiment') not in (None, '')), {})
        evidence_items = [e for r in rounds for e in r.get('price_evidence', [])
                          if bucket(e['recorded_time'], granularity) == b and
                          (not start or e['recorded_time'] >= start) and (not end or e['recorded_time'] <= end)]
        value = price.get('stock_price_value')
        change = {'value': None, 'reason': '缺失', 'basis': None}
        if value is not None and previous and previous['stock_price'] is not None:
            try:
                fmt = '%Y-%m-%d' if granularity == 'daily' else '%Y-%m-%dT%H:%M:%S'
                step = timedelta(days=1) if granularity == 'daily' else timedelta(hours=1)
                contiguous = datetime.strptime(b, fmt) - datetime.strptime(previous['time_bucket'], fmt) == step
            except ValueError:
                contiguous = False
            reason = '跨时段' if not contiguous else '口径待核对' if price.get('price_disputed') or previous['price_disputed'] else '基准为零' if previous['stock_price'] == 0 else None
            change = {'value': None if reason else (value - previous['stock_price']) / abs(previous['stock_price']) * 100,
                      'reason': reason, 'basis': {'value': previous['stock_price'], 'time_bucket': previous['time_bucket'], 'source': previous['price_source']}}
        snapshot = price or (rows[-1] if rows else {})
        row = {'time_bucket': b, 'stock_price': value, 'raw_stock_price': snapshot.get('stock_price'),
               'stock_price_change_pct': (value-legacy_previous)/abs(legacy_previous)*100 if value is not None and legacy_previous else None,
               'market_sentiment_label': sentiment.get('market_sentiment'), 'market_sentiment_value': sentiment.get('market_sentiment_value'),
               'price_source': snapshot.get('market_source'), 'sentiment_source': sentiment.get('market_source'),
               'source_pointer': (snapshot.get('market_source') or {}).get('source_pointer'),
               'reported_percent_change': price.get('reported_percent_change') if price else next((r.get('reported_percent_change') for r in reversed(rows)), None),
               'reported_change_source': (price or (rows[-1] if rows else {})).get('market_source'),
               'price_status': snapshot.get('price_status', 'missing'), 'price_disputed': price.get('price_disputed', False),
               'price_evidence': evidence_items, 'computed_change': change}
        out.append(row)
        previous = row
        if value is not None:
            legacy_previous = value
    return out
