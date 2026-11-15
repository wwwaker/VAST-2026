"""Bounded process cache for MC2 projections; identical concurrent reads share work."""
from collections import OrderedDict
from concurrent.futures import Future
import json
import os
from threading import Lock
from time import monotonic

from app.storage.database import require_dataset

_entries = OrderedDict()
_pending = {}
_lock = Lock()
_TTL = 120
_MAX_ENTRIES = 32
_MAX_BYTES = 8 * 1024 * 1024
_bytes = 0


def database_identity(conn):
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    def stamp(filename, wal=False):
        try:
            stat = os.stat(filename)
            # SQLite recreates an empty WAL for read connections. It has no
            # committed data and must not invalidate every cache hit.
            if wal and stat.st_size <= 32:
                return None
            return stat.st_ino, stat.st_mtime_ns, stat.st_size
        except FileNotFoundError:
            return None
    dataset = require_dataset(conn, "MC2")
    return (path, stamp(path), stamp(path + "-wal", wal=True), dataset["data_version"], dataset["schema_version"])


def clear_cache():
    global _bytes
    with _lock:
        _entries.clear()
        _bytes = 0


def cached(conn, key, compute):
    global _bytes
    key = (database_identity(conn), key)
    with _lock:
        now = monotonic()
        for expired in [k for k, (until, _, _) in _entries.items() if until <= now]:
            _bytes -= _entries.pop(expired)[1]
        if key in _entries:
            _entries.move_to_end(key)
            return _entries[key][2]
        future = _pending.get(key)
        owner = future is None
        if owner:
            future = _pending[key] = Future()
    if not owner:
        return future.result()
    try:
        payload = compute()
        size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        with _lock:
            if size <= _MAX_BYTES:
                while _entries and (len(_entries) >= _MAX_ENTRIES or _bytes + size > _MAX_BYTES):
                    _bytes -= _entries.popitem(last=False)[1][1]
                _entries[key] = (monotonic() + _TTL, size, payload)
                _bytes += size
        future.set_result(payload)
        return payload
    except BaseException as error:
        future.set_exception(error)
        raise
    finally:
        with _lock:
            _pending.pop(key, None)
