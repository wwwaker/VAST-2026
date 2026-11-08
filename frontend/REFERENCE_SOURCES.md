# 前端参考来源登记（MC1 参考界面）

更新：2026-11-07（F1）。记录 MC1 页面实际借鉴/改编的参考文件、改动范围和没有照搬的部分。
参考工程是本地 clone，被 Git 忽略，构建**不**在运行时导入它。

## 参考工程

| 项 | 值 |
| --- | --- |
| 本地路径 | `D:\Project\class\VS\VAST_Challenge_2026-main` |
| 上游 | <https://github.com/wwwaker/VAST-2026.git>（clone 的 origin） |
| 使用日期 | 2026-11-07 |
| 许可 | 仓库代码本身未声明许可证；`README.md` 的 CC-BY 4.0 仅针对 Twemoji 图标（`agentIcons.jsx`），本次未复制该文件 |

## 实际改组件的文件

| 参考源（参考工程内路径） | 主工程落点 | 复用了什么 | 改动 |
| --- | --- | --- | --- |
| `frontend/src/main.jsx`（热力图区块，约 818–879 行） | `frontend/src/views/mc1/Mc1Heatmap.tsx` | 行=角色、列=时间桶的 DOM 网格；固定列宽（按天/小时切换）；左侧 sticky 角色列；列头事件标记点；点格查看成员 | 改为 TSX + 本工程 tokens；数据取自 `/api/mc1/activity`（agent × bucket、public/internal 分列计数），不再有 `bert_sentiment_score` 着色；移除 Shift 隐式改筛选，改为“读取该格消息 + 显式设为筛选按钮” |
| `frontend/src/main.jsx`（顶部 global-controls，约 625–647 行） | `Mc1ReferencePage.tsx` 顶部控制条 | 图表显隐复选、并排开关、筛选面板开关、清空筛选的排列与语义 | 用带 `aria-pressed` 的按钮替代 checkbox；`并排` 用 `.mc1-columns.is-side-by-side` 实现；图表显隐状态为页面局部 state，不再有第二份时间/选择真值 |
| `frontend/src/components/SequentialFlow.jsx` | `frontend/src/views/mc1/Mc1EventTrack.tsx` | 与热力图共用列宽/列起点的事件轨；上轨道弧线式的分层思路；图例与“点事件读消息” | 参考的 `SEQ_EVENTS/SEQ_EDGES` 是硬编码分析标记，未使用；改用 `/api/mc1/context` 的 environment/constraints/messages/releases/markers；列内按真实时间比例定位，横向滚动与热力图双向同步 |
| `frontend/src/components/messagePanels.jsx` | `frontend/src/views/mc1/Mc1MessageList.tsx` | `.detail-card` 可折叠骨架、消息列表行（时间/actor/渠道/徽章/摘要）、展开后阅读正文、节点/边消息面板的分区 | 改为 TSX；正文与内部审议来自 `/api/events/{id}` 的 `outgoing_text` / `deliberation`；增加原始字段表（event_id、source_record_id、源时间、来源定位）与“在证据面板查看”动作；去掉参考的 `commIdMap` 编号映射 |
| `frontend/src/network.jsx` | `frontend/src/views/mc1/Mc1Network.tsx` | 节点半径随消息数增长、边宽随权重增长、平行边偏移、mention 虚线、节点/边点击读消息的交互 | 参考的 `NP` 硬编码坐标与 d3-force 未照搬（改用固定环形布局）；数据来自新增 `/api/mc1/reply-network`（reply_to 上卷 + mention），按 reply_valid / reply_future_reference / mention 分色；不使用参考的 channel 配色，改用 tokens |
| `frontend/src/style.css` | `frontend/src/styles/app.css` 末尾 `/* MC1 参考风格单页（F1） */` 段 | 卡片间距、`compare-row` 式并排、`heatmap-grid` 网格、折叠摘要等布局套路 | 不复制字面颜色（参考是单一暗色）；全部走 `theme/tokens.css` 变量，浅/深主题共用 |

## 明确没有照搬

| 参考内容 | 原因 |
| --- | --- |
| `components/CrisisTimeline.jsx` 的双滑块 + 1s 定时器 | 主工程已有 `TimeBrush` + reducer 的 `cursorUs/masking` 作唯一回放真值；再引入一份会形成两套时间。参考的时间条外观由本页列头/锚点行承担 |
| `components/StockSentimentLineChart.jsx` | 参考用 `bert_sentiment_score` 等派生分数；本工程没有可追溯的情绪序列接口，按计划省略该图与开关（见 F1 报告“省略项”） |
| `agentIcons.jsx`（Twemoji，CC-BY 4.0） | 本次不需要头像图标；如后续使用需保留 CC-BY 4.0 署名 |
| `NP` 预设节点坐标、`SEQ_EVENTS/SEQ_EDGES` 硬编码 | 是参考数据集的分析结论，不能替代当前数据证据 |
| `lucide-react` 图标依赖 | 现有按钮/文本足够表达，未新增依赖 |
| Neo4j / `/api/heatmap` 等参考后端 | 继续使用本工程 FastAPI + SQLite；只在缺口处新增最小聚合接口 |

## 构建与依赖

- 参考目录不在构建路径中：所有借用代码已改写进 `frontend/src`，`vite build` 不读取 `VAST_Challenge_2026-main/`。
- 未新增第三方依赖；`package.json` 依赖与 F1 前一致（`react`、`react-dom`、`d3-scale/array/force`）。
- 新增的后端聚合接口与口径见 `docs/current/交接/F1-交接报告.md` 与 `backend/app/routers/mc1.py` 顶部注释。
