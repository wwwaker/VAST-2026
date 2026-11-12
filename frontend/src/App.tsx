import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ThemeProvider } from "./theme/theme";
import { WorkspaceProvider, useWorkspace, type DatasetId } from "./state/workspace";
import { TopBar } from "./components/Shell";
import { TimeBrush } from "./components/TimeBrush";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { useHotkeys } from "./hooks/useHotkeys";
import { RenderBenchView } from "./views/RenderBenchView";
import { Mc1ReferencePage } from "./views/mc1/Mc1ReferencePage";
import { Mc2ReferencePage } from "./views/mc2/Mc2ReferencePage";
import { CustomReferencePage } from "./views/custom/CustomReferencePage";

const LAYOUT_VERSION = 1;
const Mc1MigratedPage = lazy(() => import("./views/mc1/Mc1MigratedPage").then(module => ({ default: module.Mc1MigratedPage })));
const Mc2MigratedPage = lazy(() => import("./views/mc2/Mc2MigratedPage").then(module => ({ default: module.Mc2MigratedPage })));
type LayoutPrefs = { version: number; evidenceOpen: boolean; evidenceSize: number };
const defaultLayout: LayoutPrefs = { version: LAYOUT_VERSION, evidenceOpen: false, evidenceSize: 392 };
function readLayout(key: string): LayoutPrefs {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultLayout;
    const parsed = JSON.parse(raw) as Partial<LayoutPrefs>;
    if (parsed.version !== LAYOUT_VERSION) return defaultLayout;
    const size = (value: unknown, min: number, max: number, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    return { version: LAYOUT_VERSION, evidenceOpen: parsed.evidenceOpen === true,
      evidenceSize: size(parsed.evidenceSize, 280, 560, 392) };
  } catch { return defaultLayout; }
}

/**
 * 三个数据集都用参考风格单页：MC1/MC2/CUSTOM 各自组合图、工具卡与唯一阅读区。
 * 旧 task/mode、视图标签与事件流坞不再渲染；恢复旧快照时由页面按 task/mode 落到区域/工具。
 */
function renderTaskContent(dataset: DatasetId) {
  if (dataset === "MC1") return <Mc1ReferencePage />;
  if (dataset === "MC2") return <Mc2ReferencePage />;
  return <CustomReferencePage />;
}

function Workspace() {
  // 渲染基准移出常规产品界面；仍可用 ?bench=1 直接进入，供开发与测试访问。
  const [showBench, setShowBench] = useState(() => new URLSearchParams(window.location.search).get("bench") === "1");
  const [showHelp, setShowHelp] = useState(false);
  const [evidenceSize, setEvidenceSize] = useState(392);
  const evidenceTriggerRef = useRef<HTMLButtonElement>(null);
  const previousEvidenceOpen = useRef(false);
  const {
    dataset,
    setDataset,
    state,
    evidenceOpen,
    setEvidenceOpen,
    compareReturn,
    restoreCompare,
    dispatch,
    restoreMissing,
  } = useWorkspace();
  // 布局偏好按数据集记忆；不再按 task 分包，否则恢复快照换了 task 会套用旧的侧栏开合
  const layoutKey = `mas-workspace.${dataset}.layout`;

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.has("mc1")) setDataset("MC1");
    else if (query.has("mc2")) setDataset("MC2");
  }, [setDataset]);

  useEffect(() => {
    const prefs = readLayout(layoutKey);
    setEvidenceOpen(prefs.evidenceOpen && window.innerWidth >= 900);
    setEvidenceSize(prefs.evidenceSize);
  }, [layoutKey, setEvidenceOpen]);

  useEffect(() => {
    if (previousEvidenceOpen.current && !evidenceOpen) evidenceTriggerRef.current?.focus();
    previousEvidenceOpen.current = evidenceOpen;
  }, [evidenceOpen]);

  const usingReferenceMc1 = dataset === "MC1" && !showBench && new URLSearchParams(window.location.search).get("mc1") !== "legacy";
  const usingReferenceMc2 = dataset === "MC2" && !showBench && new URLSearchParams(window.location.search).get("mc2") !== "legacy";
  useHotkeys(() => setShowHelp((v) => !v), !usingReferenceMc1 && !usingReferenceMc2);
  const selectDataset = (id: DatasetId) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("mc1"); url.searchParams.delete("mc2");
    if (id !== "CUSTOM") url.searchParams.set(id.toLowerCase(), "reference");
    window.history.replaceState(null, "", url);
    setDataset(id);
  };

  const persist = (patch: Partial<LayoutPrefs>) => {
    try {
      const current = readLayout(layoutKey);
      localStorage.setItem(layoutKey, JSON.stringify({ ...current, ...patch, version: LAYOUT_VERSION }));
    } catch { /* storage is optional */ }
  };
  const resizePanel = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = event.clientX;
    const initial = evidenceSize;
    const move = (next: globalThis.PointerEvent) => {
      const size = Math.max(280, Math.min(560, initial + (start - next.clientX)));
      setEvidenceSize(size);
      persist({ evidenceSize: size });
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

  if (usingReferenceMc1) {
    return <Suspense fallback={<p role="status" style={{ padding: 24 }}>正在打开 MC1…</p>}><Mc1MigratedPage onDatasetChange={selectDataset} /></Suspense>;
  }
  if (usingReferenceMc2) {
    return <Suspense fallback={<p role="status" style={{ padding: 24 }}>正在打开 MC2…</p>}><Mc2MigratedPage onDatasetChange={selectDataset} /></Suspense>;
  }

  return (
    <div className="app">
      <TopBar
        showBench={showBench}
        onToggleBench={() => setShowBench((v) => !v)}
        onShowHelp={() => setShowHelp(true)}
        evidenceOpen={evidenceOpen}
        evidenceTriggerRef={evidenceTriggerRef}
        onToggleEvidence={() => {
          const next = !evidenceOpen;
          setEvidenceOpen(next);
          persist({ evidenceOpen: next });
        }}
      />
      {dataset === "MC1" && <div style={{ padding: "6px 20px" }}><a href="?mc1=reference">返回新版 MC1</a><span> · 旧版扩展工具保留于此</span></div>}
      {dataset === "MC2" && <div style={{ padding: "6px 20px" }}><a href="?mc2=reference">返回新版 MC2</a><span> · 旧版扩展工具保留于此</span></div>}
      <div className="workbench" style={{ "--evidence-size": `${evidenceSize}px` } as CSSProperties}>
        <div className={`body${evidenceOpen ? " body-evidence-open" : ""}`}>
          <main className="canvas-area">
            {showBench ? <RenderBenchView /> : <>
              {state.notice && <div className="callout" role="status">{state.notice}</div>}
              {dataset !== "CUSTOM" && !compareReturn && state.returnStack.length > 0 && <div className="compare-return-banner"><span>已保留显式下钻前的调查上下文</span><button type="button" className="btn btn-quiet" onClick={() => dispatch({ type: "return" })}>返回上次调查</button></div>}
              {compareReturn && state.task !== "compare" && <div className="compare-return-banner" role="status"><span>正在查看比较证据</span><button type="button" className="btn btn-quiet" onClick={restoreCompare}>返回比较</button></div>}
              {!showBench && renderTaskContent(dataset)}
            </>}
          </main>
          {evidenceOpen && <div className="evidence-dock">
            <div className="dock-resizer dock-resizer-left" role="separator" tabIndex={0} aria-valuemin={280} aria-valuemax={560} aria-valuenow={evidenceSize} aria-orientation="vertical" aria-label="调整证据面板宽度" onPointerDown={resizePanel} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const next = Math.max(280, Math.min(560, evidenceSize + (e.key === "ArrowLeft" ? 16 : -16))); setEvidenceSize(next); persist({ evidenceSize: next }); } }} />
            <EvidenceDrawer />
          </div>}
        </div>
      </div>
      <div className="controlbar">
        <TimeBrush compact missingRunIds={dataset === "CUSTOM" ? restoreMissing : undefined} />
      </div>
      {showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

export default function App() {
  return <ThemeProvider><WorkspaceProvider><Workspace /></WorkspaceProvider></ThemeProvider>;
}
