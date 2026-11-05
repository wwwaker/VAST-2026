# 多智能体系统异常行为调查工作区

面向 VAST Challenge 2026 MC1 / MC2 与自建工作流数据的可视分析原型。

一条完整调查路径：**选择数据集 → 建立概览基线 → 刷选异常时段 → 沿事件流下钻 → 核对原始记录**。
三套数据共用同一套筛选、联动与证据视图，各自的语义差异收敛在 manifest 里。

---

## 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Python | 3.11+ | 已验证 3.13.9 |
| Node.js | 20+ | 已验证 22.23.1 |
| SQLite | 3.35+ | Python 自带即可；需要 FTS5 与 JSON1 |

依赖：`fastapi`、`uvicorn`、`pydantic`（后端）；`react`、`vite`、`typescript`、`d3-scale`（前端）。

---

## 首次启动

```bash
# 1. 后端依赖
python -m pip install -r backend/requirements.txt

# 2. 导入数据（约 20 秒，生成 build/mas.db，约 340 MB，schema v2）
cd backend
python -m app.ingest.cli --all --fresh
cd ..

# 3. 前端构建
cd frontend
npm install
npm run build
cd ..

# 4. 启动（同时托管前端，只需一个进程）
cd backend
python -m uvicorn app.main:app --port 8000
```

打开 <http://127.0.0.1:8000>。

导入在同目录临时库中完整构建并校验，通过后才备份旧库并替换；出现 `FAIL` 时命令以非 0 退出，旧库保持不变，详细结果写入 `build/ingest-validation.json`。替换主库前必须先停止后端服务（Windows 文件锁）。

---

## 开发模式

前端热更新，后端另有进程，Vite 已配置 `/api` 代理到 8000：

```bash
cd backend && python -m uvicorn app.main:app --port 8000 --reload
cd frontend && npm run dev        # http://localhost:5173
```

---

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `python -m app.ingest.cli --all --fresh` | 全量重建数据库 |
| `python -m app.ingest.cli --dataset MC1` | 只重导一个数据集 |
| `python tools/bench_sqlite.py --dataset MC2` | SQLite 导入与查询基准 |
| `cd frontend && npm run check:ui -- http://127.0.0.1:8000` | 无头浏览器自检：布局、交互、键盘、截图、渲染基准、控制台错误 |
| `python tools/check_contrast.py --strict` | 双主题对比度验收（WCAG 2.1），有失败项时退出码非 0 |
| `curl http://127.0.0.1:8000/api/health` | 健康检查（含库大小） |

---

## 目录

```text
data/processed/          处理后数据（JSONL 事件表 + JSON 实体表 + labels.json）
backend/app/ingest/      manifest、adapter、导入命令行
backend/app/routers/     查询接口
frontend/src/            工作区前端（theme / state / components / views）
tools/bench_sqlite.py    SQLite 基准脚本
build/                   数据库与截图产物（不入库）
docs/                    计划书、数据适配规则、基准与接口说明
```

---

## 演示主线

三个数据集各有一条预置主线，全部定义在 `backend/app/ingest/manifest.py`，改完重启服务即生效。

| 数据集 | 主锚点 | 说明 |
| --- | --- | --- |
| MC1 | 17:25 首条确认帖（`first_confirm_post`） | 内部 agent 自己发的，可追到决策链；17:00 的第三方抢先发布仅作上下文 |
| MC2 | 11:21Z 目标帖子（`target_post`） | 官方口径 04:21 为本地时间 |
| CUSTOM | 无（按 `run_id` 选运行） | 32 次运行，标签区分 scenario 与 observed |

MC2 还在 manifest 里记录了**候选干预点**：`SwiftWren_further_instructions.md` 的任务接力环节。
界面以「候选干预点（待证据核验）」展示，提交约束要求最多选择一个位置，但数据尚未证明它是唯一入口。

---

## 数据与语义注意事项

- **时间契约 v2**：库内排序键为整数微秒 `time_sort_us`，窗口统一为半开区间 `[start_us, end_us)`；`time_sort_key` 只保留整数秒供按天/小时聚合。接口参数与响应都使用微秒。
- **统一筛选**：`backend/app/query/filters.py` 生成唯一的 WHERE；类别先由服务端字典映射再聚合，前端不再维护事件类型表。
- **MC1 时区未知**：源时间不做 UTC 换算，也不与其它数据集比较绝对时刻。界面会标注"源时区 未知"。
- **MC2 官方时间 04:21 是本地时间**，文件中对应 `2046-05-17T11:21:15Z`；锚点同时给出两种表述。
- **MC1 的 `responding_to` 有两种含义**：命中消息 ID 时生成 `reply_to` 边，是 `@提及`文本时生成 `mention` 边，界面上必须区分。
- **自建数据没有 `source_record_id`**，已回落为 `event_id` 并在界面标注。
- 标签的 `scenario`（流程配置）与 `observed`（是否实际观测到）分开呈现，不合并成一个"异常"标记。

更细的字段规则见 `docs/数据适配规则.md`。

---

## 已知限制

- 检索不做相关性排序，只按索引命中顺序返回。
- 调查笔记只能在本机查看，没有导出为报告或 Markdown 的功能。
- 对比度已按 WCAG 计算并通过，但未在真实投影仪上验收。
- 窄屏布局（1180 px 以下）未做真机验证。
- 服务为单进程、每请求一个只读连接，未做并发压测。
- 关系图支持 1–3 跳，默认 80 节点 / 300 边；任何裁剪都会返回具体原因。
- MC2 帖子正文不在数据集内，界面只能确认来源文件名，不能还原内容含义。
- CUSTOM 的运行级流程、配对审计与 MC1 决策泳道尚未实现（S2/S4），当前只有统一的日志浏览与筛选。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| `docs/项目计划书.md` | 项目定位、范围、里程碑、风险 |
| `docs/数据适配规则.md` | 字段映射与 16 条冲突规则（含实测数据） |
| `docs/SQLite基准报告.md` | 建库体积、查询延迟、索引决策 |
| `docs/后端接口说明.md` | 接口契约、实测延迟、性能陷阱 |
| `docs/前端骨架说明.md` | token 层、渲染决策、交互闭环、遗留项 |
| `docs/数据获取.md` | 数据不入库的原因、恢复步骤与校验基线 |
