import { useWorkspace } from "../../state/workspace";
import { OverviewView } from "../OverviewView";
import { CasePicker } from "./CasePicker";
import { RunOverview } from "./RunOverview";
import { RunTimeline } from "./RunTimeline";
import { RunCompare } from "./RunCompare";

/** CUSTOM：默认按运行浏览；系统总览保留为可切换的全量背景。 */
export function CustomWorkspace() {
  const { state, dispatch, changeTask, clearFilters } = useWorkspace();
  const runId = state.traceObject.dataset === "CUSTOM" ? state.traceObject.runId : null;
  const baselineRunId = state.comparison?.kind === "runPair" ? state.comparison.baselineRunId : null;
  const mode = state.task === "compare" && state.mode === "runPair" ? "compare" : state.task === "trace" ? "run" : "runs";
  const showOverview = state.task === "overview" && state.mode === "time";
  const openRun = (id: string, baseline: string | null = null, complete = false) => {
    dispatch({ type: "openRun", runId: id, baselineRunId: baseline, complete });
  };
  const backToList = () => changeTask("overview", "runs");

  return (
    <div className="custom-workspace">
      <div className="canvas-subbar">
        <div className="seg">
          <button
            type="button"
            className={`seg-item${!showOverview ? " seg-active" : ""}`}
            onClick={() => changeTask("overview", "runs")}
            aria-pressed={!showOverview}
          >
            运行流程
          </button>
          <button
            type="button"
            className={`seg-item${showOverview ? " seg-active" : ""}`}
            onClick={() => changeTask("overview", "time")}
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
          <CasePicker onOpen={(id, baseline) => openRun(id, baseline, true)} />
          {runId && <div className="canvas-subbar"><span className="muted small">{mode === "compare" ? "完整运行对照；附加事件筛选与回放不用于阶段对照。" : "运行作用域与附加事件筛选分开；清筛选仍保留当前运行。"}</span>{mode !== "compare" && <><button type="button" className="btn btn-quiet" onClick={() => changeTask("trace", "run")}>保留附加筛选</button><button type="button" className="btn btn-quiet" onClick={clearFilters}>查看完整运行</button></>}</div>}
          {mode === "runs" ? (
            <RunOverview onOpen={openRun} />
          ) : mode === "compare" && runId ? (
            <RunCompare
              runId={runId}
              baselineRunId={baselineRunId}
              onBack={() => changeTask("trace", "run")}
            />
          ) : runId ? (
            <RunTimeline
              runId={runId}
              onBack={backToList}
              onCompare={(id) => dispatch({ type: "openRun", runId: id, compare: true })}
            />
          ) : (
            <div className="empty-state"><p className="muted">请选择一个运行。</p></div>
          )}
        </>
      )}
    </div>
  );
}
