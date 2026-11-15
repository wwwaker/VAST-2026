"""Versioned exact full-history file sequences; never prefix candidates."""
import argparse
import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from fastapi import HTTPException
from app.domain.mc2.cache import database_identity
from app.query.timing import TimedConnection

VERSION = 1


def identity(conn):
    return json.dumps([VERSION, database_identity(conn)], ensure_ascii=False)


def sidecar(source):
    return str(source) + '.mc2-patterns.sqlite'


def build(source):
    source = os.path.abspath(source)
    target = sidecar(source)
    temporary = target + '.' + uuid.uuid4().hex + '.tmp'
    started = time.perf_counter()
    origin = sqlite3.connect('file:' + source + '?mode=ro', uri=True)
    origin.row_factory = sqlite3.Row
    dest = None
    try:
        origin.execute('BEGIN')
        stamp = identity(origin)
        dest = sqlite3.connect(temporary)
        dest.executescript('''CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE patterns(id TEXT PRIMARY KEY,sequence TEXT,segments TEXT,file_count INTEGER,action_count INTEGER);
            CREATE TABLE members(file_id TEXT PRIMARY KEY,path TEXT,pattern_id TEXT,event_count INTEGER,first_us INTEGER,last_us INTEGER);
            CREATE INDEX member_pattern ON members(pattern_id,path,file_id);
            CREATE TABLE events(file_id TEXT,event_id TEXT,action TEXT,time_us INTEGER,PRIMARY KEY(file_id,event_id));''')
        rows = origin.execute("SELECT DISTINCT r.dst_id file_id,COALESCE(en.source_value,en.label,r.dst_id) path,e.event_id,e.event_type,e.time_sort_us "
            "FROM relations r JOIN events e ON e.dataset_id=r.dataset_id AND e.event_id=r.event_id "
            "LEFT JOIN entities en ON en.dataset_id=r.dataset_id AND en.entity_id=r.dst_id "
            "WHERE r.dataset_id='MC2' AND r.relation IN ('file_path','queued_file_path','post_content_source') "
            "AND r.target_kind='entity' ORDER BY r.dst_id,e.time_sort_us,e.event_id")
        groups, sequence, current, path, times = {}, [], None, None, []
        count = 0
        def consume():
            nonlocal count
            if current is None: return
            packed = json.dumps(sequence, separators=(',', ':'))
            key = hashlib.sha256(packed.encode()).hexdigest()
            if key not in groups:
                segments = []
                for action in sequence:
                    if segments and segments[-1]['action'] == action: segments[-1]['count'] += 1
                    else: segments.append({'action': action, 'count': 1})
                groups[key] = [packed, json.dumps(segments), 0, len(sequence)]
            groups[key][2] += 1
            dest.execute('INSERT INTO members VALUES(?,?,?,?,?,?)', (current, path, key, len(sequence), times[0], times[-1]))
            count += 1
        for row in rows:
            if row['file_id'] != current:
                consume(); current, path, sequence, times = row['file_id'], row['path'], [], []
            sequence.append(row['event_type']); times.append(row['time_sort_us'])
            dest.execute('INSERT INTO events VALUES(?,?,?,?)', (current, row['event_id'], row['event_type'], row['time_sort_us']))
        consume()
        dest.executemany('INSERT INTO patterns VALUES(?,?,?,?,?)', [(key, *value) for key, value in groups.items()])
        dest.executemany('INSERT INTO metadata VALUES(?,?)', [('identity', stamp), ('semantic_version', str(VERSION)), ('file_total', str(count))])
        if sum(v[2] for v in groups.values()) != count: raise RuntimeError('文件模式成员计数不守恒')
        dest.commit(); dest.close(); dest = None
        if stamp != identity(origin): raise RuntimeError('构建期间源数据发生变化')
        os.replace(temporary, target)
        return {'file_total': count, 'pattern_total': len(groups), 'seconds': time.perf_counter() - started, 'path': target}
    finally:
        origin.close()
        if dest: dest.close()
        if os.path.exists(temporary): os.remove(temporary)


@contextmanager
def read(conn):
    path = conn.execute('PRAGMA database_list').fetchone()[2]
    if not os.path.isfile(sidecar(path)):
        raise HTTPException(503, '全历史文件模式尚未预处理，请构建精确模式后重试')
    store = sqlite3.connect('file:' + sidecar(path) + '?mode=ro', uri=True, factory=TimedConnection)
    store.row_factory = sqlite3.Row
    try:
        stamp = store.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
        if not stamp or stamp[0] != identity(conn):
            raise HTTPException(409, '文件模式的数据版本已变化，请重新构建')
        yield store
    finally:
        store.close()


def patterns(conn, offset=0, sort='files'):
    with read(conn) as store:
        rows = store.execute('SELECT * FROM patterns ORDER BY ' + ('file_count DESC' if sort == 'files' else 'action_count DESC') + ',id LIMIT 20 OFFSET ?', (offset,))
        items = [{**dict(r), 'sequence': json.loads(r['sequence']), 'segments': json.loads(r['segments'])} for r in rows]
        return {'items': items, 'total': store.execute('SELECT COUNT(*) FROM patterns').fetchone()[0],
                'file_total': store.execute('SELECT COUNT(*) FROM members').fetchone()[0],
                'scale_max': store.execute('SELECT MAX(file_count) FROM patterns').fetchone()[0],
                'data_version': hashlib.sha256(identity(conn).encode()).hexdigest(), 'semantic_version': VERSION, 'offset': offset, 'scope': 'full-history-exact'}


def members(conn, pattern_id, offset=0, q='', data_version=None):
    from app.domain.mc2.files import content_status
    with read(conn) as store:
        version = hashlib.sha256(identity(conn).encode()).hexdigest()
        if data_version and version != data_version:
            raise HTTPException(409, '文件模式的选择版本已失效，请返回模式列表重新选择')
        if store.execute('SELECT 1 FROM patterns WHERE id=?', (pattern_id,)).fetchone() is None:
            raise HTTPException(404, '精确模式不存在')
        where = 'pattern_id=? AND instr(lower(path),lower(?))>0'
        total = store.execute('SELECT COUNT(*) FROM members WHERE ' + where, (pattern_id, q)).fetchone()[0]
        items = [dict(r) for r in store.execute('SELECT * FROM members WHERE ' + where + ' ORDER BY path,file_id LIMIT 12 OFFSET ?', (pattern_id, q, offset))]
        for item in items:
            info = content_status(conn, 'MC2', item['file_id'])
            item.update(content_status=info['content_status'], content_note=info['reason'])
        return {'items': items, 'total': total, 'offset': offset, 'pattern_id': pattern_id,
                'data_version': version}


if __name__ == '__main__':
    from app.config import DB_PATH
    parser = argparse.ArgumentParser(description='Build exact MC2 full-history file fingerprints')
    parser.add_argument('--db', default=DB_PATH)
    print(json.dumps(build(parser.parse_args().db), ensure_ascii=False))
