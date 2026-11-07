import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ThemeProvider } from "./theme/theme";
import {
  WorkspaceProvider,
  useWorkspace,
  type CanvasView,
  type DatasetId,
} from "./state/workspace";
import { StatusBar, TopBar } from "./components/Shell";
import { TimeBrush } from "./components/TimeBrush";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import { EventStream } from "./components/EventStream";
import { OverviewView } from "./views/OverviewView";
import { CompareView } from "./views/CompareView";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { useHotkeys } from "./hooks/useHotkeys";
import { RenderBenchView } from "./views/RenderBenchView";
import { CustomWorkspace } from "./views/custom/CustomWorkspace";
import { GraphWorkspace } from "./views/GraphWorkspace";
import { SourceTrace } from "./views/mc2/SourceTrace";
import { Mc1Workspace } from "./views/mc1/Mc1Workspace";
import { TaskNav, taskModeLabel } from "./components/TaskNav";
import { FindingsWorkspace } from "./views/FindingsWorkspace";

const VIEWS: { key: CanvasView; label: string; hint: string; only?: DatasetId[] }[] = [
  { key: "timeline", label: "时间线", hint: "回到当前任务的时间/运行视角" },
  { key: "graph", label: "关系图", hint: "以选中实体为中心展开邻接" },
  { key: "compare", label: "时间窗对照", hint: "把刷选窗口与前一等长窗口对比" },
  { key: "trace", label: "来源链", hint: "从发布事件追到内容文件与文件操作", only: ["MC2"] },
];

const LAYOUT_VERSION = 1;
type LayoutPrefs = { version: number; evidenceOpen: boolean; eventOpen: boolean; evidenceSize: number; eventSize: number };
const defaultLayout: LayoutPrefs = { version: LAYOUT_VERSION, evidenceOpen: false, eventOpen: false, evidenceSize: 392, eventSize: 320 };
function readLayout(key: string): LayoutPrefs {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultLayout;
    const parsed = JSON.parse(raw) as Partial<LayoutPrefs>;
    if (parsed.version !== LAYOUT_VERSION) return defaultLayout;
    const size = (value: unknown, min: number, max: number, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    return { version: LAYOUT_VERSION, evidenceOpen: parsed.evidenceOpen === true, eventOpen: parsed.eventOpen === true,
      evidenceSize: size(parsed.evidenceSize, 280, 560, 392), eventSize: size(parsed.eventSize, 240, 520, 320) };
  } catch { return defaultLayout; }
}

function ViewTabs() {
  const { canvasView, setCanvasView, dataset, compareReturn, restoreCompare } = useWorkspace();
  const visible = VIEWS.filter((v) => !v.only || v.only.includes(dataset));
  return (
    <div className="view-tabs" role="tablist" aria-label="兼容视图入口">
      {visible.map((v) => (
        <button
          key={v.key}
          type="button"
          role="tab"
          aria-selected={canvasView === v.key}
          title={v.hint}
          className={`view-tab${canvasView === v.key ? " view-tab-active" : ""}`}
          onClick={() => {
            if (v.key === "compare" && compareReturn) { restoreCompare(); return; }
            setCanvasView(v.key);
          }}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function renderTaskContent(dataset: DatasetId, state: ReturnType<typeof useWorkspace>["state"]) {
  if (state.task === "findings") return <FindingsWorkspace />;

  if (state.task === "compare") {
    if (state.mode === "window") return <CompareView />;
    if (dataset === "MC2" && (state.mode === "history" || state.mode === "transitions")) return <SourceTrace />;
    if (dataset === "CUSTOM" && state.mode === "runPair") return <CustomWorkspace />;
    return <CompareView />;
  }

  if (state.task === "trace") {
    if (dataset === "MC2" && (state.mode === "source" || state.mode === "intervention")) return <SourceTrace />;
    if (dataset === "CUSTOM" && state.mode === "run") return <CustomWorkspace />;
    if (dataset === "CUSTOM" && state.mode === "localGraph") return <GraphWorkspace />;
    if (dataset === "MC1" && state.mode === "decision") return <Mc1Workspace />;
    return <GraphWorkspace />;
  }

  if (dataset === "CUSTOM") {
    if (state.mode === "relations") return <GraphWorkspace />;
    return <CustomWorkspace />;
  }
  if (dataset === "MC1") {
    if (state.mode === "relations") return <GraphWorkspace />;
    return state.mode === "activity" ? <Mc1Workspace /> : <OverviewView />;
  }
  if (state.mode === "system" || state.mode === "relations") return <GraphWorkspace />;
  return <OverviewView />;
}

function Workspace() {
  const [showBench, setShowBench] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [evidenceSize, setEvidenceSize] = useState(392);
  const [eventSize, setEventSize] = useState(320);
  const evidenceTriggerRef = useRef<HTMLButtonElement>(null);
  const eventTriggerRef = useRef<HTMLButtonElement>(null);
  const previousEvidenceOpen = useRef(false);
  const previousEventOpen = useRef(false);
  const {
    dataset,
    state,
    evidenceOpen,
    setEvidenceOpen,
    compareReturn,
    restoreCompare,
    filterSummary,
    dispatch,
  } = useWorkspace();
  const layoutPrefix = `mas-workspace.${dataset}.${state.task}`;
  const layoutKey = `${layoutPrefix}.layout`;

  useEffect(() => {
    const prefs = readLayout(layoutKey);
    const narrow = window.innerWidth < 900;
    setEventOpen(narrow ? false : prefs.eventOpen);
    setEvidenceOpen(prefs.evidenceOpen || (narrow && prefs.eventOpen));
    setEvidenceSize(prefs.evidenceSize);
    setEventSize(prefs.eventSize);
  }, [layoutKey, setEvidenceOpen]);

  useEffect(() => {
    if (previousEvidenceOpen.current && !evidenceOpen) evidenceTriggerRef.current?.focus();
    if (previousEventOpen.current && !eventOpen) eventTriggerRef.current?.focus();
    previousEvidenceOpen.current = evidenceOpen;
    previousEventOpen.current = eventOpen;
  }, [evidenceOpen, eventOpen]);

  useHotkeys(() => setShowHelp((v) => !v));

  const persist = (patch: Partial<LayoutPrefs>) => {
    try {
      const current = readLayout(layoutKey);
      localStorage.setItem(layoutKey, JSON.stringify({ ...current, ...patch, version: LAYOUT_VERSION }));
    } catch { /* storage is optional */ }
  };
  const resizePanel = (panel: "evidence" | "event", event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = panel === "evidence" ? event.clientX : event.clientY;
    const initial = panel === "evidence" ? evidenceSize : eventSize;
    const move = (next: globalThis.PointerEvent) => {
      const delta = panel === "evidence" ? start - next.clientX : start - next.clientY;
      const size = panel === "evidence"
        ? Math.max(280, Math.min(560, initial + delta))
        : Math.max(240, Math.min(520, initial + delta));
      if (panel === "evidence") setEvidenceSize(size);
      else setEventSize(size);
      persist(panel === "evidence" ? { evidenceSize: size } : { eventSize: size });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  const parallel = () => {
    if (window.innerWidth < 900) {
      setEvidenceOpen(true);
      setEventOpen(false);
      persist({ evidenceOpen: true, eventOpen: false });
      return;
    }
    setEvidenceOpen(true);
    setEventOpen(true);
    persist({ evidenceOpen: true, eventOpen: true });
  };

  return (
    <div className="app">
      <TopBar
        showBench={showBench}
        onToggleBench={() => setShowBench((v) => !v)}
        onShowHelp={() => setShowHelp(true)}
        evidenceOpen={evidenceOpen}
        evidenceTriggerRef={evidenceTriggerRef}
        eventTriggerRef={eventTriggerRef}
        onToggleEvidence={() => { const next = !evidenceOpen; setEvidenceOpen(next); if (next && window.innerWidth < 900) setEventOpen(false); persist({ evidenceOpen: next, ...(next && window.innerWidth < 900 ? { eventOpen: false } : {}) }); }}
        eventOpen={eventOpen}
        onToggleEvent={() => { const next = !eventOpen; setEventOpen(next); if (next && window.innerWidth < 900) setEvidenceOpen(false); persist({ eventOpen: next, ...(next && window.innerWidth < 900 ? { evidenceOpen: false } : {}) }); }}
      />
      <div className="workspace-heading">
        <TaskNav onParallel={parallel} />
        <span className="workspace-status" aria-live="polite">{taskModeLabel(dataset, state.task, state.mode)}</span>
      </div>
      <div className="workbench" style={{ "--event-size": `${eventSize}px`, "--evidence-size": `${evidenceSize}px` } as CSSProperties}>
        <div className={`body${eventOpen ? " body-event-open" : ""}${evidenceOpen ? " body-evidence-open" : ""}`}>
          <main className="canvas-area">
            {showBench ? <RenderBenchView /> : <>
              <div className="canvas-toolbar">
                <ViewTabs />
              </div>
              {state.notice && <div className="callout" role="status">{state.notice}</div>}
              {!compareReturn && state.returnStack.length > 0 && <div className="compare-return-banner"><span>已保留显式下钻前的调查上下文</span><button type="button" className="btn btn-quiet" onClick={() => dispatch({ type: "return" })}>返回上次调查</button></div>}
              {compareReturn && state.task !== "compare" && <div className="compare-return-banner" role="status"><span>正在查看比较证据：<span className="muted small">{filterSummary}</span></span><button type="button" className="btn btn-quiet" onClick={restoreCompare}>返回比较</button></div>}
              {!showBench && renderTaskContent(dataset, state)}
            </>}
          </main>
          {evidenceOpen && <div className="evidence-dock">
            <div className="dock-resizer dock-resizer-left" role="separator" tabIndex={0} aria-valuemin={280} aria-valuemax={560} aria-valuenow={evidenceSize} aria-orientation="vertical" aria-label="调整证据面板宽度" onPointerDown={(e) => resizePanel("evidence", e)} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const next = Math.max(280, Math.min(560, evidenceSize + (e.key === "ArrowLeft" ? 16 : -16))); setEvidenceSize(next); persist({ evidenceSize: next }); } }} />
            <EvidenceDrawer />
          </div>}
          {eventOpen && <aside className="event-dock event-dock-bottom">
            <div className="dock-resizer dock-resizer-top" role="separator" tabIndex={0} aria-valuemin={240} aria-valuemax={520} aria-valuenow={eventSize} aria-orientation="horizontal" aria-label="调整事件面板高度" onPointerDown={(e) => resizePanel("event", e)} onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); const next = Math.max(240, Math.min(520, eventSize + (e.key === "ArrowUp" ? 16 : -16))); setEventSize(next); persist({ eventSize: next }); } }} />
            <EventPanel onClose={() => { setEventOpen(false); persist({ eventOpen: false }); }} />
          </aside>}
        </div>
      </div>
      <div className="controlbar"><TimeBrush /><StatusBar /></div>
      {showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function EventPanel({ onClose }: { onClose: () => void }) {
  return <div className="event-panel"><div className="event-panel-toolbar"><span className="dock-label">事件流</span><button type="button" className="btn btn-quiet" onClick={onClose} title="收起事件流">收起</button></div><EventStream /></div>;
}

export default function App() {
  return <ThemeProvider><WorkspaceProvider><Workspace /></WorkspaceProvider></ThemeProvider>;
}
