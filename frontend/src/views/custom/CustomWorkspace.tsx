import { useEffect, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { OverviewView } from "../OverviewView";
import { RunOverview } from "./RunOverview";
import { RunTimeline } from "./RunTimeline";
import { RunCompare } from "./RunCompare";

type Mode = "runs" | "run" | "compare";

/** CUSTOM：默认按运行浏览；系统总览保留为可切换的全量背景。 */
export function CustomWorkspace() {
  const { clearFilters, filters, setFilters, setCursor, selectEvent } = useWorkspace();
  const [mode, setMode] = useState<Mode>("runs");
  const [runId, setRunId] = useState<string | null>(null);
  const [showOverview, setShowOverview] = useState(false);

  const openRun = (id: string) => {
    // 进入运行即建立该运行的上下文：清掉局部筛选与事件选择，再把 run_id 写进统一筛选。
    // 写进筛选而不是只存本地 state，右侧事件流、概览、关系图才会与画布同域。
    clearFilters();
    setFilters({ runId: id });
    selectEvent(null);
    setCursor(null);
    setRunId(id);
    setMode("run");
  };

  const backToList = () => {
    setMode("runs");
    setRunId(null);
    setFilters({ runId: null });
    setCursor(null);
  };

  // 外部清空筛选（状态栏、“清空筛选”）时退出运行，避免画布与事件流口径不一致
  useEffect(() => {
    if (filters.runId == null && mode !== "runs") {
      setMode("runs");
      setRunId(null);
    }
  }, [filters.runId, mode]);

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
      ) : mode === "runs" ? (
        <RunOverview onOpen={openRun} />
      ) : mode === "compare" && runId ? (
        <RunCompare runId={runId} onBack={() => setMode("run")} />
      ) : runId ? (
        <RunTimeline
          runId={runId}
          onBack={backToList}
          onCompare={(id) => {
            setRunId(id);
            setFilters({ runId: id });
            setMode("compare");
          }}
        />
      ) : (
        <div className="empty-state"><p className="muted">请选择一个运行。</p></div>
      )}
    </div>
  );
}
