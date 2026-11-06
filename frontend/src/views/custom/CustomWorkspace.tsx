import { useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { OverviewView } from "../OverviewView";
import { CasePicker } from "./CasePicker";
import { RunOverview } from "./RunOverview";
import { RunTimeline } from "./RunTimeline";
import { RunCompare } from "./RunCompare";

type Mode = "runs" | "run" | "compare";

/** CUSTOM：默认按运行浏览；系统总览保留为可切换的全量背景。 */
export function CustomWorkspace() {
  const { clearFilters, setCursor, selectEvent, setFilters } = useWorkspace();
  const [mode, setMode] = useState<Mode>("runs");
  const [runId, setRunId] = useState<string | null>(null);
  const [baselineRunId, setBaselineRunId] = useState<string | null>(null);
  const [showOverview, setShowOverview] = useState(false);

  const openRun = (id: string, baseline: string | null = null) => {
    // 进入运行即建立该运行的上下文：清掉旧条件，并把 run_id 写进统一筛选，
    // 否则画布只看这一次运行、右侧事件流仍是全量，两个口径会对不上
    clearFilters();
    setFilters({ runId: id });
    selectEvent(null);
    setCursor(null);
    setRunId(id);
    setBaselineRunId(baseline);
    setMode(baseline ? "compare" : "run");
  };

  const backToList = () => {
    setMode("runs");
    setRunId(null);
    setBaselineRunId(null);
  };

  return (
    <div className="custom-workspace">
      <div className="canvas-subbar">
        <div className="seg">
          <button
            type="button"
            className={`seg-item${!showOverview ? " seg-active" : ""}`}
            onClick={() => setShowOverview(false)}
            aria-pressed={!showOverview}
          >
            运行流程
          </button>
          <button
            type="button"
            className={`seg-item${showOverview ? " seg-active" : ""}`}
            onClick={() => setShowOverview(true)}
            aria-pressed={showOverview}
          >
            系统总览
          </button>
        </div>
        {showOverview && (
          <span className="muted small">总览是全局背景，不随运行选择变化；右侧事件流仍按当前筛选。</span>
        )}
      </div>

      {showOverview ? (
        <OverviewView />
      ) : (
        <>
          <CasePicker onOpen={openRun} />
          {mode === "runs" ? (
            <RunOverview onOpen={openRun} />
          ) : mode === "compare" && runId ? (
            <RunCompare
              runId={runId}
              baselineRunId={baselineRunId}
              onBack={() => setMode("run")}
            />
          ) : runId ? (
            <RunTimeline
              runId={runId}
              onBack={backToList}
              onCompare={(id) => {
                setRunId(id);
                setBaselineRunId(null);
                setMode("compare");
              }}
            />
          ) : (
            <div className="empty-state"><p className="muted">请选择一个运行。</p></div>
          )}
        </>
      )}
    </div>
  );
}
