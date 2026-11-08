# 多智能体系统异常行为调查工作区

面向 VAST Challenge 2026 MC1 / MC2 与自建工作流数据的可视分析原型。

一条完整调查路径：**选择数据集 → 建立概览基线 → 刷选异常时段 → 沿事件流下钻 → 核对原始记录**。
三套数据共用同一套筛选、联动与证据视图，各自的语义差异收敛在 manifest 里。

**当前开发方向（2026-11-08）**：以本地参考项目的 MC1 界面为模板，直接复用热力图、事件轨、网络和点击详情；MC2 与自建数据沿用同一页面骨架。继续使用现有 SQLite/FastAPI、状态与快照基础。旧四任务导航重构计划已归档，不再作为开发门槛。

**F1 已完成（未提交）**：MC1 默认页改为参考风格单页（角色活动热力图 → 点格读消息 → 事件轨/回复网络），新增 `/api/mc1/reply-network`；`data/` 已合并为唯一数据根（`data/process/`）。两轮独立复核的 9 项问题（点格/节点扩窗、渠道按钮不同源、事件轨静默截断与补入越权、轨点击无结果、键盘关闭与焦点、旧脚本断言降级）已修复并补断言，见 [F1 修复复验](docs/current/交接/F1-修复复验.md)。分支 `codex/reference-ui`。F2–F4 未开始。

F1 数据与功能经 [第三次独立复核](docs/current/交接/F1-三次复核记录.md) 通过；用户随后要求去除 MC1 的旧导航与重复界面。新会话从 [文档入口](docs/README.md) 阅读，**先执行 [MC1 收尾清理](docs/current/MC1收尾清理提示词.md)，完成后再用 [F2 MC2 提示词](docs/current/第二阶段提示词-F2-MC2参考界面.md)**，不把未清理的旧壳复制到 MC2。

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

已有 `build/mas.db` 的本地项目进行 UI 开发时，先检查 `/api/health` 与当前数据版本，通常只需构建前端并启动服务，**不执行下面的全量导入**。当前主库代码使用 schema v3；UI 快照版本与主库版本分别管理。

```bash
# 1. 后端依赖
python -m pip install -r backend/requirements.txt

# 2. 仅首次缺少数据库时导入数据（生成 build/mas.db，schema v3）
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
| `python tools/bench_api.py --base http://127.0.0.1:8000` | API 性能基准（预热 3 / 采样 30），写 `build/api-bench-v2.json` |
| `python tools/audit_mc2_content.py` | MC2 内容可用性审计，写 `build/mc2-content-audit.json` |
| `cd frontend && npm run check:ui -- http://127.0.0.1:8000` | 既有浏览器回归；新页面需适配入口并保留业务断言，输出到 build/ |
| `cd frontend && npm run check:reference -- http://127.0.0.1:8021` | F1 MC1 参考界面检查（联动、尺寸、主题、MC2/CUSTOM 入口），写 `build/reference-ui/F1/` |
| `cd frontend && npm run check:regression -- http://127.0.0.1:8021` | MC2 来源链/系统背景与 CUSTOM 运行入口的最小回归 |
| `python tools/check_contrast.py --strict` | 双主题对比度验收（WCAG 2.1），有失败项时退出码非 0 |
| `curl http://127.0.0.1:8000/api/health` | 健康检查（含库大小） |

---

## 目录

```text
data/process/            标准数据（JSONL 事件表 + JSON 实体表 + labels.json）与派生 views/、analysis/
backend/app/ingest/      manifest、adapter、导入命令行
backend/app/domain/      类型字典、CUSTOM 审计规则、MC2 文件与来源链
backend/app/routers/     查询接口
frontend/src/            工作区前端（theme / state / components / views）
frontend/src/views/mc2/  来源链、文件轨迹、转移矩阵（仅 MC2）
frontend/src/views/mc1/  MC1 参考单页（热力图、事件轨、回复网络、消息详情、先兆候选）
tools/                   基准脚本、对比度检查、MC2 内容审计、API 基准
build/                   数据库与截图产物（不入库）
docs/current/            当前范围、参考界面计划、验收和 F1 提示词
docs/reference/          数据适配、恢复、后端接口与历史 SQLite 基准
docs/archive/            原 UI 计划、S0/S1 交接与复核历史（不再执行）
```

---

## 演示主线

三个数据集各有一条预置主线，全部定义在 `backend/app/ingest/manifest.py`，改完重启服务即生效。

| 数据集 | 主锚点 | 说明 |
| --- | --- | --- |
| MC1 | 17:25 首条确认帖（`first_confirm_post`） | 内部 agent 自己发的，可追到决策链；17:00 的第三方抢先发布仅作上下文 |
| MC2 | 11:21Z 目标帖子（`target_post`） | 官方口径 04:21 为本地时间；「关系图 → 系统背景」把 15,538 个实体聚合成 9 组并高亮当前事件参与者；「来源链」下分目标链 / 历史实例 / 干预论证三段，三份 `*_further_instructions.md` 的接力都在发布前 2 秒 |
| CUSTOM | 五条冻结案例（`backend/app/cases/custom.json`） | 32 次运行；案例冻结了 run_id、对照与期望审计值，数据版本变化时整组标 stale |

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

更细的字段规则见 [数据适配规则](docs/reference/数据适配规则.md)。

---

## 已知限制

- 检索不做相关性排序，只按索引命中顺序返回。
- 调查笔记与结论只保存在本机 `build/notes.db`；案例可导出 Markdown/JSON，但报告里的截图仍需手工插入。
- 对比度已按 WCAG 计算并通过；真实投影仪验收本轮暂不要求。
- 窄屏布局（1180 px 以下）未做真机验证；本轮暂不要求。
- 服务为单进程、每请求一个只读连接；并发压测本轮暂不要求。
- 关系图支持 1–3 跳，默认 80 节点 / 300 边；任何裁剪都会返回具体原因。
- MC2 帖子正文不在数据集内（官方包也没有文件附件）：来源链能确认“来源文件 + 文件操作”，内容状态显示 `metadata_only`，不能还原正文含义。可核查的字段差异是：108 条 `saidit_post` 里 105 条带标题级 `content`，三条异常帖没有。
- CUSTOM 已有运行列表、单次流程泳道、审计重算、配对比较与五条冻结案例；案例可另存为用户案例并导出 Markdown/JSON。
- MC1 已有回复分类、7 agent 活动矩阵、决策泳道与先兆候选。`reply_future_reference`（174 条）保留原始关系但默认不进入历史传播主链；环境叙事与人工标记单独标注 `provenanceKind`，同轮共现不改称因果。没有制度依据的“发布前审核”规则显示“待确认预期”，不生成候选。
- MC2 已有系统背景地图、历史实例阶段对齐、单点干预论证与操作转移矩阵。矩阵只给支持对数与 actor 数；**未实现 actor 校正前不展示 lift/倍数**，同执行者相邻操作不表示因果。干预位置只有一个候选，不宣称是唯一入口。
- 基线比较支持“自动前一窗 / 手选历史窗（UTC）”，下钻返回会恢复原窗口与手选窗；同角色群组对照尚未实现，不能把“按主体”当成“同角色”。
- 当前代码在 `d816b19` 之后包含 F1 的 MC1 参考界面（分支 `codex/reference-ui`，未提交）。MC2/CUSTOM 仍是原页面，F2 才换外壳。S1 历史复核针对当时版本，不自动覆盖后续修改；实际草稿/证据/状态问题仍需验证。历史见 [存档目录](docs/archive/README.md)。
- 性能数字来自本机单用户顺序请求（预热 3 次、采样 30 次），`build/api-bench-v2.json` 中冷启动与缓存命中分开记录；不代表新界面实测。用户走查、并发、投影仪与真机触屏未验证，不写完成率或可用性结论。新路线的浏览器尺寸/截图门槛见 [验收与交接](docs/current/验收与交接.md)。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档入口](docs/README.md) | 阅读顺序、有效性与维护规则 |
| [项目范围与比赛要求](docs/current/项目范围与比赛要求.md) | 当前产品方向、比赛问题、数据约束与工程基线 |
| [参考界面实施计划](docs/current/参考界面实施计划.md) | MC1 直接复用、MC2/CUSTOM 模板适配、F1–F4 与 Git 策略 |
| [验收与交接](docs/current/验收与交接.md) | 真实联动、数据/草稿/快照、截图与回归门槛 |
| [第一阶段 F1 提示词](docs/current/第一阶段提示词-F1-MC1参考界面.md) | 可直接交给新会话实施 MC1 页面 |
| [第二阶段 F2 提示词](docs/current/第二阶段提示词-F2-MC2参考界面.md) | 当前下一阶段：复用 F1 模板交付 MC2，含背景、理念、实施边界和验收 |
| [数据适配规则](docs/reference/数据适配规则.md) | 字段映射、时区、引用与标签含义 |
| [后端接口说明](docs/reference/后端接口说明.md) | 接口契约、快照和查询基础 |
| [数据获取](docs/reference/数据获取.md) | 本地数据恢复及校验 |
| [SQLite基准报告](docs/reference/SQLite基准报告.md) | 历史测量与索引决策 |
| [历史存档及路径迁移](docs/archive/README.md) | 原计划/提示词/复核，保留原始结论、不再作为执行指令 |
