import { useEffect, useRef, useState, type RefObject } from "react";
import { useWorkspace, type DatasetId } from "../state/workspace";
import { useTheme, type ThemeMode } from "../theme/theme";

const QUESTIONS: Record<DatasetId, string> = {
  MC1: "2046-06-05 18:00 解禁前，并购消息为何已出现在 FleX？是蓄意泄露还是系统失效？",
  MC2: "2046-05-17 04:21 的乱码帖子如何产生？内容来自哪里，此前是否发生过？",
  CUSTOM: "32 次工作流运行中，审批绕过与旧版本传播分别在哪些事件上留下证据？",
};

/**
 * 三集共用的顶栏：数据集、关键词、证据与设置。
 * 旧任务/视图标签、事件流坞与重复状态条已在单页改造中退出。
 */
export function TopBar({
  showBench,
  onToggleBench,
  onShowHelp,
  evidenceOpen,
  onToggleEvidence,
  evidenceTriggerRef,
}: {
  showBench: boolean;
  onToggleBench: () => void;
  onShowHelp: () => void;
  evidenceOpen: boolean;
  onToggleEvidence: () => void;
  evidenceTriggerRef: RefObject<HTMLButtonElement>;
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

      <div className="topbar-docks" aria-label="侧栏">
        <button
          ref={evidenceTriggerRef}
          type="button"
          className={`btn btn-quiet${evidenceOpen ? " btn-active" : ""}`}
          aria-pressed={evidenceOpen}
          aria-expanded={evidenceOpen}
          onClick={onToggleEvidence}
          title="打开证据、案例与笔记工具"
        >
          证据
        </button>
      </div>
      <details className="topbar-settings">
        <summary>设置</summary>
        <div className="topbar-settings-body">
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
          <button type="button" className="btn btn-quiet" onClick={onShowHelp}>
            键盘快捷键
          </button>
          {showBench && (
            <button type="button" className="btn btn-quiet" onClick={onToggleBench}>
              返回调查
            </button>
          )}
        </div>
      </details>
    </header>
  );
}
