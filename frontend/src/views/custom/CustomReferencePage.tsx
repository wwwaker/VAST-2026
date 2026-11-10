import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { formatUtc } from "../../data/api";
import { EventStream } from "../../components/EventStream";
import { OverviewView } from "../OverviewView";
import { CompareView } from "../CompareView";
import { RelationGraph } from "../RelationGraph";
import { CasePicker } from "./CasePicker";
import { CustomReader } from "./CustomReader";
import { RunCompare } from "./RunCompare";
import { RunOverview } from "./RunOverview";
import { RunTimeline } from "./RunTimeline";

type ChartKey = "overview" | "flow" | "pair";
/** 显式打开/恢复后要定位的真实落点；只在用户动作后请求，不由渲染无条件触发。 */
type LocateKey = "overview" | "analysis" | "system" | "graph" | "window" | "events";

/** 关闭阅读面板后要还的焦点：原控件优先，原控件卸载时退回它所在卡片。 */
interface FocusOrigin {
  el: Element | null;
  region: Element | null;
}

/**
 * CUSTOM 单页（F3）：沿用 MC1/MC2 的控制条、卡片、图表显隐与唯一阅读区。
 * 调查对象仍来自 reducer（traceObject.runId、comparison=runPair、selection、collectionFilters、
 * baseEventFilters、replay）；页面局部状态只管理图表显隐、工具卡、阶段样本与阅读面板。
 * 旧四任务/模式标签不再是导航：恢复旧快照时按 task/mode 落到集合、运行、配对或工具卡。
 */
export function CustomReferencePage() {
  const {
    state,
    dispatch,
    changeTask,
    clearFilters,
    selectEvent,
    setEvidenceOpen,
    setEvidenceTab,
    evidenceOpen,
    cursor,
    masking,
    restoreSeq,
    restoreMissing,
  } = useWorkspace();

  const [visible, setVisible] = useState<Record<ChartKey, boolean>>({ overview: true, flow: true, pair: true });
  const [panel, setPanel] = useState<"events" | null>(null);
  const [reader, setReader] = useState<{ eventId: string; timeUs: number | null } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(true);

  const analysisRef = useRef<HTMLElement | null>(null);
  const overviewRef = useRef<HTMLDivElement | null>(null);
  const systemRef = useRef<HTMLElement | null>(null);
  const graphRef = useRef<HTMLElement | null>(null);
  const windowRef = useRef<HTMLElement | null>(null);
  const eventsRef = useRef<HTMLElement | null>(null);
  const originRef = useRef<FocusOrigin>({ el: null, region: null });
  const previousOriginRef = useRef<FocusOrigin | null>(null);
  const [locate, setLocate] = useState<{ key: LocateKey; seq: number } | null>(null);
  const locateSeq = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const runId = state.traceObject.dataset === "CUSTOM" ? state.traceObject.runId : null;
  const pair = state.comparison?.kind === "runPair" ? state.comparison : null;
  const pairOpen = !!runId && state.task === "compare" && state.mode === "runPair";
  const pairBaseline = pair && pair.runId === runId ? pair.baselineRunId : null;
  const systemOpen = state.task === "overview" && state.mode === "time";
  const graphOpen = state.mode === "relations" || state.mode === "localGraph";
  const windowOpen = state.task === "compare" && state.mode === "window";

  const missingSet = useMemo(() => new Set(restoreMissing), [restoreMissing]);
  const runMissing = !!runId && missingSet.has(runId);
  const baselineMissing = !!pairBaseline && missingSet.has(pairBaseline);

  const base = state.baseEventFilters;
  const hasEventFilters =
    base.startUs != null ||
    base.endUs != null ||
    base.categories.length > 0 ||
    base.eventTypes.length > 0 ||
    base.actorId != null ||
    base.participantId != null ||
    base.channels.length > 0 ||
    base.keyword.trim() !== "";

  const collection = state.collectionFilters;
  const collectionActive =
    collection.model != null || collection.fixture != null || collection.scenario != null || collection.observed !== null;
  const clearCollection = () =>
    dispatch({ type: "display", patch: { collectionFilters: { model: null, fixture: null, scenario: null, observed: null } } });

  // ---------- 打开动作：统一写 selection，再显示同一份正文 ----------
  const focusable = (el: Element | null): el is Element & { focus: () => void } =>
    !!el && typeof (el as { focus?: unknown }).focus === "function";

  const focusFirstIn = (region: Element) => {
    const target = region.querySelector<HTMLElement>('button, [tabindex="0"], input, summary, a[href]');
    if (target) {
      target.focus();
      return true;
    }
    if (region instanceof HTMLElement) {
      region.tabIndex = -1;
      region.focus();
      return true;
    }
    return false;
  };

  const captureOrigin = (trigger?: Element | null): FocusOrigin => {
    const el = trigger instanceof Element
      ? trigger
      : document.activeElement instanceof Element
        ? document.activeElement
        : null;
    return { el, region: el?.closest?.(".custom-card, .custom-aside, .custom-cases") ?? null };
  };

  const closeReader = () => {
    const candidates = [originRef.current, previousOriginRef.current];
    setReader(null);
    window.requestAnimationFrame(() => {
      for (const origin of candidates) {
        if (!origin) continue;
        if (origin.el?.isConnected && focusable(origin.el)) {
          origin.el.focus();
          return;
        }
        if (origin.region?.isConnected && focusFirstIn(origin.region)) return;
      }
    });
    previousOriginRef.current = null;
  };

  const openEvent = (eventId: string, timeUs: number | null, trigger?: Element | null) => {
    const next = captureOrigin(trigger);
    const current = originRef.current;
    previousOriginRef.current = current.el || current.region ? current : null;
    originRef.current = next;
    setEvidenceOpen(false);
    // 先写共享 selection：配对里点对照事件也只是换正文，不改当前调查运行
    selectEvent(eventId, timeUs);
    setReader({ eventId, timeUs });
  };

  /** 阅读区读到真实时微秒后回填 selection；仍是同一事件才更新，避免覆盖更新的选择。 */
  const resolvedEventTime = (eventId: string, timeUs: number) => {
    const selection = stateRef.current.selection;
    if (selection?.kind === "event" && selection.id === eventId && selection.timeUs !== timeUs) {
      selectEvent(eventId, timeUs);
    }
    setReader((current) => (current && current.eventId === eventId ? { eventId, timeUs } : current));
  };

  const requestLocate = (key: LocateKey) => {
    locateSeq.current += 1;
    setLocate({ key, seq: locateSeq.current });
  };

  /**
   * 显式切换运行：reducer 会清空 selection，页面也必须关掉旧正文，
   * 否则会出现“正文是 A、保存的 selection 为空/属于 B”的错配。
   */
  const openRun = (id: string, options: { complete?: boolean } = {}) => {
    if (missingSet.has(id)) return;
    setReader(null);
    setVisible((prev) => (prev.flow ? prev : { ...prev, flow: true }));
    requestLocate("analysis");
    dispatch({ type: "openRun", runId: id, complete: options.complete });
  };

  const openPair = (id: string, baseline: string | null = null, options: { complete?: boolean } = {}) => {
    if (missingSet.has(id) || (baseline && missingSet.has(baseline))) return;
    setReader(null);
    setVisible((prev) => (prev.pair ? prev : { ...prev, pair: true }));
    requestLocate("analysis");
    dispatch({ type: "openRun", runId: id, baselineRunId: baseline, compare: true, complete: options.complete });
  };

  /** 冻结案例按身份分流：有指定 baseline 才进配对，正常案例进单运行（不请求配对接口）。 */
  const openCase = (id: string, baseline: string | null) => {
    if (baseline) openPair(id, baseline, { complete: true });
    else openRun(id, { complete: true });
  };

  const backToCollection = () => {
    setReader(null);
    setPanel(null);
    changeTask("overview", "runs");
    requestLocate("overview");
  };

  /**
   * 返回运行必须让目标真的可见：流程先前被手动隐藏时也要展开，
   * 否则对象 chip 已是运行、页面却只剩概览（复验 R3-return）。
   */
  const backToRun = () => {
    setVisible((prev) => (prev.flow ? prev : { ...prev, flow: true }));
    changeTask("trace", "run");
    requestLocate("analysis");
  };

  // ---------- 面板与显隐 ----------
  useEffect(() => {
    if (evidenceOpen && reader) setReader(null);
    // 证据抽屉与阅读面板互斥：不叠两个竞争空间的辅助区
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evidenceOpen]);

  useEffect(() => {
    if (!reader) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeReader();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader]);

  /**
   * 只在显式打开/恢复后定位一次：等目标挂载（工具卡、配对图可能还没渲染），
   * 平滑滚动后若标题仍不在视口上半区，再用即时滚动校正。
   * 普通显隐、数据返回与关闭都不会触发这里。
   */
  useEffect(() => {
    if (!locate) return;
    const targets: Record<LocateKey, { current: HTMLElement | null }> = {
      overview: overviewRef,
      analysis: analysisRef,
      system: systemRef,
      graph: graphRef,
      window: windowRef,
      events: eventsRef,
    };
    let frame = 0;
    let settle: number | undefined;
    let tries = 0;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const el = targets[locate.key].current;
      if (!el || el.getBoundingClientRect().height === 0) {
        if (tries < 40) {
          tries += 1;
          frame = window.requestAnimationFrame(run);
        }
        return;
      }
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      settle = window.setTimeout(() => {
        if (cancelled) return;
        const box = el.getBoundingClientRect();
        const limit = window.innerHeight * 0.5;
        if (box.top < 0 || box.top > limit) el.scrollIntoView({ block: "start", behavior: "auto" });
        setLocate((current) => (current && current.seq === locate.seq ? null : current));
      }, 420);
    };
    frame = window.requestAnimationFrame(run);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      if (settle != null) window.clearTimeout(settle);
    };
  }, [locate]);

  // ---------- 恢复 ----------
  const lastRestore = useRef(restoreSeq);
  const handledFindings = useRef("");
  useEffect(() => {
    if (lastRestore.current === restoreSeq) return;
    lastRestore.current = restoreSeq;
    // 恢复落点先展开区域，再打开有效对象；缺失引用只保留通知
    setVisible({ overview: true, flow: true, pair: true });
    const selection = state.selection;
    if (selection?.kind === "event" && !missingSet.has(selection.id)) {
      setReader({ eventId: selection.id, timeUs: selection.timeUs });
    } else {
      setReader(null);
    }
    // 按恢复意图定位：运行/配对→分析区，工具快照→对应工具卡，集合→概览
    const restoredRun = state.traceObject.dataset === "CUSTOM" ? state.traceObject.runId : null;
    if (state.task === "compare" && state.mode === "window") requestLocate("window");
    else if (state.task === "compare" && state.mode === "runPair") requestLocate(restoredRun ? "analysis" : "overview");
    else if (state.mode === "relations" || state.mode === "localGraph") requestLocate("graph");
    else if (state.task === "overview" && state.mode === "time") requestLocate("system");
    else if (restoredRun) requestLocate("analysis");
    else if (state.task === "overview") requestLocate("overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreSeq]);

  useEffect(() => {
    if (state.task !== "findings") return;
    const key = `${state.task}/${state.mode}/${restoreSeq}`;
    if (handledFindings.current === key) return;
    handledFindings.current = key;
    setEvidenceTab(state.mode === "notes" ? "notes" : "basket");
    setEvidenceOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.task, state.mode, restoreSeq]);

  const openTool = (next: "events" | "system" | "graph" | "window" | "basket" | "notes") => {
    if (next === "events") {
      const opening = panel !== "events";
      setPanel(opening ? "events" : null);
      if (opening) requestLocate("events");
    }
    else if (next === "system") {
      changeTask("overview", "time");
      requestLocate("system");
    }
    else if (next === "graph") {
      changeTask("overview", "relations");
      requestLocate("graph");
    }
    else if (next === "window") {
      changeTask("compare", "window");
      requestLocate("window");
    }
    else {
      setEvidenceTab(next === "notes" ? "notes" : "basket");
      setEvidenceOpen(true);
    }
  };

  const closeTool = () => {
    if (state.dataset !== "CUSTOM") return;
    // 关工具卡不能顺手清掉当前运行：有运行就回到角色流程，没有才回集合
    if (runId) changeTask("trace", "run");
    else changeTask("overview", "runs");
  };

  const closeTools = (node: HTMLElement) => node.closest("details")?.removeAttribute("open");
  const toggleChart = (key: ChartKey) => setVisible((prev) => ({ ...prev, [key]: !prev[key] }));

  const toggleButton = (key: ChartKey, label: string, disabled = false) => (
    <button
      key={key}
      type="button"
      className={`custom-toggle${visible[key] ? " is-on" : ""}`}
      aria-pressed={visible[key]}
      disabled={disabled}
      title={disabled ? "先选择一个运行" : undefined}
      onClick={() => toggleChart(key)}
    >
      {label}
    </button>
  );

  const objectLabel = pairOpen
    ? `配对 ${runId?.replace(/^run-/, "").slice(0, 8) ?? "—"} ↔ ${(pairBaseline ?? "自动解析").replace(/^run-/, "").slice(0, 8)}`
    : runId
      ? `运行 ${runId.replace(/^run-/, "").slice(0, 8)}`
      : "未选择运行";

  const collectionLabel = [
    collection.model,
    collection.fixture ? collection.fixture.split("/").pop() : null,
    collection.scenario,
    collection.observed === null ? null : `observed=${collection.observed}`,
  ].filter(Boolean).join(" · ") || "无集合条件";

  // 当前模式决定唯一分析组件，再由该模式自己的可见开关决定显隐：
  // 隐藏配对时不能偷偷回退成角色流程。
  const pairShown = pairOpen && visible.pair;
  const flowShown = !pairOpen && !!runId && visible.flow;
  const analysisShown = pairShown || flowShown;
  const pairHidden = pairOpen && !visible.pair;
  const toolOpen = systemOpen || graphOpen || windowOpen || panel === "events";

  return (
    <div className="custom-page" data-testid="custom-page">
      <div className="custom-topbar">
        <span className="custom-scope-chip" data-testid="custom-collection-chip">
          集合：{collectionLabel}
          {collectionActive && (
            <button type="button" className="custom-chip-action" onClick={clearCollection}>
              清除
            </button>
          )}
        </span>
        <span className="custom-scope-chip custom-anchor-accent" data-testid="custom-object-chip">
          {objectLabel}
        </span>
        <div className="custom-toggles" role="group" aria-label="图表显隐">
          {toggleButton("overview", "概览")}
          {toggleButton("flow", "运行流程", !runId)}
          {toggleButton("pair", "配对", !runId)}
          <button
            type="button"
            className={`custom-toggle${filtersOpen ? " is-on" : ""}`}
            aria-pressed={filtersOpen}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((value) => !value)}
          >
            集合筛选
          </button>
          <details className="custom-tools">
            <summary>工具</summary>
            <div className="custom-tools-menu">
              <button
                type="button"
                aria-pressed={panel === "events"}
                onClick={(event) => {
                  openTool("events");
                  closeTools(event.currentTarget);
                }}
              >
                事件查询
              </button>
              <button
                type="button"
                aria-pressed={systemOpen}
                onClick={(event) => {
                  openTool("system");
                  closeTools(event.currentTarget);
                }}
              >
                系统总览
              </button>
              <button
                type="button"
                aria-pressed={graphOpen}
                onClick={(event) => {
                  openTool("graph");
                  closeTools(event.currentTarget);
                }}
              >
                实体关系
              </button>
              <button
                type="button"
                aria-pressed={windowOpen}
                onClick={(event) => {
                  openTool("window");
                  closeTools(event.currentTarget);
                }}
              >
                时间窗对照
              </button>
              <button
                type="button"
                onClick={(event) => {
                  openTool("basket");
                  closeTools(event.currentTarget);
                }}
              >
                案例与证据
              </button>
              <button
                type="button"
                onClick={(event) => {
                  openTool("notes");
                  closeTools(event.currentTarget);
                }}
              >
                笔记
              </button>
              <button
                type="button"
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  clearFilters();
                }}
              >
                清空事件筛选
              </button>
            </div>
          </details>
        </div>
      </div>

      <div className="custom-context" data-testid="custom-context">
        <span className="tag" title="集合来自 /api/runs?include_stages=true，为完整运行摘要；关键词与时间窗只作用于运行内事件。">
          集合=完整运行摘要
        </span>
        {pairOpen ? (
          <span className="tag" title="配对比较两次完整运行，不受附加事件筛选、时间窗或回放游标重算。">
            配对=完整运行，回放不生效
          </span>
        ) : (
          <span className="tag" title="运行内事件按该运行起点显示相对时间，不与其它运行对齐绝对日期。">
            运行内=相对起点时间
          </span>
        )}
        {masking && cursor != null && runId && !pairOpen && (
          <span className="tag">回放遮蔽：{formatUtc(cursor)} 之后不显示</span>
        )}
        {!masking && <span className="tag tag-warn">回放遮蔽已关闭：运行流程按全量显示</span>}
        {hasEventFilters && <span className="tag tag-warn">事件条件生效中（不改变集合）</span>}
      </div>

      <CasePicker onOpen={openCase} onOpenEvent={openEvent} />

      <div className="custom-body">
        <div className={`custom-layout${reader ? " with-reader" : ""}`}>
          <div className="custom-main">
            {visible.overview && (
              <div ref={(node) => { overviewRef.current = node; }}>
                <RunOverview
                  activeRunId={runId}
                  showFilters={filtersOpen}
                  onOpenRun={openRun}
                  onOpenEvent={openEvent}
                />
              </div>
            )}

            {analysisShown && (
              <div ref={(node) => { analysisRef.current = node; }} className="custom-analysis">
                {pairShown ? (
                  <RunCompare
                    runId={runId!}
                    baselineRunId={pairBaseline}
                    missingRun={runMissing}
                    missingBaseline={baselineMissing}
                    onBack={backToRun}
                    onOpenEvent={openEvent}
                  />
                ) : (
                  <RunTimeline
                    runId={runId!}
                    missing={runMissing}
                    onBack={backToCollection}
                    onCompare={(id) => openPair(id)}
                    onClearEventFilters={clearFilters}
                    hasEventFilters={hasEventFilters}
                    onOpenEvent={openEvent}
                  />
                )}
              </div>
            )}

            {pairHidden && (
              <section className="custom-card" aria-label="配对已隐藏" data-testid="custom-hidden-pair">
                <p className="muted small">
                  当前对象是<b>配对</b>，但配对图已被隐藏。用上方「配对」按钮恢复，或点「返回运行」回到角色流程。
                </p>
                <div className="custom-card-actions">
                  <button type="button" className="btn btn-quiet" onClick={() => setVisible((prev) => ({ ...prev, pair: true }))}>
                    显示配对
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={backToRun}>
                    返回运行
                  </button>
                </div>
              </section>
            )}

            {!runId && (
              <section className="custom-card" aria-label="分析区提示">
                <p className="muted small">
                  从上方概览点一个运行进入角色流程，或点「冻结案例」按指定运行/对照打开。
                  先选运行再选阶段样本最省一步；概览始终是完整运行摘要。
                </p>
              </section>
            )}

            {systemOpen && (
              <section className="custom-card" aria-label="系统总览" ref={(node) => { systemRef.current = node; }}>
                <header className="custom-card-head">
                  <h2>系统总览（当前活动 + 全局背景）</h2>
                  <p className="muted small">
                    前景按当前运行/事件条件与回放游标重建；背景是忽略局部时间窗与非时间筛选的全局对照。
                  </p>
                  <button type="button" className="btn btn-quiet" onClick={closeTool}>
                    关闭
                  </button>
                </header>
                <OverviewView compact />
              </section>
            )}

            {graphOpen && (
              <section className="custom-card" aria-label="实体关系" ref={(node) => { graphRef.current = node; }}>
                <header className="custom-card-head">
                  <h2>实体关系（局部）</h2>
                  <p className="muted small">
                    以当前焦点实体为中心展开；CUSTOM 的实体关系可能为空，空态说明而不是补造关系。
                  </p>
                  <button type="button" className="btn btn-quiet" onClick={closeTool}>
                    关闭
                  </button>
                </header>
                <RelationGraph />
              </section>
            )}

            {windowOpen && (
              <section className="custom-card" aria-label="时间窗对照" ref={(node) => { windowRef.current = node; }}>
                <header className="custom-card-head">
                  <h2>时间窗对照</h2>
                  <p className="muted small">当前时间窗与等长前一窗口比较；这是事件密度对照，不是运行阶段对照。</p>
                  <button type="button" className="btn btn-quiet" onClick={closeTool}>
                    关闭
                  </button>
                </header>
                <CompareView />
              </section>
            )}

            {panel === "events" && (
              <section className="custom-card" aria-label="事件查询" ref={eventsRef}>
                <header className="custom-card-head">
                  <h2>事件查询</h2>
                  <p className="muted small">
                    与当前运行、事件筛选和回放遮蔽一致；点行在同一阅读区打开原始记录。
                  </p>
                  <button type="button" className="btn btn-quiet" onClick={() => setPanel(null)}>
                    关闭
                  </button>
                </header>
                <EventStream onOpenEvent={(item) => openEvent(item.event_id, item.time_us, document.activeElement)} />
              </section>
            )}

            {!visible.overview && !analysisShown && !pairHidden && (
              <section className="custom-card" aria-label="隐藏提示">
                <p className="muted small">
                  {!toolOpen
                    ? "概览与运行流程都已隐藏：用上方显隐按钮恢复，或从工具菜单打开事件查询/系统总览。"
                    : "概览与运行流程已隐藏；工具卡仍可在上方显隐按钮恢复。"}
                </p>
              </section>
            )}
          </div>

          {reader && (
            <aside className="custom-aside" aria-label="当前事件">
              <CustomReader
                key={reader.eventId}
                eventId={reader.eventId}
                timeUs={reader.timeUs}
                currentRunId={runId}
                baselineRunId={pairBaseline}
                onClose={closeReader}
                onResolvedTime={resolvedEventTime}
              />
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
