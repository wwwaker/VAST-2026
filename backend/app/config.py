"""路径与运行期配置。"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(ROOT, "data", "processed")
BUILD_DIR = os.path.join(ROOT, "build")
DB_PATH = os.environ.get("MAS_DB", os.path.join(BUILD_DIR, "mas.db"))
# 人工笔记单独存放：mas.db 会被 --fresh 整体删除
NOTES_DB = os.environ.get("MAS_NOTES_DB", os.path.join(BUILD_DIR, "notes.db"))
FRONTEND_DIST = os.path.join(ROOT, "frontend", "dist")
IMPORT_VERSION = "1.0"

os.makedirs(BUILD_DIR, exist_ok=True)
