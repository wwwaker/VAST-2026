"""FastAPI 应用入口。

开发时前端跑 Vite（5173），通过代理访问 8000；
构建后由本服务直接托管 frontend/dist，现场演示只需一个进程。
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import DB_PATH, FRONTEND_DIST
from .notes_store import ensure_schema as ensure_notes_schema
from .routers import compare, datasets, entities, events, graph, notes, search

app = FastAPI(
    title="多智能体系统异常行为调查 API",
    version="0.2.0",
    description="VAST 2026 MC1 / MC2 / 自建数据集的统一查询接口",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

app.include_router(datasets.router)
app.include_router(events.router)
app.include_router(entities.router)
app.include_router(graph.router)
app.include_router(compare.router)
app.include_router(notes.router)
app.include_router(search.router)

# 笔记存在独立的库文件里，启动时建表即可，与数据导入互不影响
ensure_notes_schema()


@app.get("/api/health")
def health():
    return {
        "status": "ok" if os.path.exists(DB_PATH) else "missing_db",
        "db": DB_PATH,
        "db_size_mb": round(os.path.getsize(DB_PATH) / 1024 / 1024, 1) if os.path.exists(DB_PATH) else 0,
    }


if os.path.isdir(FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
