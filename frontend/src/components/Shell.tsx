import { CHAPTERS, useWorkspace, type DatasetId } from "../state/workspace";
import { useTheme, type ThemeMode } from "../theme/theme";

const QUESTIONS: Record<DatasetId, string> = {
  MC1: "2046-06-05 18:00 解禁前，并购消息为何已出现在 FleX？是蓄意泄露还是系统失效？",
  MC2: "2046-05-17 04:21 的乱码帖子如何产生？内容来自哪里，此前是否发生过？",
  CUSTOM: "32 次工作流运行中，审批绕过与旧版本传播分别在哪些事件上留下证据？",
};

export function TopBar({
  showBench,
  onToggleBench,
}: {
  showBench: boolean;
  onToggleBench: () => void;
}) {
  const { dataset, setDataset, filters, setFilters } = useWorkspace();
  const { mode, setMode, reducedMotion, setReducedMotion } = useTheme();

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <strong>多智能体系统调查工作区</strong>
          <span className="brand-sub">VAST 2026 MC1 / MC2 / 自建</span>
        </div>
      </div>

      <label className="field">
        <span>数据集</span>
        <select value={dataset} onChange={(e) => setDataset(e.target.value as DatasetId)}>
          <option value="MC1">MC1 · 危机沟通</option>
          <option value="MC2">MC2 · 内部系统活动</option>
          <option value="CUSTOM">自建 · 工作流审计</option>
        </select>
      </label>

      <label className="field grow">
        <span>关键词</span>
        <input
          type="search"
          placeholder="消息正文 / 主题 / 摘要"
          value={filters.keyword}
          onChange={(e) => setFilters({ keyword: e.target.value })}
        />
      </label>

      <label className="field">
        <span>主题</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as ThemeMode)}>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={reducedMotion}
          onChange={(e) => setReducedMotion(e.target.checked)}
        />
        <span>减少动效</span>
      </label>

      <button type="button" className={`btn${showBench ? " btn-active" : ""}`} onClick={onToggleBench}>
        {showBench ? "返回调查" : "渲染基准"}
      </button>
    </header>
  );
}

export function QuestionBar() {
  const { dataset } = useWorkspace();
  return (
    <div className="question-bar">
      <span className="question-tag">{dataset}</span>
      <p>{QUESTIONS[dataset]}</p>
    </div>
  );
}

/** 章节只切换"当前看哪个切面"，不清空筛选与笔记 */
const CHAPTER_VIEW: Record<string, "timeline" | "graph" | "compare"> = {
  overview: "timeline",
  trace: "graph",
  compare: "compare",
  evidence: "timeline",
};

export function ChapterNav() {
  const { chapter, setChapter, setCanvasView, setEvidenceOpen } = useWorkspace();
  return (
    <nav className="chapters" aria-label="案例章节">
      <p className="chapters-title">讲解顺序</p>
      {CHAPTERS.map((c) => (
        <button
          key={c.key}
          type="button"
          className={`chapter${chapter === c.key ? " chapter-active" : ""}`}
          onClick={() => {
            setChapter(c.key);
            setCanvasView(CHAPTER_VIEW[c.key] ?? "timeline");
            if (c.key === "evidence") setEvidenceOpen(true);
          }}
          aria-current={chapter === c.key ? "step" : undefined}
          title={c.hint}
        >
          <span className="chapter-name">{c.label}</span>
          <span className="chapter-hint">{c.hint}</span>
        </button>
      ))}
      <button
        type="button"
        className={`chapter chapter-free${chapter === null ? " chapter-active" : ""}`}
        onClick={() => setChapter(null)}
      >
        <span className="chapter-name">自由探索</span>
        <span className="chapter-hint">保留当前筛选与选择</span>
      </button>
      <p className="chapters-note">
        切换章节只改变筛选与时间窗，主画布始终是同一个工作区，笔记不会清空。
      </p>
    </nav>
  );
}

export function StatusBar() {
  const { modeLabel, filterSummary, clearFilters, notes, addNote, filters } = useWorkspace();

  return (
    <footer className="statusbar">
      <span className={`mode-chip${filters.from == null ? "" : " mode-chip-active"}`}>{modeLabel}</span>
      <span className="status-summary">{filterSummary}</span>
      <div className="status-actions">
        <button type="button" className="btn btn-quiet" onClick={clearFilters}>
          清空筛选
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => addNote(`筛选快照：${filterSummary}`)}
        >
          保存证据 {notes.length > 0 && <span className="badge">{notes.length}</span>}
        </button>
      </div>
    </footer>
  );
}
