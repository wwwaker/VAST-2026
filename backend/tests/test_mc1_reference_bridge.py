"""Cross-check the migrated frontend contract against current source records."""
import unittest

try:
    from . import helpers
except ImportError:
    import helpers
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.datastructures import QueryParams
from app.db import get_conn
from app.domain.mc1_reference import data
from app.routers.mc1_reference import router


class ReferenceBridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app = FastAPI()
        app.include_router(router)
        cls.client = TestClient(app)

    def setUp(self):
        helpers.require_db(self)

    def get(self, endpoint, params=None):
        response = self.client.get('/api/mc1-reference/api/' + endpoint, params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_source_identity_and_complete_cell_partition(self):
        with get_conn() as conn:
            source_ids = {r[0] for r in conn.execute("SELECT source_record_id FROM events WHERE dataset_id='MC1'")}
        options = self.get('options')
        self.assertEqual(options['total_count'], len(source_ids))
        heatmap = self.get('heatmap')
        self.assertEqual(sum(c['message_count'] for c in heatmap['cells']), len(source_ids))
        observed = []
        for bucket in heatmap['time_buckets']:
            rows = self.get('messages', {'bucket': bucket, 'agent_id': 'ALL'})
            expected = sum(c['message_count'] for c in heatmap['cells'] if c['bucket'] == bucket)
            self.assertEqual(len(rows), expected)
            observed.extend(m['message_id'] for m in rows)
            for m in rows:
                self.assertEqual(m['event_id'], 'MC1:event:' + m['message_id'])
                self.assertTrue(m['source_pointer'])
        self.assertEqual(len(observed), len(source_ids))
        self.assertEqual(set(observed), source_ids)

    def test_combined_filters_have_same_count_and_evidence(self):
        cases = [
            {'keyword': 'embargo', 'text_sources': 'content'},
            {'merger_only': 'true', 'text_sources': 'deliberating'},
            {'message_types': 'side_huddle|side_huddle'},
            {'start_time': '2046-06-05T12:00:00', 'end_time': '2046-06-05T14:30:00'},
            {'granularity': 'daily', 'keyword': 'CivicLoom'},
            {'text_sources': '__none__'}, {'message_types': '__none__'},
        ]
        for params in cases:
            with self.subTest(params=params):
                hm = self.get('heatmap', params)
                total = sum(c['message_count'] for c in hm['cells'])
                network = self.get('network', params)
                self.assertEqual(sum(n['message_count'] for n in network['nodes']), total)
                for b in hm['time_buckets']:
                    rows = self.get('messages', {**params, 'agent_id': 'ALL', 'bucket': b})
                    self.assertEqual(len(rows), sum(c['message_count'] for c in hm['cells'] if c['bucket'] == b))

    def test_every_edge_has_exact_evidence_and_node_totals(self):
        for params in ({}, {'keyword': 'merger'}, {'start_time': '2046-06-05T15:00:00'}):
            graph = self.get('network', params)
            for node in graph['nodes']:
                rows = self.get('node-messages', {**params, 'agent_id': node['id']})
                self.assertEqual(len(rows), node['message_count'])
            for edge in graph['edges']:
                rows = self.get('edge-messages', {**params, 'source': edge['source'], 'target': edge['target'],
                    'channel': edge['channel'], 'edge_message_type': edge['message_type'], 'via_channel': edge['via_channel']})
                self.assertEqual(len(rows), edge['weight'])
                self.assertEqual(len({m['message_id'] for m in rows}), len(rows))
                if not edge['mention']:
                    self.assertTrue(all(m['reply_class'] == 'reply_valid' for m in rows))

    def test_future_reference_remains_raw_but_never_becomes_history(self):
        rows, _ = data.snapshot()
        future = next(m for m in rows if m['reply_class'] == 'reply_future_reference')
        context = self.get('messages/' + future['message_id'] + '/context')
        self.assertIsNone(context['parent_message'])
        self.assertEqual(context['selected_message']['responding_to'], future['responding_to'])
        self.assertEqual(context['selected_message']['reply_class'], 'reply_future_reference')
        by_id = {m['message_id']: m for m in rows}
        for m in rows:
            if m['resolved_parent_id']:
                self.assertLessEqual(by_id[m['resolved_parent_id']]['timestamp'], m['timestamp'])

    def test_timeline_end_includes_last_message(self):
        timeline = self.get('timeline')['rounds']
        params = {'start_time': timeline[-1]['hour'], 'end_time': timeline[-1]['cutoff']}
        rows = data.selection(QueryParams(params))
        self.assertEqual(len(rows), timeline[-1]['total_msgs'])
        self.assertIn(timeline[-1]['cutoff'], [m['timestamp'] for m in rows])

    def test_daily_market_uses_last_non_missing_snapshot_within_window(self):
        params = {'granularity': 'daily', 'end_time': '2046-06-05T12:30:00'}
        payload = self.get('line-chart', params)
        rounds = [r for r in data.snapshot()[1] if r['hour'] <= params['end_time']]
        for row in payload['series']:
            prices = [r['stock_price_value'] for r in rounds if r['hour'].startswith(row['time_bucket']) and r.get('stock_price_value') is not None]
            self.assertEqual(row['stock_price'], prices[-1] if prices else None)

    def test_context_and_event_lookup_keep_raw_ids(self):
        mid = '20460517_00_001'
        context = self.get('messages/' + mid + '/context')
        self.assertTrue(context['found'])
        self.assertTrue(context['selected_message']['internal_deliberating'])
        self.assertEqual(sum(bool(m['is_focus']) for m in context['thread']), 1)
        self.assertEqual(self.get('messages-by-ids', [('ids', mid)])[0]['message_id'], mid)
        self.assertIsInstance(self.get('message-id-map')[mid], int)
        self.assertEqual(self.client.get('/api/mc1-reference/api/messages/missing/context').status_code, 404)


if __name__ == '__main__':
    unittest.main()
