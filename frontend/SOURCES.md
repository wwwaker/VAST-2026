# 新版界面来源

MC1 的布局、网络、消息面板、时间条及人工事件序列最初由本地 `VAST_Challenge_2026-main/frontend/src` 迁入（提交 `ef85295`）。当前代码在 `src/features/mc1/`；共享样式和控件在 `src/shared/`，MC2 和 CUSTOM 复用这些共享基础。

构建与检查均不需要第三方 clone。来源目录只是本地参考资料，不属于运行依赖。

- `features/mc1/components/AgentIcon.jsx` 中的 Twemoji 图形保留原署名：Copyright Twitter, Inc and other contributors，图形使用 [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)；来源为 [Twemoji](https://github.com/jdecked/twemoji)。
- 人工整理的 `SEQ_EVENTS`、`SEQ_EDGES` 与事件标记是分析注释，不能解释为原始日志自动发现的事实。界面继续标注人工分析及来源消息。
- 股价和市场标签取自原始 `market_snapshot`；消息情绪来自词典计分派生数据，未执行 BERT 推理。
- 第一轮参考风格旧页面的历史实现保留在 Git `b1b3639` 及之前，已退出活动源码。
