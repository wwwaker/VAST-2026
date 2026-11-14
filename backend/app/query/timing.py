"""Request-local diagnostics; no SQL or filter text is retained."""
from contextvars import ContextVar
import sqlite3
from time import perf_counter

request_metrics = ContextVar('mc2_request_metrics', default=None)


class TimedCursor(sqlite3.Cursor):
    def _measure(self, operation, *args, **kwargs):
        metrics = request_metrics.get()
        if metrics is None: return operation(*args, **kwargs)
        started = perf_counter()
        try: return operation(*args, **kwargs)
        finally: metrics['db_ms'] += (perf_counter() - started) * 1000

    def execute(self, *args, **kwargs): return self._measure(super().execute, *args, **kwargs)
    def executemany(self, *args, **kwargs): return self._measure(super().executemany, *args, **kwargs)
    def fetchone(self): return self._measure(super().fetchone)
    def fetchall(self): return self._measure(super().fetchall)
    def fetchmany(self, *args): return self._measure(super().fetchmany, *args)
    def __next__(self): return self._measure(super().__next__)


class TimedConnection(sqlite3.Connection):
    def execute(self, *args, **kwargs): return self.cursor(factory=TimedCursor).execute(*args, **kwargs)
    def executemany(self, *args, **kwargs): return self.cursor(factory=TimedCursor).executemany(*args, **kwargs)
