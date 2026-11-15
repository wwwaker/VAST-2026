# 项目结构与保留能力

本轮从 `b1b3639` 清理旧 UI。正式页面只有 MC1、MC2、CUSTOM 三个新版，旧页面、旧工作区 Provider、旧全局样式和旧 UI 验收脚本已移除。旧页面源码可从该提交读取，无需在活动源码中再保存一份。

## 目录与依赖边界

```text
frontend/src/
  app/                         数据集导航、URL 和按需加载
  features/mc1/                MC1 页面、图表、数据展示规则
  features/mc2/                MC2 页面、组件、查询缓存、图布局
  features/custom/             CUSTOM 集合、运行、证据和 normal 对照
  shared/api/                  当前接口契约、筛选和 HTTP 基础能力
  shared/ui/                   ShadowRoot 容器、时间条、阅读控件等
  shared/hooks/                请求状态
  shared/styles/               新版公共样式与文档基础样式
  shared/types/                跨数据集类型
  compatibility/legacy-snapshots/  旧快照格式的纯转换与校验

backend/app/
  routers/                     HTTP 接口
  domain/mc1/                  消息、市场、上下文与先兆规则
  domain/mc2/                  关系、过程、文件、模式和系统背景
  domain/custom/               运行审计、投影和阶段规则
  domain/investigations/       预置案例、快照校验和导出
  projections/                 事件展示投影
  query/                       筛选、MC2 范围构造、查询计时
  storage/                     主库连接、笔记和案例存储
  ingest/                      导入和派生数据校验

datasets/                      完整数据 ZIP、逐文件哈希清单与恢复说明
tools/data_bundle.py           离线恢复、校验、打包与官方原始包下载
tools/tests/                   数据恢复及本地文件保护检查
```

`shared/` 不导入任何 `features/` 模块。当前应用不导入快照兼容层；该层暂不提供新版恢复入口。后端领域逻辑不从路由导入事件投影或 MC2 筛选函数。保留的领域算法和接口继续接受后端测试。

MC1、MC2、CUSTOM 的时间语义和调查状态各自维护；不把回复网络、文件关系和版本证据合成通用图表。MC2 的请求合并、独立取消、缓存、计时和刷新位置补偿继续保留。

## 数据分发

当前数据共 54 个文件、约 218.46 MiB；其中 MC2 源事件 JSONL 为 159.36 MiB，超过 GitHub 普通 Git 的 100 MiB 单文件上限。仓库改为保留约 16 MiB 的完整 ZIP 快照和逐文件 SHA-256 清单，解压后的 `/data/` 与生成的 `/build/` 继续忽略，无需拆分源文件或使用 Git LFS。

从根目录执行 `python tools/data_bundle.py restore` 后，再按原导入命令创建数据库。恢复不改写已有匹配文件，不覆盖不同内容，不访问笔记库，也不自动触发导入。ZIP 保留源文件原始字节，确保源哈希和 `event_locator.json` 字节偏移不变；更新数据后需同时更新视图与快照。

官方原始包的下载地址固定到提交并校验 SHA-256；原始格式尚不能替代项目标准化事件、CUSTOM 与派生视图。详细流程及可选远端快照恢复见 [数据分发说明](datasets/README.md)。数据准备独立于 `npm run build`，默认克隆后可离线恢复，前端构建不隐式访问网络或重建数据库。

## 新版保留能力清单

下列项目仅标记为**保留、待接入新版**，本轮不增加前端页面、菜单或按钮。后端保留不代表新版已提供该功能。

| 能力 | 当前保留位置／接口 | 后续复用边界 |
| --- | --- | --- |
| MC1 先兆候选 | `domain/mc1/rules.py`、`context.py`；`GET /api/mc1/context` | 保留规则、预期依据、候选引用和局限；候选不自动成为已确认结论 |
| 历史窗口基线比较 | `routers/compare.py`；`GET /api/compare` | 保留有效覆盖时长、速率、手选窗口和证据下钻；缺数据不解释成零活动 |
| MC2 单点干预论证 | `domain/mc2/patterns.py`；`GET /api/interventions` | 最多一个候选；观测覆盖不等于因果阻断或成功率 |
| MC2 系统背景 | `domain/mc2/system_map.py`；`GET /api/system-overview` 及成员接口 | 静态组织背景和当前事件关系分别解释 |
| MC2 操作转移 | `domain/mc2/transitions.py`；`GET /api/transitions` 及证据接口 | 保留双端筛选和低样本处理；相邻操作不表示因果 |
| 历史发布阶段摘要 | `domain/mc2/patterns.py`；`GET /api/patterns/file-posts` | 新版已有真实时间比较；仅考虑补充阶段摘要，文件名前缀仍只是线索 |
| 证据角色和结构化结论 | `storage/cases.py`、`routers/findings.py` | 保留支持／反证／待核实、主张、解释、局限和来源哈希 |
| 笔记 | `storage/notes.py`、`routers/notes.py` | 使用独立 `notes.db`；当前新版不后台加载笔记 |
| 用户案例及 Markdown／JSON 导出 | `domain/investigations/`、`routers/cases.py` | 保留已有数据和导出；CUSTOM 预置案例仍是当前功能 |
| 调查快照兼容 | 前端 `compatibility/legacy-snapshots/`、后端 `domain/investigations/snapshots.py` | 保留旧格式、版本、跨集和缺失引用校验；新版需单独设计序列化适配，不能直接套用旧 reducer |
| CUSTOM 阶段摘要与服务端配对校验 | `domain/custom/stages.py`、`GET /api/run-comparisons` | 新版当前使用完整运行投影；保留阶段规则和严格配对口径 |
| 回复关系分类 | MC1 当前消息上下文及 `routers/mc1.py` | 有效回复、未来引用、点名提及各自保留身份 |

旧前端的展示和交互参考位于 Git 提交 `b1b3639`：`EvidenceBasket.tsx`、`RestoreCaseButton.tsx`、`CompareView.tsx`、`LeadingIndicators.tsx`、`InterventionPanel.tsx` 等。复用业务口径，避免重新引入旧 Provider、旧页面和旧样式。

## 已退役与兼容方式

- `?mc1=legacy`、`?mc2=legacy`、`?custom=legacy` 旧书签打开对应新版并规范化 URL；不再渲染旧 UI。现有 `?mc1=reference` 等地址保持可用。
- `?bench=1` 旧图表基准入口退役；当前 MC2 计时与性能脚本保留。
- `/api/graph`、`/api/graph/evidence`、`/api/search` 退役。当前关系图使用专题关系接口，关键词继续走统一筛选，FTS 和索引保留。
- 原型导入基准 `tools/bench_sqlite.py`、旧主题对比度检查和旧页面 F 阶段脚本退役。
- `data/`、`build/mas.db`、`build/notes.db`、派生视图及 MC2 预计算库没有迁移或删除。领域模块的 CLI 名称变更见 README。

## 验证

前端代码规范、空行和注释要求见 [前端开发规范](frontend/CONTRIBUTING.md)。Prettier 管理排版；ESLint 检查独立声明、大括号、未使用项、Hook 依赖、类型导入及模块边界；EditorConfig 管理基本编码和缩进。

前端在 `frontend/` 运行：

```shell
npm run check:code
npm run build
npm run check:navigation
npm run check:snapshot-compatibility
npm run check:readability
npm run check:mc2-optimizations
npm run check:mc1 -- http://127.0.0.1:8000
npm run check:mc2 -- http://127.0.0.1:8000
npm run check:custom -- http://127.0.0.1:8000
```

后面三个检查需要真实后端；浏览器检查为 `check:mc2-browser`、`check:mc2-controls`、`check:readability-browser`。虚拟 DOM 检查不代替浏览器布局和输入验收。`check:mc1` 不再依赖第三方 clone 的文件。

后端在 `backend/` 运行 `python -m unittest discover -s tests -t . -q`。自动检查和开发服务器可用 `MAS_NOTES_DB` 指定临时笔记库，与用户笔记隔离。导入管线仍是 `python -m app.ingest.cli --all --fresh`，不应为代码清理重新导入数据。

### 本轮验证结果（2026-11-15）

| 检查 | 结果 |
| --- | --- |
| Prettier、ESLint（零警告）及 TypeScript 规范检查 | 通过 |
| TypeScript 与生产构建 | 通过 |
| 数据集导航、旧书签、应用依赖边界 | 通过 |
| 快照兼容 | 58 项通过 |
| 可读性／MC2 优化回归 | 20／25 项通过 |
| 真实 API 配合虚拟 DOM：MC1／MC2／CUSTOM | 20／113／78 项通过 |
| Chromium：MC2 研究工具／控件／跨数据集可读性 | 18／19／95 项通过，无页面 JavaScript 错误 |
| 后端单元与接口检查 | 194 项通过 |
| 领域模块及事件投影不依赖路由 | 通过 |
| Git 差异空白检查 | 通过 |
| 数据分发脚本 | 13 项通过；54 个快照文件逐一哈希校验通过 |
| 从快照恢复后导入独立数据库 | 通过；三套数据事件数 912／185,147／1,103，含 MC2 预计算 |
| 官方固定版本 MC1／MC2 下载 | 两个 ZIP 大小及 SHA-256 一致 |

浏览器检查覆盖 1440、1920、768 像素宽度，选择菜单另覆盖 390 像素。时间范围检查使用当前图元坐标，并按原生滑块的毫秒步长比较接口的微秒终点，保留端点拖动、选区平移与底层计数不变的断言。

后端原有 195 项检查，本轮随通用图接口删除 3 项，增加 2 项当前／保留／退役接口契约检查，成为 194 项。

前端源文件从 118 个减少到 78 个。全量格式化、展开声明与 JSX 并补充必要注释后，当前为 29,370 行；行数包含排版变化，不作为清理量指标。Vite 入口 JS 从 439.47 kB 缩减为 145.45 kB（gzip 146.29 → 47.13 kB），三个工作区改为独立按需加载；图表依赖仍在相应工作区加载。

规范化整理覆盖 94 个前端文件，其中包括 76 个现有源文件、10 个检查脚本、页面 HTML、包清单与锁文件，以及新增的 5 个规范文档／配置。功能检查、浏览器检查与生产构建均已在整理后重新运行。69 个可执行源模块中，59 个经语法结构归一化比对为排版及等价结构变化；其余 10 个的未使用项清理、控制流展开与稳定依赖调整经人工复核及行为回归验证。
