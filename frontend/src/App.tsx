import { useState } from "react";
import { ThemeProvider } from "./theme/theme";
import { WorkspaceProvider, useWorkspace, type CanvasView } from "./state/workspace";
import { ChapterNav, QuestionBar, StatusBar, TopBar } from "./components/Shell";
import { TimeBrush } from "./components/TimeBrush";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import { OverviewView } from "./views/OverviewView";
import { RelationGraph } from "./views/RelationGraph";
import { CompareView } from "./views/CompareView";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { useHotkeys } from "./hooks/useHotkeys";
import { RenderBenchView } from "./views/RenderBenchView";

const VIEWS: { key: CanvasView; label: string; hint: string }[] = [
  { key: "timeline", label: "事件时间线", hint: "按时间建立基线，刷选时段" },
  { key: "graph", label: "关系图", hint: "以选中实体为中心展开邻接" },
  { key: "compare", label: "基线比较", hint: "把刷选窗口与前一等长窗口对比" },
];

function ViewTabs() {
  const { canvasView, setCanvasView } = useWorkspace();
  return (
    <div className="view-tabs" role="tablist" aria-label="主画布视图">
      {VIEWS.map((v) => (
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
  const { canvasView } = useWorkspace();
  useHotkeys(() => setShowHelp((v) => !v));

  return (
    <div className="app">
      <TopBar
        showBench={showBench}
        onToggleBench={() => setShowBench((v) => !v)}
        onShowHelp={() => setShowHelp(true)}
      />
      <QuestionBar />
      <div className="body">
        <ChapterNav />
        <main className="canvas-area">
          {showBench ? (
            <RenderBenchView />
          ) : (
            <>
              <ViewTabs />
              {canvasView === "timeline" && <OverviewView />}
              {canvasView === "graph" && <RelationGraph />}
              {canvasView === "compare" && <CompareView />}
            </>
          )}
        </main>
        <EvidenceDrawer />
      </div>
      <TimeBrush />
      <StatusBar />
      {showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
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
