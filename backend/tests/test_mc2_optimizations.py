"""Contract tests for scope validity, exact process buckets and file modes."""
import os
import sqlite3
import unittest
from fastapi import HTTPException
from . import helpers
import app.domain.mc2.process as mc2_process
import app.domain.mc2.fingerprints as mc2_fingerprints
import app.domain.mc2.cache as mc2_cache
from app.query.filters import RawFilter


class ProcessContractTests(unittest.TestCase):
    def setUp(self):
        events = [{'event_id': 'anchor', 'time_us': 1_000_000, 'event_type': 'read_file', 'actor_id': 'a'}]
        for i in range(650):
            events.append({'event_id': f'e{i:04}', 'time_us': 999_700 + i,
                           'event_type': 'queue_subordinate_task' if i % 7 == 0 else 'read_file',
                           'actor_id': None if i % 11 == 0 else 'b' if i % 7 == 0 else 'a'})
        self.path = helpers.build_tiny_db(events, dataset='MC2')
        self.conn = sqlite3.connect(self.path); self.conn.row_factory = sqlite3.Row
        self.conn.executemany("INSERT INTO entities(dataset_id,entity_id,entity_type,label) VALUES('MC2',?,?,?)", [('a','agent','A'),('b','person','B'),('f','file_path','F')])
        self.conn.executemany("INSERT INTO relations(dataset_id,event_id,src_id,dst_id,relation,derivation,target_kind) VALUES('MC2',?,?,?,?,'source:test','entity')",
            [(e['event_id'], e['actor_id'], 'a', 'queue_target_agent') for e in events if e['actor_id'] != 'a'])
        self.conn.commit(); mc2_cache.clear_cache()

    def tearDown(self):
        self.conn.close(); os.remove(self.path); mc2_cache.clear_cache()

    def packet(self, raw=None, **kwargs):
        return mc2_process.collect(self.conn, raw or RawFilter(types='read_file'), 'anchor', context=True, **kwargs)

    def test_expansion_never_bypasses_non_time_conflict(self):
        for raw, code in [(RawFilter(types='delete_file'),'type'),(RawFilter(actor='b'),'actor'),(RawFilter(keyword='no-match'),'keyword')]:
            x = self.packet(raw, expand=True)
            self.assertFalse(x['valid']); self.assertIn(code, [r['code'] for r in x['invalid_reasons']])
            self.assertEqual(x['items'], [])
        x = self.packet(RawFilter(), file_id='f', expand=True)
        self.assertFalse(x['valid']); self.assertIn('file',[r['code'] for r in x['invalid_reasons']])

    def test_time_extension_is_context_not_main(self):
        raw = RawFilter(start_us=2_000_000,end_us=3_000_000,types='read_file')
        self.assertFalse(self.packet(raw)['valid'])
        x = self.packet(raw, expand=True)
        self.assertTrue(x['valid']); self.assertTrue(x['anchor_outside_time'])
        self.assertEqual(x['main_count'],0); self.assertEqual(x['outside_main'],x['total'])
        x = mc2_process.collect(self.conn,raw,'anchor',expand=True,context=False)
        self.assertTrue(x['valid']); self.assertTrue(all(i['event_type']=='read_file' for i in x['_all_items']))
        self.assertEqual(x['main_count'],0)

    def test_aggregates_have_exact_exclusive_members_and_conserve_counts(self):
        x = self.packet(bins=32)
        self.assertEqual(x['total'],651); self.assertEqual(x['main_count']+x['context_count'],651)
        self.assertEqual(len(x['items'])+sum(a['count'] for a in x['aggregates']),651)
        ids = {i['event_id'] for i in x['items']}
        self.assertEqual(ids,{'anchor'})
        self.assertTrue(any(a['lane_id']=='__missing__' for a in x['aggregates']))
        self.assertTrue(any(a['task_count']>0 for a in x['aggregates']))
        for a in x['aggregates']:
            self.assertNotIn('event_id',a)
            cursor, members = None, []
            while True:
                page = mc2_process.members(x,a['aggregate_id'],x['data_version'],x['selection_key'],cursor)
                members += page['items']; cursor = page['next_cursor']
                if not cursor: break
            self.assertEqual(len(members),a['count']); self.assertEqual(sum(a['types'].values()),a['count'])
            self.assertTrue(all(i['context']==a['context'] and a['bucket_start']<=i['time_us']<a['bucket_end'] for i in members))
            self.assertFalse(ids.intersection(i['event_id'] for i in members)); ids.update(i['event_id'] for i in members)
        self.assertEqual(len(ids),x['total'])
        self.assertEqual(mc2_process.members(x,'all',x['data_version'],x['selection_key'])['total'],651)

    def test_extraction_stale_versions_and_cursor_scope(self):
        x = self.packet(bins=32)
        group = max(x['aggregates'],key=lambda a:a['count'])
        page = mc2_process.members(x,group['aggregate_id'],x['data_version'],x['selection_key'])
        self.assertIsNotNone(page['next_cursor'])
        with self.assertRaises(HTTPException):
            mc2_process.members(x,'all',x['data_version'],x['selection_key'],page['next_cursor'])
        for v,k in [('old',x['selection_key']),(x['data_version'],'old')]:
            with self.assertRaises(HTTPException) as raised: mc2_process.members(x,group['aggregate_id'],v,k)
            self.assertEqual(raised.exception.status_code,409)
        member = page['items'][0]
        extracted = self.packet(bins=32,selected_event=member['event_id'])
        self.assertIn(member['event_id'],[i['event_id'] for i in extracted['items']])
        self.assertEqual(len(extracted['items'])+sum(a['count'] for a in extracted['aggregates']),651)
        task_pages=[mc2_process.members(x,a['aggregate_id'],x['data_version'],x['selection_key'],action='queue_subordinate_task') for a in x['aggregates']]
        self.assertEqual(sum(p['total'] for p in task_pages),sum(a['task_count'] for a in x['aggregates']))


class ExactFingerprintTests(unittest.TestCase):
    def setUp(self):
        self.path=helpers.build_tiny_db([
            {'event_id':'c','time_us':100,'event_type':'create_file','actor_id':'a'},
            {'event_id':'r1','time_us':101,'event_type':'read_file','actor_id':'a'},
            {'event_id':'r2','time_us':101,'event_type':'read_file','actor_id':'a'},
            {'event_id':'d','time_us':102,'event_type':'delete_file','actor_id':'a'}],dataset='MC2')
        self.conn=sqlite3.connect(self.path);self.conn.row_factory=sqlite3.Row
        self.conn.executemany("INSERT INTO entities(dataset_id,entity_id,entity_type,source_value,label) VALUES('MC2',?,'file_path',?,?)",[(f,f,f) for f in ('file:f','file:g','file:h')])
        for f,events in [('file:f',['c','d']),('file:g',['c','r1','r2','d']),('file:h',['c','r1','d'])]:
            for event in events:
                self.conn.execute("INSERT INTO relations(dataset_id,event_id,src_id,dst_id,relation,derivation,target_kind) VALUES('MC2',?,'a',?,'file_path','source:test','entity')",(event,f))
        self.conn.execute("INSERT INTO relations(dataset_id,event_id,src_id,dst_id,relation,derivation,target_kind) VALUES('MC2','c','a','file:f','queued_file_path','source:test','entity')")
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        for path in (self.path,mc2_fingerprints.sidecar(self.path)):
            if os.path.exists(path): os.remove(path)

    def test_exact_repeats_dedup_and_single_membership(self):
        result=mc2_fingerprints.build(self.path)
        self.assertEqual(result['file_total'],3);self.assertEqual(result['pattern_total'],3)
        data=mc2_fingerprints.patterns(self.conn)
        self.assertEqual(sum(p['file_count'] for p in data['items']),3)
        ids=[]
        for p in data['items']:
            members=mc2_fingerprints.members(self.conn,p['id'])
            ids += [m['file_id'] for m in members['items']]
            self.assertTrue(all(m['event_count']==p['action_count'] for m in members['items']))
        self.assertEqual(len(set(ids)),3)
        repeated=next(p for p in data['items'] if p['action_count']==4)
        self.assertEqual(repeated['segments'][1],{'action':'read_file','count':2})
        self.assertEqual(mc2_fingerprints.members(self.conn,repeated['id'],q='missing')['total'],0)
        with self.assertRaises(HTTPException) as raised:
            mc2_fingerprints.members(self.conn,repeated['id'],data_version='old')
        self.assertEqual(raised.exception.status_code,409)

    def test_stale_sidecar_is_rejected_without_changing_source(self):
        mc2_fingerprints.build(self.path)
        self.conn.execute("UPDATE datasets SET data_version='new' WHERE dataset_id='MC2'");self.conn.commit()
        with self.assertRaises(HTTPException) as raised: mc2_fingerprints.patterns(self.conn)
        self.assertEqual(raised.exception.status_code,409)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM events').fetchone()[0],4)
