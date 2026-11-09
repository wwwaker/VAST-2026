import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import {
  fetchCapabilities,
  fetchDatasets,
  fetchTraceRoots,
  formatUtc,
  type Capabilities,
  type DatasetInfo,
  type TraceRootItem,
} from "../../data/api";
import { EventStream } from "../../components/EventStream";
import { OverviewView } from "../OverviewView";
import { CompareView } from "../CompareView";
import { RelationGraph } from "../RelationGraph";
import { Mc2TraceCard } from "./Mc2TraceCard";
import { Mc2EntityReader, Mc2EventReader, Mc2FileReader, Mc2Reader, type FileKind } from "./Mc2Reader";
import { Mc2FileSearch } from "./Mc2FileSearch";
import { SystemMap } from "./SystemMap";
import { PatternCompare } from "./PatternCompare";
import { InterventionPanel } from "./InterventionPanel";
import { TransitionMatrix } from "./TransitionMatrix";

/** 同一时刻只有一个阅读对象：事件、文件轨迹或聚合成员。 */
type Reader =
  | { kind: "event"; eventId: string; timeUs: number | null }
  | { kind: "file"; fileId: string; path: string }
  | { kind: "entity"; entityId: string; label: string };

/** 关闭阅读面板后要还的焦点：优先原控件，原控件已卸载时退回它所在的区域控件。 */
interface FocusOrigin {
  el: Element | null;
  region: Element | null;
}

/** 来源链结果摘要：恢复后的文件身份按“当前链根”重新判断。 */
interface TraceSummary {
  rootId: string | null;
  recorded: string[];
  candidates: string[];
}

type QueryPanel = "events" | "files" | null;
type ChartToggle = "chain" | "activity" | "system";

const HALF_HOUR_US = 1_800_000_000;

/**
 * MC2 单页（F2）：沿用 F1 MC1 的控制条、卡片、图表显隐和唯一阅读面板。
 * 一份调查状态（task/mode、traceObject、selection、comparison、干预位置、时间窗/游标）
 * 驱动来源链、活动分布、系统背景、历史实例、干预、转移与对照；页面不持有第二份时间或筛选。
 * 旧四任务/模式/视图标签不再渲染，恢复旧快照时按 task/mode 展开对应卡片。
 */
export function Mc2ReferencePage() {
  const {
    dataset,
    state,
    filters,
    setFilters,
    clearFilters,
    cursor,
    masking,
    changeTask,
    openTrace,
    dispatch,
    evidenceOpen,
    setEvidenceOpen,
    setEvidenceTab,
    selectEvent,
    traceRootId,
    traceFileId,
    restoreSeq,
    restoreMissing,
    restoreDataset,
  } = useWorkspace();

  const [visible, setVisible] = useState<Record<ChartToggle, boolean>>({
    chain: true,
    activity: true,
    system: true,
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [panel, setPanel] = useState<QueryPanel>(null);
  const [reader, setReader] = useState<Reader | null>(null);
  const [info, setInfo] = useState<DatasetInfo | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [roots, setRoots] = useState<TraceRootItem[]>([]);
  const [traceSummary, setTraceSummary] = useState<TraceSummary | null>(null);

  const chainRef = useRef<HTMLElement | null>(null);
  const historyRef = useRef<HTMLElement | null>(null);
  const interventionRef = useRef<HTMLElement | null>(null);
  const matrixRef = useRef<HTMLElement | null>(null);
  const compareRef = useRef<HTMLElement | null>(null);
  const graphRef = useRef<HTMLElement | null>(null);
  const eventsRef = useRef<HTMLElement | null>(null);
  const filesRef = useRef<HTMLElement | null>(null);
  const originRef = useRef<FocusOrigin>({ el: null, region: null });
  const previousOriginRef = useRef<FocusOrigin | null>(null);

  // 卡片与工具全部由共享 task/mode 推导，恢复旧快照即可落到对应区域
  const historyOpen = state.task === "compare" && state.mode === "history";
  const matrixOpen = state.task === "compare" && state.mode === "transitions";
  const compareOpen = state.task === "compare" && state.mode === "window";
  const interventionOpen = state.mode === "intervention";
  const graphOpen = state.mode === "relations" || state.mode === "localGraph";
  const toolOpen = historyOpen || matrixOpen || compareOpen || interventionOpen || graphOpen;

  useEffect(() => {
    if (dataset !== "MC2") return;
    const controller = new AbortController();
    fetchDatasets(controller.signal)
      .then((list) => !controller.signal.aborted && setInfo(list.find((item) => item.dataset_id === "MC2") ?? null))
      .catch(() => !controller.signal.aborted && setInfo(null));
    return () => controller.abort();
  }, [dataset]);

  useEffect(() => {
    if (dataset !== "MC2") return;
    const controller = new AbortController();
    fetchCapabilities("MC2", controller.signal)
      .then((data) => !controller.signal.aborted && setCaps(data))
      .catch(() => !controller.signal.aborted && setCaps(null));
    return () => controller.abort();
  }, [dataset]);

  useEffect(() => {
    if (dataset !== "MC2") return;
    const controller = new AbortController();
    fetchTraceRoots(controller.signal)
      .then((data) => !controller.signal.aborted && setRoots(data.items))
      .catch(() => !controller.signal.aborted && setRoots([]));
    return () => controller.abort();
  }, [dataset]);

  const targetAnchor = useMemo(
    () => info?.anchors.find((anchor) => anchor.key === "target_post") ?? null,
    [info],
  );

  // 恢复快照判定缺失的引用：任何恢复落点（选择、当前文件、链根）都不得再请求它们
  const missingSet = useMemo(() => new Set(restoreMissing), [restoreMissing]);

  /**
   * 首次进入没有链根时，用 manifest 的目标帖作为默认根；只写追踪对象，不改时间窗、不入返回栈。
   * 只有“当前这份调查来自 MC2 快照”才让快照的无根状态生效；切换数据集后的新调查
   * 按默认初始化（restoreSeq 是全会话计数，不能用来判断当前调查的来历）。
   */
  const restoredHere = restoreDataset === "MC2";
  useEffect(() => {
    if (dataset !== "MC2" || traceRootId || restoredHere) return;
    if (!info || roots.length === 0) return;
    const targetUs = targetAnchor?.time_us ?? null;
    const match = targetUs != null ? roots.find((item) => Math.abs(item.time_us - targetUs) < 1_000_000) : null;
    const chosen = match ?? roots[0];
    if (chosen) dispatch({ type: "traceRoot", rootEventId: chosen.event_id });
  }, [dataset, traceRootId, restoredHere, info, roots, targetAnchor, dispatch]);

  // 打开工具卡后滚到它；关闭时留在当前页
  useEffect(() => {
    const target = interventionOpen ? interventionRef.current
      : historyOpen ? historyRef.current
        : matrixOpen ? matrixRef.current
          : compareOpen ? compareRef.current
            : graphOpen ? graphRef.current
              : null;
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [state.task, state.mode, interventionOpen, historyOpen, matrixOpen, compareOpen, graphOpen]);

  // 证据面板与阅读面板互斥：不叠两个竞争空间的辅助区
  useEffect(() => {
    if (evidenceOpen) setReader(null);
  }, [evidenceOpen]);

  // 恢复 findings/claims|notes 快照时打开证据面板；同一 task/mode 的普通操作不重复触发
  const handledIntent = useRef("");
  useEffect(() => {
    if (state.task !== "findings") return;
    const key = `${state.task}/${state.mode}/${restoreSeq}`;
    if (handledIntent.current === key) return;
    handledIntent.current = key;
    setEvidenceTab(state.mode === "notes" ? "notes" : "basket");
    setEvidenceOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.task, state.mode, restoreSeq]);

  // 恢复调查后重新落到阅读面板：先展开被隐藏的来源区域，再打开有效对象。
  // 有效事件优先，其次当前文件；缺失引用只保留通知，不打开、也不请求已知缺失的对象。
  const lastRestore = useRef(restoreSeq);
  const pendingChainScroll = useRef(false);
  useEffect(() => {
    if (lastRestore.current === restoreSeq) return;
    lastRestore.current = restoreSeq;

    const wantsChain =
      state.task === "trace" ||
      state.selection != null ||
      traceRootId != null ||
      traceFileId != null;
    const wantsActivity = state.task === "overview";
    if (wantsChain || wantsActivity) {
      setVisible((prev) => ({
        ...prev,
        chain: prev.chain || wantsChain,
        activity: prev.activity || wantsActivity,
      }));
    }
    if (wantsChain) pendingChainScroll.current = true;

    if (state.selection?.kind === "event" && !missingSet.has(state.selection.id)) {
      setReader({ kind: "event", eventId: state.selection.id, timeUs: state.selection.timeUs });
      return;
    }
    // selection 与 traceObject 可能指向同一文件；两者都要过缺失检查，避免备用分支请求 404
    const fileId = state.selection?.kind === "file" ? state.selection.id : traceFileId;
    if (fileId && !missingSet.has(fileId)) {
      setReader({
        kind: "file",
        fileId,
        path: fileId.replace(/^MC2:file_path:/, ""),
      });
      return;
    }
    // 恢复的调查没有可读对象（或全部缺失）：关闭旧阅读面板，不留上一个调查的正文
    setReader(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreSeq]);

  // 来源区域展开后（ref 出现）再滚动，避免在隐藏状态下找不到落点
  useEffect(() => {
    if (!pendingChainScroll.current || !visible.chain) return;
    pendingChainScroll.current = false;
    chainRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [visible.chain, state.task, state.mode, traceRootId]);

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

  /** 当前触发控件优先；它已卸载（如文件行切换成事件）时退回仍可见的上一级触发控件或区域控件。 */
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

  /** Escape 先关阅读面板（捕获阶段），不让全局快捷键顺手清掉时间窗。 */
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

  /** 记录触发控件及其所在卡片/阅读区；SVG 的 g 也算可聚焦触发控件。 */
  const captureOrigin = (trigger?: Element | null): FocusOrigin => {
    const el = trigger instanceof Element
      ? trigger
      : document.activeElement instanceof Element
        ? document.activeElement
        : null;
    return { el, region: el?.closest?.(".mc2-card, .mc2-aside") ?? null };
  };

  /** 换阅读对象时保留上一级触发控件，供“原控件已卸载”的回焦回退使用。 */
  const beginReader = (origin: FocusOrigin) => {
    const current = originRef.current;
    previousOriginRef.current = current.el || current.region ? current : null;
    originRef.current = origin;
  };

  const openEvent = (eventId: string, timeUs: number | null, trigger?: Element | null) => {
    beginReader(captureOrigin(trigger));
    setEvidenceOpen(false);
    selectEvent(eventId, timeUs);
    setReader({ kind: "event", eventId, timeUs });
  };

  // 第三个参数是调用方（来源链/搜索）的点击语境，身份不在这里判定：一律按当前链根结果重算
  const openFile = (fileId: string, path: string, _clickedCandidate = false, trigger?: Element | null) => {
    beginReader(captureOrigin(trigger));
    setEvidenceOpen(false);
    dispatch({ type: "traceFile", fileId });
    setReader({ kind: "file", fileId, path });
  };

  const openEntity = (entityId: string, label: string, trigger?: Element | null) => {
    beginReader(captureOrigin(trigger));
    setEvidenceOpen(false);
    // 成员点击同时写入图焦点：实体关系工具由此有中心，快照也能恢复
    dispatch({ type: "focus", id: entityId });
    setReader({ kind: "entity", entityId, label });
  };

  const locateTarget = () => {
    const targetUs = targetAnchor?.time_us ?? null;
    const match = targetUs != null ? roots.find((item) => Math.abs(item.time_us - targetUs) < 1_000_000) : null;
    const chosen = match ?? roots[0];
    if (!chosen) return;
    // 显式定位要能找回被隐藏的来源图，再滚动到它
    setVisible((prev) => ({ ...prev, chain: true }));
    openTrace({ rootEventId: chosen.event_id, fileId: chosen.file_id });
    pendingChainScroll.current = true;
  };

  const windowTarget = () => {
    if (targetAnchor?.time_us == null) return;
    setFilters({ startUs: targetAnchor.time_us - HALF_HOUR_US, endUs: targetAnchor.time_us + HALF_HOUR_US });
  };

  const openTool = (next: "history" | "matrix" | "compare" | "intervention" | "graph") => {
    if (next === "history") changeTask("compare", "history");
    else if (next === "matrix") changeTask("compare", "transitions");
    else if (next === "compare") changeTask("compare", "window");
    else if (next === "intervention") changeTask("trace", "intervention");
    else changeTask("overview", "relations");
    setPanel(null);
  };

  const closeTool = () => {
    setPanel(null);
    if (state.task !== "overview" || state.mode !== "time") changeTask("overview", "time");
  };

  const toggleChart = (key: ChartToggle) => setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  const closeTools = (node: HTMLElement) => node.closest("details")?.removeAttribute("open");

  // 打开查询工具后滚到卡片，避免它出现在系统背景下方而看不见
  useEffect(() => {
    if (!panel) return;
    const target = panel === "events" ? eventsRef.current : filesRef.current;
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [panel]);

  const fullRange =
    info?.start_us != null && info.end_us != null
      ? `${formatUtc(info.start_us)} → ${formatUtc(info.end_us)}`
      : null;
  const windowLabel =
    filters.startUs != null && filters.endUs != null
      ? `${formatUtc(filters.startUs)} → ${formatUtc(filters.endUs)}`
      : `全时间范围${fullRange ? `（${fullRange}）` : ""}`;

  const toggleButton = (key: ChartToggle, label: string) => (
    <button
      key={key}
      type="button"
      className={`mc2-toggle${visible[key] ? " is-on" : ""}`}
      aria-pressed={visible[key]}
      onClick={() => toggleChart(key)}
    >
      {label}
    </button>
  );

  const readerFile = reader?.kind === "file" ? reader : null;
  // 来源链被隐藏时不再保留上一份链结果，文件身份退回“待核实”
  useEffect(() => {
    if (!visible.chain) setTraceSummary(null);
  }, [visible.chain]);
  /**
   * 文件身份只认“当前链根的真实来源链结果”：不在结果里的文件（例如换根后仍开着的旧文件）
   * 一律是“关系待核实”，不沿用打开时的点击语境，避免旧候选/旧记录身份串到新根上。
   */
  const fileKind: FileKind | null = useMemo(() => {
    if (!readerFile) return null;
    if (!traceSummary || traceSummary.rootId !== traceRootId) return "unknown";
    if (traceSummary.candidates.includes(readerFile.fileId)) return "candidate";
    if (traceSummary.recorded.includes(readerFile.fileId)) return "recorded";
    return "unknown";
  }, [readerFile, traceSummary, traceRootId]);

  return (
    <div className="mc2-page" data-testid="mc2-page">
      <div className="mc2-topbar">
        <button
          type="button"
          className="mc2-target-btn"
          data-testid="mc2-target-post"
          onClick={locateTarget}
          title="定位日志 2046-05-17T11:21:15Z 的目标帖（设为链根并打开其内容文件）；不会改动时间窗或筛选"
        >
          <span>定位目标帖</span>
          <span className="mono">{targetAnchor ? formatUtc(targetAnchor.time_us) : "11:21Z"}</span>
        </button>
        <div className="mc2-toggles" role="group" aria-label="图表显隐">
          {toggleButton("chain", "来源链")}
          {toggleButton("activity", "活动分布")}
          {toggleButton("system", "系统背景")}
          <button
            type="button"
            className={`mc2-toggle${filtersOpen ? " is-on" : ""}`}
            aria-pressed={filtersOpen}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((value) => !value)}
          >
            筛选
          </button>
          <details className="mc2-tools">
            <summary>工具</summary>
            <div className="mc2-tools-menu">
              <button
                type="button"
                aria-pressed={panel === "events"}
                onClick={(event) => {
                  setPanel((current) => (current === "events" ? null : "events"));
                  closeTools(event.currentTarget);
                }}
              >
                事件查询
              </button>
              <button
                type="button"
                aria-pressed={panel === "files"}
                onClick={(event) => {
                  setPanel((current) => (current === "files" ? null : "files"));
                  closeTools(event.currentTarget);
                }}
              >
                文件查询
              </button>
              <button
                type="button"
                aria-pressed={historyOpen}
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  if (historyOpen) closeTool();
                  else openTool("history");
                }}
              >
                历史实例
              </button>
              <button
                type="button"
                aria-pressed={interventionOpen}
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  if (interventionOpen) closeTool();
                  else openTool("intervention");
                }}
              >
                干预论证
              </button>
              <button
                type="button"
                aria-pressed={matrixOpen}
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  if (matrixOpen) closeTool();
                  else openTool("matrix");
                }}
              >
                转移矩阵
              </button>
              <button
                type="button"
                aria-pressed={compareOpen}
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  if (compareOpen) closeTool();
                  else openTool("compare");
                }}
              >
                时间窗对照
              </button>
              <button
                type="button"
                aria-pressed={graphOpen}
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  if (graphOpen) closeTool();
                  else openTool("graph");
                }}
              >
                实体关系
              </button>
              <button
                type="button"
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  setEvidenceTab("basket");
                  setEvidenceOpen(true);
                }}
              >
                案例与证据
              </button>
              <button
                type="button"
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  clearFilters();
                }}
              >
                清空筛选
              </button>
            </div>
          </details>
        </div>
      </div>

      <div className="mc2-context">
        <span className="mc2-window mono">{windowLabel}</span>
        <span className="mc2-anchor-chip mc2-anchor-accent">
          <span>目标帖子</span>
          <span className="mono">{targetAnchor ? formatUtc(targetAnchor.time_us) : "缺口"}</span>
          <button type="button" className="mc2-anchor-action" onClick={locateTarget} title="设为链根并打开内容文件（不改筛选）">
            定位
          </button>
          <button
            type="button"
            className="mc2-anchor-action"
            data-testid="mc2-target-window"
            onClick={windowTarget}
            title="把统一时间窗定位到目标帖前后 30 分钟"
          >
            ±30m
          </button>
        </span>
        <span className="tag" title="系统背景是类型级全量聚合与静态组织边，不随时间/关键词筛选变化。">
          系统背景=全量类型聚合
        </span>
        <span className="tag" title="历史实例与干预基于全量发布实例/日志，不受当前筛选与时间窗影响。">
          历史/干预=固定全量分析
        </span>
        {masking && cursor != null ? (
          <span className="tag">回放遮蔽：{formatUtc(cursor)} 之后不显示</span>
        ) : (
          <span className="tag tag-warn">回放遮蔽已关闭：图表按全量显示</span>
        )}
      </div>

      <div className={`mc2-body${filtersOpen ? " with-filters" : ""}`}>
        {filtersOpen && (
          <aside className="mc2-filters" aria-label="筛选面板">
            <div className="mc2-filter-group">
              <h3>时间范围</h3>
              <p className="muted small mono">{windowLabel}</p>
              <button type="button" className="btn btn-quiet" onClick={() => setFilters({ startUs: null, endUs: null })}>
                重置为全范围
              </button>
            </div>
            <div className="mc2-filter-group">
              <h3>事件类别</h3>
              <div className="mc2-chips">
                <button
                  type="button"
                  className={`mc2-chip${filters.categories.length === 0 ? " is-on" : ""}`}
                  onClick={() => setFilters({ categories: [] })}
                >
                  全部类别
                </button>
                {(caps?.categories ?? []).map((category) => {
                  const on = filters.categories.includes(category.id);
                  return (
                    <button
                      key={category.id}
                      type="button"
                      className={`mc2-chip${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      onClick={() =>
                        setFilters({
                          categories: on
                            ? filters.categories.filter((id) => id !== category.id)
                            : [...filters.categories, category.id],
                        })
                      }
                    >
                      {category.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <details className="mc2-filter-group">
              <summary>精确事件类型（{(caps?.types ?? []).length}）</summary>
              <div className="mc2-chips">
                {(caps?.types ?? []).map((type) => {
                  const on = filters.eventTypes.includes(type.type);
                  return (
                    <button
                      key={type.type}
                      type="button"
                      className={`mc2-chip${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      title={type.display_label}
                      onClick={() =>
                        setFilters({
                          eventTypes: on
                            ? filters.eventTypes.filter((item) => item !== type.type)
                            : [...filters.eventTypes, type.type],
                        })
                      }
                    >
                      {type.type}
                    </button>
                  );
                })}
              </div>
            </details>
            <div className="mc2-filter-group">
              <h3>关键词</h3>
              <p className="muted small">
                {filters.keyword ? <span className="mono">{filters.keyword}</span> : "未设置（在顶栏搜索）"}
              </p>
            </div>
            {filters.actorId && (
              <div className="mc2-filter-group">
                <h3>执行者</h3>
                <p className="muted small mono">{filters.actorId}</p>
                <button type="button" className="btn btn-quiet" onClick={() => setFilters({ actorId: null })}>
                  清除执行者
                </button>
              </div>
            )}
            <div className="mc2-filter-group">
              <h3>范围例外</h3>
              <p className="muted small">
                时间/类别/关键词/执行者只作用于来源链文件操作、活动分布、文件轨迹、事件查询与转移矩阵；
                系统背景、历史实例与干预论证固定使用全量聚合，卡片上单独标注。
              </p>
            </div>
            {state.notice && (
              <div className="mc2-filter-group">
                <h3>当前状态</h3>
                <p className="muted small">{state.notice}</p>
              </div>
            )}
          </aside>
        )}

        <div className={`mc2-layout${reader ? " with-reader" : ""}`}>
          <div className="mc2-main">
            {visible.chain && (
              <div ref={(node) => { chainRef.current = node; }}>
                <Mc2TraceCard
                  roots={roots}
                  onOpenEvent={openEvent}
                  onOpenFile={openFile}
                  activeFileId={traceFileId}
                  missingIds={restoreMissing}
                  onSummary={setTraceSummary}
                />
              </div>
            )}

            {visible.activity && (
              <section className="mc2-card" aria-label="活动时间分布">
                <header className="mc2-card-head">
                  <h2>活动时间分布</h2>
                  <p className="muted small">
                    复用 overview 聚合，作为时间定位辅助；横轴按真实时间线性映射，无记录时段留空而不是零活动。
                    拖动刷选会写入统一时间窗，点锚点可定位到该时刻 ±1 小时。
                  </p>
                </header>
                <OverviewView compact />
              </section>
            )}

            {visible.system && (
              <section className="mc2-card" aria-label="系统背景">
                <header className="mc2-card-head">
                  <h2>系统背景（类型聚合）</h2>
                  <p className="muted small">
                    不绘制逐个实体：按类型聚合成组，实际组数与规模以接口返回为准。点节点展开成员（真实 ID 与事件数），
                    点成员在阅读面板查看它当前筛选下的事件。组织边是静态结构，没有时间戳。
                  </p>
                </header>
                <SystemMap onPickMember={(entityId, label) => openEntity(entityId, label, document.activeElement)} />
              </section>
            )}

            {panel === "events" && (
              <section className="mc2-card" aria-label="事件查询" ref={eventsRef}>
                <header className="mc2-card-head">
                  <h2>事件查询</h2>
                  <p className="muted small">
                    与当前时间窗、筛选和回放遮蔽一致；点行在右侧阅读面板查看原始记录，方向键只在列表行获得焦点时生效。
                  </p>
                  <button type="button" className="btn btn-quiet" onClick={() => setPanel(null)}>
                    关闭
                  </button>
                </header>
                <EventStream onOpenEvent={(item) => openEvent(item.event_id, item.time_us, document.activeElement)} />
              </section>
            )}

            {panel === "files" && (
              <section className="mc2-card" aria-label="文件查询" ref={filesRef}>
                <header className="mc2-card-head">
                  <h2>文件查询</h2>
                  <button type="button" className="btn btn-quiet" onClick={() => setPanel(null)}>
                    关闭
                  </button>
                </header>
                <Mc2FileSearch
                  onOpenFile={openFile}
                />
              </section>
            )}

            {historyOpen && (
              <section className="mc2-card" aria-label="历史实例阶段对齐" ref={historyRef}>
                <header className="mc2-card-head">
                  <h2>历史实例阶段对齐</h2>
                  <p className="muted small">
                    固定全量分析：接口返回所有以文件为内容源的发布实例，不受当前筛选与时间窗影响；
                    缺失阶段保留“缺失”，不补零也不补假事件。
                  </p>
                  <button type="button" className="btn btn-quiet" onClick={closeTool}>
                    返回 MC2
                  </button>
                </header>
                <PatternCompare onOpenEvent={(eventId, trigger) => openEvent(eventId, null, trigger)} />
              </section>
            )}

            {interventionOpen && (
              <section className="mc2-card" aria-label="候选干预" ref={interventionRef}>
                <header className="mc2-card-head">
                  <h2>候选干预位置</h2>
                  <p className="muted small">
                    题目约束下最多一个活动选择；覆盖与附带影响来自全量日志，不随当前筛选变化。
                    “只有一个活动选择”不等于“证明唯一入口”。
                  </p>
                  <button type="button" className="btn btn-quiet" onClick={closeTool}>
                    返回 MC2
                  </button>
                </header>
                <InterventionPanel />
              </section>
            )}

            {matrixOpen && (
              <section className="mc2-card" aria-label="转移矩阵" ref={matrixRef}>
                <header className="mc2-card-head">
                  <h2>操作转移矩阵</h2>
                  <p className="muted small">
                    与当前筛选、时间窗和回放遮蔽一致；5/30 分钟切换只改变相邻对窗口。
                  </p>
                  <button type="button" className="btn btn-quiet" onClick={closeTool}>
                    返回 MC2
                  </button>
                </header>
                <TransitionMatrix onOpenEvent={(eventId, atUs, trigger) => openEvent(eventId, atUs, trigger)} />
              </section>
            )}

            {compareOpen && (
              <section className="mc2-card" aria-label="时间窗对照" ref={compareRef}>
                <header className="mc2-card-head">
                  <h2>时间窗对照</h2>
                  <p className="muted small">当前时间窗与等长前一窗口比较；基线可手选。下钻会保留返回点。</p>
                  <button type="button" className="btn btn-quiet" onClick={closeTool}>
                    返回 MC2
                  </button>
                </header>
                <CompareView />
              </section>
            )}

            {graphOpen && (
              <section className="mc2-card" aria-label="实体关系" ref={graphRef}>
                <header className="mc2-card-head">
                  <h2>实体关系（局部）</h2>
                  <p className="muted small">
                    以当前焦点实体为中心展开邻接，随筛选与回放变化；聚合组不是实体，成员展开后才给真实 ID。
                    没有焦点时，先在“系统背景”展开组并点成员，或在事件阅读面板的参与者里选择。
                  </p>
                  <button type="button" className="btn btn-quiet" onClick={closeTool}>
                    返回 MC2
                  </button>
                </header>
                <RelationGraph />
              </section>
            )}

            {!visible.chain && !visible.activity && !visible.system && !toolOpen && !panel && (
              <p className="muted small">所有图表已隐藏。用上方显隐按钮恢复来源链、活动分布或系统背景。</p>
            )}
          </div>

          {reader && (
            <aside className="mc2-aside" aria-label="当前对象">
              {reader.kind === "event" && (
                <Mc2Reader
                  ariaLabel="事件原始记录"
                  testId="mc2-event-detail"
                  title={`事件 ${reader.eventId.replace(/^MC2:event:/, "#")}`}
                  meta={
                    <>
                      {reader.timeUs != null ? formatUtc(reader.timeUs) : "时间待读取"} · 原始记录、来源文件与证据动作
                    </>
                  }
                  onClose={closeReader}
                >
                  <Mc2EventReader
                    eventId={reader.eventId}
                    timeUs={reader.timeUs}
                    onOpenFile={openFile}
                    onSetRoot={(eventId) => {
                      openTrace({ rootEventId: eventId });
                      setVisible((prev) => ({ ...prev, chain: true }));
                      pendingChainScroll.current = true;
                    }}
                  />
                </Mc2Reader>
              )}
              {readerFile && (
                <Mc2Reader
                  ariaLabel="文件轨迹"
                  testId="mc2-file-detail"
                  title={`文件轨迹 · ${readerFile.path}`}
                  meta={
                    <>
                      {fileKind === "candidate"
                        ? "候选文件（同名前缀提示，不等于传播证据）"
                        : fileKind === "recorded"
                          ? "当前链根记录的内容文件"
                          : "文件实体（与当前链根的关系待核实）"}
                      {" · "}单击事件行查看原始记录，“设为链根”按钮换根
                    </>
                  }
                  onClose={closeReader}
                >
                  <Mc2FileReader
                    key={readerFile.fileId}
                    fileId={readerFile.fileId}
                    kind={fileKind ?? "unknown"}
                    onOpenEvent={openEvent}
                    onPickRoot={(eventId) => {
                      openTrace({ rootEventId: eventId });
                      setVisible((prev) => ({ ...prev, chain: true }));
                      pendingChainScroll.current = true;
                    }}
                  />
                </Mc2Reader>
              )}
              {reader.kind === "entity" && (
                <Mc2Reader
                  ariaLabel="实体事件"
                  testId="mc2-entity-detail"
                  title={reader.label}
                  meta={<span className="mono small">{reader.entityId}</span>}
                  onClose={closeReader}
                >
                  <Mc2EntityReader
                    entityId={reader.entityId}
                    label={reader.label}
                    onOpenEvent={openEvent}
                  />
                </Mc2Reader>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
