import { useEffect, useRef, useState } from "react";
import { useWorkspace, type DatasetId } from "../state/workspace";
import { useTheme, type ThemeMode } from "../theme/theme";

const QUESTIONS: Record<DatasetId, string> = {
  MC1: "2046-06-05 18:00 解禁前，并购消息为何已出现在 FleX？是蓄意泄露还是系统失效？",
  MC2: "2046-05-17 04:21 的乱码帖子如何产生？内容来自哪里，此前是否发生过？",
  CUSTOM: "32 次工作流运行中，审批绕过与旧版本传播分别在哪些事件上留下证据？",
};

export function TopBar({
  showBench,
  onToggleBench,
  onShowHelp,
  evidenceOpen,
  onToggleEvidence,
  eventOpen,
  onToggleEvent,
}: {
  showBench: boolean;
  onToggleBench: () => void;
  onShowHelp: () => void;
  evidenceOpen: boolean;
  onToggleEvidence: () => void;
  eventOpen: boolean;
  onToggleEvent: () => void;
}) {
  const { dataset, setDataset, filters, setFilters } = useWorkspace();
  const { mode, setMode, reducedMotion, setReducedMotion } = useTheme();
  const [showDatasetHint, setShowDatasetHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleDatasetHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setShowDatasetHint(true), 1000);
  };
  const hideDatasetHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = null;
    setShowDatasetHint(false);
  };
  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <strong>多智能体系统调查工作区</strong>
          <span className="brand-sub">VAST 2026 MC1 / MC2 / 自建</span>
        </div>
      </div>

      <label
        className={`field dataset-field${showDatasetHint ? " dataset-field-hint-open" : ""}`}
        onMouseEnter={scheduleDatasetHint}
        onMouseLeave={hideDatasetHint}
        onFocus={scheduleDatasetHint}
        onBlur={hideDatasetHint}
      >
        <span>数据集</span>
        <select
          value={dataset}
          aria-describedby={showDatasetHint ? "dataset-question-hint" : undefined}
          onChange={(e) => {
            setDataset(e.target.value as DatasetId);
            hideDatasetHint();
          }}
        >
          <option value="MC1">MC1 · 危机沟通</option>
          <option value="MC2">MC2 · 内部系统活动</option>
          <option value="CUSTOM">自建 · 工作流审计</option>
        </select>
        {showDatasetHint && (
          <span id="dataset-question-hint" className="dataset-question-hint" role="tooltip">
            <strong>{dataset}</strong>
            <span>{QUESTIONS[dataset]}</span>
          </span>
        )}
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

      <button type="button" className="btn" onClick={onShowHelp} title="键盘快捷键（?）">
        ?
      </button>

      <div className="topbar-docks" aria-label="侧栏">
        <button
          type="button"
          className={`btn btn-quiet${evidenceOpen ? " btn-active" : ""}`}
          aria-pressed={evidenceOpen}
          aria-expanded={evidenceOpen}
          onClick={onToggleEvidence}
          title="切换证据侧栏"
        >
          证据
        </button>
        <button
          type="button"
          className={`btn btn-quiet${eventOpen ? " btn-active" : ""}`}
          aria-pressed={eventOpen}
          aria-expanded={eventOpen}
          onClick={onToggleEvent}
          title="切换事件流侧栏"
        >
          事件流
        </button>
      </div>

      <button type="button" className={`btn${showBench ? " btn-active" : ""}`} onClick={onToggleBench}>
        {showBench ? "返回调查" : "渲染基准"}
      </button>
    </header>
  );
}

export function StatusBar() {
  const { filterSummary, clearFilters, notes, addNote } = useWorkspace();

  return (
    <footer className="statusbar">
      <span className="status-summary">{filterSummary}</span>
      <div className="status-actions">
        <button type="button" className="btn btn-quiet" onClick={clearFilters}>
          清空筛选
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => void addNote(`筛选快照：${filterSummary}`)}
        >
          记录当前筛选 {notes.length > 0 && <span className="badge">{notes.length}</span>}
        </button>
      </div>
    </footer>
  );
}
