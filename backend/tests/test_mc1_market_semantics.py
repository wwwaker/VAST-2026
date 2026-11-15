"""Source identity, temporal availability and uncertainty must survive UI aggregation."""
import unittest

from . import helpers
import app.domain.mc1.reference.data as data
from app.domain.mc1.reference.market import series


class MarketSemanticsTest(unittest.TestCase):
    def setUp(self):
        helpers.require_db(self)
        self.rounds = data.snapshot()[1]

    def chart(self, end='', granularity='hourly'):
        from starlette.datastructures import QueryParams
        buckets = data.axes(QueryParams({'end_time': end, 'granularity': granularity}))
        return series(self.rounds, buckets, granularity, end=end)

    def test_raw_values_and_forecast_range_are_separate(self):
        rows = {r['time_bucket']: r for r in self.chart()}
        self.assertEqual(rows['2046-06-05T11:00:00']['stock_price'], 180)
        self.assertEqual(rows['2046-06-05T15:00:00']['stock_price'], 18)
        for hour, bounds in [('16', [33, 38]), ('17', [33, 37])]:
            row = rows[f'2046-06-05T{hour}:00:00']
            self.assertIsNone(row['stock_price'])
            self.assertTrue(row['price_source']['source_pointer'].endswith('/market_snapshot'))
            self.assertEqual(row['price_evidence'][0]['range'], bounds)
            self.assertIsNone(row['price_evidence'][0]['value'])
            self.assertIsNone(row['computed_change']['value'])

    def test_message_availability_uses_real_timestamp(self):
        def ids(end):
            return [e['message_id'] for r in self.chart(end) for e in r['price_evidence']]
        self.assertNotIn('20460605_18_005', ids('2046-06-05T14:03:00'))
        self.assertIn('20460605_18_005', ids('2046-06-05T14:04:00'))
        self.assertNotIn('20460605_22_056', ids('2046-06-05T18:54:00'))
        self.assertIn('20460605_22_056', ids('2046-06-05T18:55:00'))

    def test_daily_values_retain_distinct_sources_and_all_evidence(self):
        row = self.chart(granularity='daily')[-1]
        self.assertEqual(row['stock_price'], 18)
        self.assertEqual(row['price_source']['round_index'], 19)
        self.assertEqual(row['sentiment_source']['round_index'], 22)
        self.assertTrue(row['price_source']['source_pointer'].endswith('/market_snapshot'))
        self.assertEqual(len(row['price_evidence']), 8)

    def test_disputed_missing_and_noncontiguous_values_never_calculate(self):
        rows = {r['time_bucket']: r for r in self.chart()}
        self.assertEqual(rows['2046-06-05T12:00:00']['computed_change']['reason'], '口径待核对')
        self.assertIsNone(rows['2046-06-05T10:00:00']['computed_change']['value'])
        self.assertEqual(rows['2046-06-04T09:00:00']['computed_change']['reason'], '跨时段')
        self.assertAlmostEqual(rows['2046-06-05T13:00:00']['computed_change']['value'], (26.9-27.2)/27.2*100)

    def test_derived_basis_and_claimed_times_are_explicit(self):
        evidence = [e for r in self.chart() for e in r['price_evidence']]
        dependent = next(e for e in evidence if e['recorded_time'] == '2046-06-05T10:00:00')
        self.assertEqual(dependent['basis']['kind'], 'derived')
        self.assertEqual(dependent['basis']['basis']['value'], 31.5)
        report = next(e for e in evidence if e['kind'] == 'after_hours_report')
        self.assertEqual(report['recorded_time'], '2046-06-05T18:55:00')
        self.assertEqual(report['claimed_time'], '2046-06-05T18:40:00')

    def test_zero_baseline_and_sentiment_pairing(self):
        rows = [dict(r) for r in self.rounds[-2:]]
        rows[0].update(stock_price_value=0, price_disputed=False)
        rows[1].update(stock_price_value=1, price_disputed=False)
        payload = series(rows, [r['hour'] for r in rows], 'hourly')
        self.assertEqual(payload[-1]['computed_change']['reason'], '基准为零')
        rows[-1].update(market_sentiment=None, market_sentiment_value=99)
        daily = series(rows, ['2046-06-05'], 'daily')[0]
        self.assertEqual(daily['market_sentiment_value'], rows[0]['market_sentiment_value'])
        self.assertEqual(daily['sentiment_source'], rows[0]['market_source'])
