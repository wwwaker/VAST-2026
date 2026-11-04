"""路径与运行期配置。"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(ROOT, "data", "processed")
BUILD_DIR = os.path.join(ROOT, "build")
DB_PATH = os.environ.get("MAS_DB", os.path.join(BUILD_DIR, "mas.db"))
FRONTEND_DIST = os.path.join(ROOT, "frontend", "dist")
IMPORT_VERSION = "1.0"

os.makedirs(BUILD_DIR, exist_ok=True)
