import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
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

const VIEWS: { key: CanvasView; label: string; hint: string; only?: DatasetId[] }[] = [
  { key: "timeline", label: "事件时间线", hint: "按时间建立基线，刷选时段" },
  { key: "graph", label: "关系图", hint: "以选中实体为中心展开邻接" },
  { key: "compare", label: "基线比较", hint: "把刷选窗口与前一等长窗口对比" },
  { key: "trace", label: "来源链", hint: "从发布事件追到内容文件与文件操作", only: ["MC2"] },
];

const readLayout = (key: string, fallback: string) => {
  try { return localStorage.getItem(`mas-workspace.${key}`) ?? fallback; } catch { return fallback; }
};

function ViewTabs() {
  const { canvasView, setCanvasView, dataset } = useWorkspace();
  const visible = VIEWS.filter((v) => !v.only || v.only.includes(dataset));
  return (
    <div className="view-tabs" role="tablist" aria-label="主画布视图">
      {visible.map((v) => (
        <button
          key={v.key}
          type="button"
          role="tab"
          aria-selected={canvasView === v.key}
          title={v.hint}
          className={`view-tab${canvasView === v.key ? " view-tab-active" : ""}`}
          onClick={() => setCanvasView(v.key)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function Workspace() {
  const [showBench, setShowBench] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [eventOpen, setEventOpen] = useState(() => readLayout("event-open", "true") === "true");
  const [evidenceSize, setEvidenceSize] = useState(() => Math.max(280, Math.min(560, Number(readLayout("evidence-size", "392")) || 392)));
  const [eventSize, setEventSize] = useState(() => Math.max(240, Math.min(520, Number(readLayout("event-size", "320")) || 320)));
  const { canvasView, dataset, evidenceOpen, setEvidenceOpen } = useWorkspace();
  useHotkeys(() => setShowHelp((v) => !v));

  const persist = (key: string, value: string) => {
    try { localStorage.setItem(`mas-workspace.${key}`, value); } catch { /* storage is optional */ }
  };
  const resizePanel = (panel: "evidence" | "event", event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = event.clientX;
    const initial = panel === "evidence" ? evidenceSize : eventSize;
    const move = (next: globalThis.PointerEvent) => {
      const delta = panel === "evidence" ? next.clientX - start : start - next.clientX;
      const size = panel === "evidence"
        ? Math.max(280, Math.min(560, initial + delta))
        : Math.max(240, Math.min(520, initial + delta));
      if (panel === "evidence") {
        setEvidenceSize(size);
        persist("evidence-size", String(size));
      } else {
        setEventSize(size);
        persist("event-size", String(size));
      }
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

  return (
    <div className="app">
      <TopBar
        showBench={showBench}
        onToggleBench={() => setShowBench((v) => !v)}
        onShowHelp={() => setShowHelp(true)}
        evidenceOpen={evidenceOpen}
        onToggleEvidence={() => setEvidenceOpen(!evidenceOpen)}
        eventOpen={eventOpen}
        onToggleEvent={() => {
          const next = !eventOpen;
          setEventOpen(next);
          persist("event-open", String(next));
        }}
      />
      <div className="workbench" style={{ "--event-size": `${eventSize}px`, "--evidence-size": `${evidenceSize}px` } as CSSProperties}>
        <div className={`body${eventOpen ? " body-dock-right" : ""}${evidenceOpen ? " body-evidence-open" : ""}`}>
          {evidenceOpen && <div className="evidence-dock">
            <div className="dock-resizer dock-resizer-right" role="separator" tabIndex={0} aria-valuemin={280} aria-valuemax={560} aria-valuenow={evidenceSize} aria-orientation="vertical" aria-label="调整证据面板宽度" onPointerDown={(e) => resizePanel("evidence", e)} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const next = Math.max(280, Math.min(560, evidenceSize + (e.key === "ArrowRight" ? 16 : -16))); setEvidenceSize(next); persist("evidence-size", String(next)); } }} />
            <EvidenceDrawer />
          </div>}
          <main className="canvas-area">
          {showBench ? (
            <RenderBenchView />
          ) : (
            <>
              <div className="canvas-toolbar">
                <ViewTabs />
              </div>
              {canvasView === "timeline" &&
                (dataset === "CUSTOM" ? <CustomWorkspace /> : <OverviewView />)}
              {canvasView === "graph" && <GraphWorkspace />}
              {canvasView === "compare" && <CompareView />}
              {canvasView === "trace" && dataset === "MC2" && <SourceTrace />}
            </>
          )}
          </main>
          {eventOpen && (
            <aside className="event-dock event-dock-right">
              <div className="dock-resizer dock-resizer-left" role="separator" tabIndex={0} aria-valuemin={240} aria-valuemax={520} aria-valuenow={eventSize} aria-orientation="vertical" aria-label="调整事件面板宽度" onPointerDown={(e) => resizePanel("event", e)} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const next = Math.max(240, Math.min(520, eventSize + (e.key === "ArrowLeft" ? 16 : -16))); setEventSize(next); persist("event-size", String(next)); } }} />
              <EventPanel onClose={() => { setEventOpen(false); persist("event-open", "false"); }} />
            </aside>
          )}
        </div>
      </div>
      <div className="controlbar"><TimeBrush /><StatusBar /></div>
      {showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function EventPanel({ onClose }: { onClose: () => void }) {
  return <div className="event-panel">
    <div className="event-panel-toolbar">
      <span className="dock-label">事件流</span>
      <button type="button" className="btn btn-quiet" onClick={onClose} title="收起事件流">收起</button>
    </div>
    <EventStream />
  </div>;
}

export default function App() {
  return (
    <ThemeProvider>
      <WorkspaceProvider>
        <Workspace />
      </WorkspaceProvider>
    </ThemeProvider>
  );
}
