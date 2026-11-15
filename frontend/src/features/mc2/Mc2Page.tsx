import { ShadowWorkspace } from "../../shared/ui/ShadowWorkspace";
import { WorkspaceSelect } from "./components/WorkspaceSelect";
import type { CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Activity,
  Network,
  Route,
  Files,
  Columns2,
  Share2,
  Grid2X2,
  GitCompareArrows,
  Fingerprint,
  List,
  Filter,
  X,
} from "lucide-react";
import { modeVisuals } from "./visuals";
import { barShade } from "../../shared/ui/MetricBars";
import { readStoredValue, writeStoredValue } from "../../shared/lib/storage";
import windowRangeCss from "../../shared/styles/window-range.css?inline";
import { lazy, Suspense, Profiler, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchCapabilities,
  fetchDatasets,
  fetchMc2Actors,
  fetchTraceRoots,
  type EventItem,
  type TypeInfo,
} from "../../shared/api/client";
import { EMPTY_FILTERS, type Filters } from "../../shared/api/filters";
import type { DatasetId } from "../../shared/types/dataset";
import referenceCss from "../../shared/styles/workspace-base.css?inline";
import themeCss from "../../shared/styles/workspace-theme.css?inline";
import layoutCss from "../../shared/styles/workspace-layout.css?inline";
import css from "./styles/page.css?inline";
import sharedCss from "../../shared/styles/workspace-controls.css?inline";
import { WorkspaceHeader } from "../../shared/ui/WorkspaceHeader";
import workspaceCss from "./styles/workspace.css?inline";
import { ViewControls } from "../../shared/ui/ViewControls";
import { recordTiming } from "./performance";
import { FileAvailability } from "./components/CompactSource";
import { ResearchOverlay } from "./components/ResearchOverlay";
import { FilePatterns } from "./components/FilePatterns";
import { Reader } from "./components/Reader";
import {
  actor,
  number,
  PendingRegion,
  RequestStatus,
  time,
  typeLabel,
  useRequest,
  type ReaderTarget,
} from "./eventPresentation";
import { TimeRange } from "./components/TimeRange";
import { ActivityOverview } from "./components/ActivityOverview";
import { RelationMatrix, RelationOverview, type MatrixView } from "./components/RelationCanvas";
import {
  FilterPanel,
  ObjectFacets,
  EvidenceList,
  HistoricalComparison,
  type FacetView,
} from "./components/Panels";
import {
  LocalProcess,
  eventFromItem,
  type ProcessSelection,
  type ProcessView,
} from "./components/LocalProcess";
import {
  narrowed,
  query,
  relationName,
  scopeParams,
  type ActivityData,
  type Edge,
  type Evidence,
  type RelationData,
  type Scope,
  type Selection,
} from "./api";

const RelationCanvas = lazy(() =>
  import("./components/GraphCanvas").then((module) => ({ default: module.RelationCanvas })),
);

export function Mc2Page({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  return (
    <ShadowWorkspace
      testId="mc2-reference"
      styles={referenceCss + layoutCss + themeCss + windowRangeCss + sharedCss + css + workspaceCss}
    >
      <Profiler
        id="MC2"
        onRender={(_id, phase, duration) => {
          recordTiming("react-commit", duration, phase);
          const committed = performance.now();
          requestAnimationFrame(() =>
            recordTiming("interactive-frame", performance.now() - committed, phase),
          );
        }}
      >
        <Mc2Workspace onDatasetChange={onDatasetChange} />
      </Profiler>
    </ShadowWorkspace>
  );
}

type Mode = "types" | "system" | "relay" | "operations";
type Investigation = {
  fileParent?: Investigation;
  filters: Filters;
  selected: Selection | null;
  day: Selection | null;
  fileId?: string;
  noFile?: boolean;
  mode: Mode;
  relation?: string;
  nodeId?: string;
  edge?: Edge;
  process: ProcessSelection | null;
  collapsed: boolean;
  representation: "overview" | "matrix" | "graph";
};
type InspectorView = {
  cursor: (string | null)[];
  bucket: { start: number; end: number } | null;
  scroll: number;
};

const initial = (): Investigation => ({
  filters: { ...EMPTY_FILTERS },
  selected: null,
  day: null,
  mode: "types",
  process: null,
  collapsed: readStoredValue("mc2-overview-collapsed") === "true",
  representation: "overview",
});

function Mc2Workspace({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  const renderStarted = performance.now();
  useLayoutEffect(() => {
    // Available in production too; Profiler actualDuration is development-only.
    recordTiming("react-render-to-commit", performance.now() - renderStarted);
    const committed = performance.now();

    const frame = requestAnimationFrame(() =>
      recordTiming("next-frame", performance.now() - committed),
    );

    return () => cancelAnimationFrame(frame);
  });
  const workspaceHost = useRef<HTMLDivElement>(null);
  const timelineDock = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dock = timelineDock.current;
    if (!dock) {
      return;
    }

    const measure = () =>
      workspaceHost.current?.style.setProperty(
        "--w-dock-offset",
        `${Math.ceil(dock.getBoundingClientRect().height) + 20}px`,
      );

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);

    return () => observer.disconnect();
  }, []);

  const startup = useRequest("mc2-startup", async (signal) => {
    const [cap, roots, actors, datasets] = await Promise.all([
      fetchCapabilities("MC2", signal),
      fetchTraceRoots(signal),
      fetchMc2Actors(signal),
      fetchDatasets(signal),
    ]);

    const target = datasets
      .find((d) => d.dataset_id === "MC2")
      ?.anchors.find((a) => a.key === "target_post");

    return {
      cap,
      roots: roots.items,
      actors,
      root: roots.items.find((r) => r.time_us === target?.time_us),
    };
  });

  const [state, setState] = useState<Investigation>(initial);
  const [granularity, setGranularity] = useState("day");
  const [filtersOpen, setFiltersOpen] = useState(true);

  const [visible, setVisible] = useState({
    activity: true,
    relations: true,
    process: true,
    evidence: true,
  });

  const [sideBySide, setSideBySide] = useState(false);
  type Snapshot = {
    state: Investigation;
    scroll: number;
    granularity: string;
    visible: typeof visible;
    sideBySide: boolean;
    filtersOpen: boolean;
    focus: HTMLElement | SVGElement | null;
  };
  const history = useRef<Snapshot[]>([]);
  const restoring = useRef<Snapshot | null>(null);
  const restoreGeneration = useRef(0);
  const background = useRef<HTMLDivElement>(null);
  const toolTrigger = useRef<HTMLElement | null>(null);

  const [tool, setTool] = useState<{ kind: "patterns" | "compare"; anchorTime?: number } | null>(
    null,
  );

  const closeTool = () => {
    setTool(null);
    requestAnimationFrame(() => toolTrigger.current?.focus({ preventScroll: true }));
  };

  const openTool = (kind: "patterns" | "compare", trigger: HTMLElement) => {
    toolTrigger.current = trigger;
    setTool({ kind, anchorTime: state.process?.anchorTime });
  };

  // 文件全历史等独立调查保留入口快照与历史深度，退出时完整恢复父调查。
  const independentReturn = useRef<{ snapshot: Snapshot; depth: number } | null>(null);
  const playback = useRef(false);
  const playbackRecorded = useRef(false);

  const snapshot = (): Snapshot => ({
    state,
    scroll: window.scrollY,
    granularity,
    visible,
    sideBySide,
    filtersOpen,
    focus:
      workspaceHost.current?.getRootNode() instanceof ShadowRoot
        ? ((workspaceHost.current.getRootNode() as ShadowRoot).activeElement as HTMLElement | null)
        : null,
  });

  const restore = (saved: Snapshot) => {
    restoreGeneration.current++;
    restoring.current = saved;
    setState(saved.state);
    setGranularity(saved.granularity);
    setVisible(saved.visible);
    setSideBySide(saved.sideBySide);
    setFiltersOpen(saved.filtersOpen);
    setNotice("正在恢复原调查…");
  };

  const exitIndependent = () => {
    const entry = independentReturn.current;
    if (!entry) {
      return;
    }
    history.current = history.current.slice(0, entry.depth);
    independentReturn.current = null;
    setHistorySize(history.current.length);
    restore(entry.snapshot);
  };

  const [historySize, setHistorySize] = useState(0);
  const processCache = useRef(new Map<string, ProcessView>());
  const inspectorCache = useRef(new Map<string, InspectorView>());
  const facetCache = useRef(new Map<string, FacetView>());

  const recordCache = useRef(
    new Map<string, { cursors: (string | null)[]; direction: string; scroll: number }>(),
  );

  const relationSection = useRef<HTMLElement>(null);
  const processSection = useRef<HTMLElement>(null);
  const [reader, setReader] = useState<{ target: ReaderTarget; filters: Filters } | null>(null);
  const returnFocus = useRef<HTMLElement | SVGElement | null>(null);
  const [notice, setNotice] = useState("");
  const matrixCache = useRef(new Map<string, MatrixView>());
  const overviewScroll = useRef(new Map<string, number>());

  const layoutCache = useRef(
    new Map<
      string,
      {
        positions: Map<string, { x: number; y: number }>;
        zoom?: number;
        pan?: { x: number; y: number };
      }
    >(),
  );

  const baseFilters = narrowed(narrowed(state.filters, state.selected), state.day);
  const relationScope: Scope = { filters: baseFilters, fileId: state.fileId, noFile: state.noFile };

  const scope: Scope = {
    ...relationScope,
    ...(state.edge
      ? {
          relation: state.edge.relation,
          source: state.edge.source,
          target: state.edge.target,
          action: state.edge.action,
        }
      : {}),
  };

  const transition = (next: Investigation, message = "") => {
    recordTiming("operation", 0, message || "调查选择");
    if (
      JSON.stringify([
        next.filters,
        next.selected,
        next.day,
        next.fileId,
        next.noFile,
        next.mode,
        next.relation,
      ]) !==
      JSON.stringify([
        state.filters,
        state.selected,
        state.day,
        state.fileId,
        state.noFile,
        state.mode,
        state.relation,
      ])
    ) {
      next = { ...next, nodeId: undefined };
    }
    restoreGeneration.current++;
    restoring.current = null;
    history.current.push(snapshot());
    setHistorySize(history.current.length);
    setState(next);
    setNotice(message);
  };

  const chooseRelation = (relation: string) =>
    transition({
      ...state,
      mode: relation === "overview" ? "types" : "system",
      relation: relation === "overview" ? undefined : relation,
      edge: undefined,
      representation: relation === "overview" ? "overview" : "matrix",
    });

  const back = () => {
    if (tool) {
      closeTool();

      return;
    }
    if (independentReturn.current) {
      exitIndependent();

      return;
    }
    const prev = history.current.pop();
    if (prev) {
      setHistorySize(history.current.length);
      restore(prev);
    }
  };

  const chooseFile = (id: string) => {
    const tasks =
      state.selected?.type === "queue_subordinate_task" ||
      state.filters.eventTypes.includes("queue_subordinate_task");

    transition(
      {
        ...state,
        fileParent: state.fileParent ?? state,
        fileId: id,
        noFile: false,
        mode: tasks ? "relay" : "operations",
        relation: undefined,
        edge: undefined,
        representation: tasks ? "matrix" : "graph",
      },
      "已按当前范围查看文件；任务与操作可在此切换。",
    );
  };

  const clearFile = () =>
    independentReturn.current
      ? exitIndependent()
      : transition(
          state.fileParent ?? {
            ...state,
            fileId: undefined,
            noFile: false,
            edge: undefined,
            mode: "types",
            representation: "overview",
          },
          "已返回文件选择前的上级范围",
        );

  const choosePatternFile = (id: string, full: boolean) => {
    const original = state;
    independentReturn.current = { snapshot: snapshot(), depth: history.current.length };
    setTool(null);
    transition(
      {
        ...original,
        fileParent: original,
        filters: full ? { ...EMPTY_FILTERS } : original.filters,
        selected: full ? null : original.selected,
        day: full ? null : original.day,
        fileId: id,
        noFile: false,
        edge: undefined,
        nodeId: undefined,
        mode: "operations",
        representation: "graph",
      },
      full ? "已进入全历史文件调查，可返回原调查" : "当前筛选内的精确文件；空结果不会自动扩大范围",
    );
  };

  const chooseCell = (selected: Selection | null) => {
    if (selected?.type && selected.type === state.selected?.type) {
      setState((s) => ({ ...s, selected }));

      return;
    }
    const type = selected?.type ?? "";

    const relation =
      type === "queue_subordinate_task"
        ? "queue_target_agent"
        : type === "sent" || type === "send_email"
          ? "mail_recipient"
          : type === "received"
            ? "mail_sender"
            : type.includes("file")
              ? "file_path"
              : type.includes("post")
                ? "post_content_source"
                : undefined;

    transition(
      {
        ...state,
        selected,
        fileId: undefined,
        fileParent: undefined,
        noFile: false,
        edge: undefined,
        mode: selected ? "system" : "types",
        relation,
        representation: selected ? "matrix" : "overview",
      },
      selected ? "已选择事件类型，日期范围保持不变" : "已清除类型选择",
    );
  };

  const chooseDay = (day: Selection | null) =>
    transition(
      {
        ...state,
        day,
        selected: null,
        fileId: undefined,
        fileParent: undefined,
        noFile: false,
        edge: undefined,
        mode: "types",
        relation: undefined,
        representation: "overview",
      },
      day ? `已筛选 ${day.label}；已清除原类型和格子选择` : "已清除单日选择",
    );

  const apply = (filters: Filters) => {
    independentReturn.current = null;
    setGranularity("day");
    transition(
      {
        ...state,
        filters,
        selected: null,
        day: null,
        fileId: undefined,
        fileParent: undefined,
        noFile: false,
        edge: undefined,
        mode: "types",
        relation: undefined,
        representation: "overview",
      },
      "已应用调查范围；未固定的局部过程将重新验证。",
    );
  };

  const showProcess = (item: EventItem) => {
    transition({ ...state, process: eventFromItem(item, scope) });
    setVisible((v) => ({ ...v, process: true }));
    requestAnimationFrame(() => {
      processSection.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      processSection.current?.focus({ preventScroll: true });
    });
  };

  const shortcut = (id: string, us: number) => {
    setVisible((v) => ({ ...v, process: true }));
    setGranularity("day");
    const filters = { ...EMPTY_FILTERS, startUs: us - 60e6, endUs: us + 60e6 + 1 };
    transition(
      {
        ...state,
        filters,
        selected: null,
        day: null,
        fileId: undefined,
        noFile: false,
        mode: "system",
        relation: "queue_target_agent",
        edge: undefined,
        collapsed: true,
        representation: "matrix",
        process: {
          anchor: id,
          anchorTime: us,
          scope: { filters, action: "saidit_post" },
          seconds: 60,
          context: true,
          expand: false,
          pinned: false,
        },
      },
      "已定位发布并建立前后60秒参与上下文，包含入向任务；可返回撤销。",
    );
    requestAnimationFrame(() => {
      processSection.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      processSection.current?.focus({ preventScroll: true });
    });
  };

  const processScope =
    state.process &&
    !state.edge &&
    !state.selected &&
    !state.fileId &&
    !state.noFile &&
    state.process.scope.action
      ? { ...scope, action: state.process.scope.action }
      : scope;

  const open = (target: ReaderTarget, trigger: HTMLElement | SVGElement) => {
    returnFocus.current = trigger;
    setReader({ target, filters: target.reading?.filters ?? baseFilters });
  };

  const close = () => {
    setReader(null);
    requestAnimationFrame(() =>
      returnFocus.current?.isConnected
        ? returnFocus.current.focus()
        : relationSection.current?.focus(),
    );
  };

  useLayoutEffect(() => {
    if (background.current) {
      background.current.inert = !!tool || !!reader;
    }
  }, [tool, reader]);
  const activityParams = { ...scopeParams({ filters: state.filters }), granularity };

  const activity = useRequest(
    JSON.stringify(activityParams),
    (signal) => query<ActivityData>("activity", activityParams, signal),
    visible.activity,
  );

  const relationParams = {
    ...scopeParams(relationScope),
    mode: state.mode,
    relation: state.relation,
  };

  const relations = useRequest(
    JSON.stringify(relationParams),
    (signal) => query<RelationData>("relations", relationParams, signal),
    visible.relations,
  );

  const facetParams = { ...scopeParams({ filters: baseFilters }), kind: "file", offset: 0 };
  const facetKey = JSON.stringify(facetParams);
  const warmFacets = visible.relations;
  useEffect(() => {
    if (!warmFacets) {
      return;
    }
    // 对象面板在关系响应后挂载，预取首页使其复用同一请求或缓存结果。
    const controller = new AbortController();
    void query("facets", facetParams, controller.signal).catch(() => {});

    return () => controller.abort();
    // facetKey 包含完整参数；参数对象每次渲染都会重建，不能以其引用触发预取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facetKey, warmFacets]);

  const timeline = useRequest("mc2-timeline", (signal) =>
    query<ActivityData>("activity", { granularity: "day" }, signal),
  );

  const changeTime = (filters: Filters) => {
    if (
      granularity === "hour" &&
      (filters.endUs ?? timeline.data?.coverage.end ?? 0) -
        (filters.startUs ?? timeline.data?.coverage.start ?? 0) >
        240 * 3600e6
    ) {
      setGranularity("day");
    }

    const next: Investigation = {
      ...state,
      filters,
      selected: null,
      day: null,
      fileId: undefined,
      fileParent: undefined,
      noFile: false,
      edge: undefined,
      nodeId: undefined,
      ...(state.selected ? { mode: "types", relation: undefined, representation: "overview" } : {}),
    };

    if (playback.current && playbackRecorded.current) {
      setState(next);
      setNotice("播放中 · 时间窗口正在更新");
    } else {
      transition(next, "调查时间已更新");
      if (playback.current) {
        playbackRecorded.current = true;
      }
    }
  };

  const cap = startup.data?.cap;
  const parentCountParams = scopeParams({ filters: baseFilters });

  const counts = useRequest(
    JSON.stringify(["count", parentCountParams]),
    (signal) => query<{ meta: Evidence["meta"] }>("count", parentCountParams, signal),
    visible.activity || visible.relations,
  );

  useEffect(() => {
    const saved = restoring.current;
    if (!saved || activity.loading || relations.loading || counts.loading) {
      return;
    }
    const generation = restoreGeneration.current;
    let frame = 0;

    const finish = () => {
      if (generation !== restoreGeneration.current) {
        return;
      }
      if (workspaceHost.current?.querySelector('[aria-busy="true"]')) {
        frame = requestAnimationFrame(finish);

        return;
      }
      window.scrollTo({ top: saved.scroll });
      (saved.focus?.isConnected ? saved.focus : relationSection.current)?.focus({
        preventScroll: true,
      });
      restoring.current = null;
      setNotice(
        workspaceHost.current?.querySelector('.mc2-status[role="alert"]')
          ? "已恢复调查范围；部分数据加载失败，可在对应区域重试"
          : "已恢复原调查范围、视图与位置",
      );
    };

    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(finish);
    });

    return () => cancelAnimationFrame(frame);
  }, [state, activity.loading, relations.loading, counts.loading]);
  const fileLabel = state.fileId?.replace("MC2:file_path:", "");

  const dateLabel =
    state.day?.label ??
    (baseFilters.startUs == null && baseFilters.endUs == null
      ? "全部时间"
      : `${baseFilters.startUs == null ? "数据起点" : time(baseFilters.startUs)} → ${baseFilters.endUs == null ? "数据终点" : time(baseFilters.endUs)}（不含终点）`);

  const typeSummary =
    state.selected?.label ??
    (state.filters.eventTypes.length
      ? state.filters.eventTypes.map((t) => typeLabel(t, cap?.types ?? [])).join("、")
      : state.filters.categories.length
        ? "所选类别"
        : "全部类型");

  const scopeLabel = state.edge
    ? `${relationName[state.edge.relation]} · ${actor(state.edge.source)} → ${actor(state.edge.target)}`
    : state.fileId
      ? `文件：${fileLabel}`
      : state.noFile
        ? "无明确文件关联"
        : state.selected
          ? `${state.selected.label} · 当前时间轴范围`
          : "当前全局筛选";

  return (
    <div
      ref={workspaceHost}
      className="app mc2-app w-app workspace-shell"
      data-testid="mc2-page"
    >
      <div
        ref={background}
        aria-hidden={tool || reader ? true : undefined}
      >
        <WorkspaceHeader
          title="MC2 · 系统活动调查"
          description="从活动与明确关系进入局部过程，逐条核对原始证据。"
          dataset="MC2"
          change={onDatasetChange}
        ></WorkspaceHeader>
        <ViewControls
          views={(
            [
              ["activity", "活动分布"],
              ["relations", "关系调查"],
              ["process", "局部过程"],
              ["evidence", "证据记录"],
            ] as const
          ).map(([id, label]) => ({
            id,
            label,
            checked: visible[id],
            change: (value: boolean) => setVisible((previous) => ({ ...previous, [id]: value })),
          }))}
        >
          <button
            className={`fp-toggle gc-compare-toggle ${sideBySide ? "on" : ""}`}
            aria-pressed={sideBySide}
            onClick={() => setSideBySide((value) => !value)}
          >
            <Columns2
              size={15}
              aria-hidden="true"
            />
            并排对比{sideBySide ? "：已开启" : ""}
          </button>
          <button
            className="fp-toggle gc-filters-toggle"
            disabled={sideBySide}
            onClick={() => setFiltersOpen((value) => !value)}
          >
            {filtersOpen && !sideBySide ? "隐藏筛选" : "显示筛选"}
          </button>
          <button
            className="fp-toggle"
            disabled={!historySize}
            onClick={back}
          >
            <ArrowLeft
              size={15}
              aria-hidden="true"
            />
            返回上一步
          </button>
          <button
            className="fp-toggle gc-clear-filters"
            onClick={() => {
              independentReturn.current = null;
              setGranularity("day");
              transition(initial(), "已恢复全范围");
            }}
          >
            恢复全范围
          </button>
          <div className="gc-counts">
            全库 <b>{cap ? number(cap.event_count) : "…"}</b> 条 · UTC
          </div>
        </ViewControls>
        <RequestStatus {...startup} />
        <RequestStatus {...timeline} />
        <div
          ref={timelineDock}
          className="w-timeline-dock"
        >
          <PendingRegion
            {...timeline}
            minimum={90}
          >
            {timeline.data && (
              <TimeRange
                paused={!!tool || !!reader}
                data={timeline.data}
                filters={state.filters}
                change={changeTime}
                granularity={granularity}
                setGranularity={setGranularity}
                playbackSession={(playing) => {
                  playback.current = playing;
                  if (playing) {
                    playbackRecorded.current = false;
                  }
                }}
              />
            )}
          </PendingRegion>
        </div>
        <div
          className={`section mc2-layout w-layout ${!filtersOpen || sideBySide ? "filters-hidden" : ""}`}
        >
          <aside
            hidden={!filtersOpen || sideBySide}
            className="filter-panel w-filters-open"
            aria-label="MC2 筛选区"
          >
            {cap && (
              <FilterPanel
                cap={cap}
                actors={startup.data!.actors}
                filters={state.filters}
                apply={apply}
                file={chooseFile}
                shortcut={shortcut}
                roots={startup.data!.roots}
                root={startup.data!.root}
              />
            )}
          </aside>
          <main className={`mc2-main ${sideBySide ? "w-main-parallel" : ""}`}>
            {state.selected?.type &&
              (baseFilters.eventTypes.includes("__no_type_intersection__") ||
                (state.filters.categories.length > 0 &&
                  !state.filters.categories.includes(
                    cap?.types.find((t) => t.type === state.selected?.type)?.category ?? -1,
                  ))) && (
                <p className="w-notice">
                  活动类型与全局类型或类别没有交集，当前结果为空。
                  <button onClick={() => chooseCell(null)}>清除临时类型</button>
                </p>
              )}
            <section
              hidden={!visible.activity}
              className="mc2-card mc2-activity-card"
            >
              <div className="mc2-card-head">
                <div>
                  <span className="w-kicker">01 / 活动分布</span>
                  <h2>
                    <Activity
                      size={17}
                      aria-hidden="true"
                    />
                    活动概览
                  </h2>
                </div>
                <div className="w-head-actions">
                  <button
                    aria-expanded={!state.collapsed}
                    onClick={() => {
                      writeStoredValue("mc2-overview-collapsed", String(!state.collapsed));
                      setState((s) => ({ ...s, collapsed: !s.collapsed }));
                    }}
                  >
                    {state.collapsed ? "展开24类型" : "收起概览"}
                  </button>
                </div>
              </div>
              <p className="mc2-note">
                当前筛选{" "}
                {!activity.loading && !activity.error && activity.data
                  ? number(activity.data.meta.matched_events)
                  : "…"}{" "}
                条记录 ·
                顶部时间轴设置全局窗口；点击数量柱临时筛选一天，类型名称或格子选择事件类型。
              </p>
              <RequestStatus {...activity} />
              <PendingRegion
                {...activity}
                minimum={state.collapsed ? 110 : 660}
                layoutKey={state.collapsed ? "collapsed" : "expanded"}
              >
                {activity.data && (
                  <ActivityOverview
                    data={activity.data}
                    selected={state.selected}
                    choose={chooseCell}
                    day={state.day}
                    chooseDay={chooseDay}
                    collapsed={state.collapsed}
                    anchorTime={state.process?.anchorTime}
                    scrollCache={overviewScroll.current}
                  />
                )}
              </PendingRegion>
              <div
                className="w-selection-notice"
                role="status"
              >
                <span>
                  <b>类型：{typeSummary}</b> ·{" "}
                  {!counts.loading && !counts.error && counts.data
                    ? number(counts.data.meta.matched_events)
                    : "…"}{" "}
                  条
                  <small>
                    日期：{dateLabel} · {notice || "选择类型或单日后，点击右侧查看关系。"}
                  </small>
                </span>
                <button
                  onClick={() => {
                    setVisible((v) => ({ ...v, relations: true }));
                    requestAnimationFrame(() => {
                      relationSection.current?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      });
                      relationSection.current?.focus({ preventScroll: true });
                    });
                  }}
                >
                  查看关系
                  <ArrowDown
                    size={14}
                    aria-hidden="true"
                  />
                </button>
                {state.selected && <button onClick={() => chooseCell(null)}>清除类型选择</button>}
                {state.day && <button onClick={() => chooseDay(null)}>清除单日选择</button>}
              </div>
            </section>
            <section
              hidden={!visible.relations}
              className="mc2-card w-relation-section"
              ref={relationSection}
              tabIndex={-1}
            >
              <div className="mc2-card-head">
                <div>
                  <span className="w-kicker">02 / 明确对象关系</span>
                  <h2>
                    <Network
                      size={17}
                      aria-hidden="true"
                    />
                    关系调查
                  </h2>
                </div>
                <div className="w-head-actions">
                  {state.fileId && (
                    <button
                      onClick={(e) => open({ kind: "file", id: state.fileId! }, e.currentTarget)}
                    >
                      阅读当前文件
                    </button>
                  )}
                  <button
                    onClick={(e) => openTool("patterns", e.currentTarget)}
                    title="全历史精确文件模式"
                  >
                    <Fingerprint size={15} />
                    文件指纹
                  </button>
                  {independentReturn.current && (
                    <button onClick={exitIndependent}>
                      <ArrowLeft size={14} />
                      返回原调查
                    </button>
                  )}
                  <button onClick={(e) => openTool("compare", e.currentTarget)}>
                    <GitCompareArrows size={15} />
                    发布实例比较
                  </button>
                </div>
              </div>
              <div className="w-inline-scope">
                <span>
                  日期 <b>{dateLabel}</b>
                </span>
                <span>
                  类型 <b>{typeSummary}</b>
                </span>
              </div>
              {state.fileId && (
                <p className="w-context-title">
                  当前文件：{fileLabel}{" "}
                  {visible.relations && <FileAvailability id={state.fileId} />}{" "}
                  <button onClick={clearFile}>清除文件选择</button>
                </p>
              )}
              {state.noFile && (
                <p className="w-context-title">
                  无明确文件关联的事件{" "}
                  <button onClick={() => transition({ ...state, noFile: false, edge: undefined })}>
                    返回上级集合
                  </button>
                </p>
              )}
              {
                <PendingRegion
                  data={relations.data}
                  loading={false}
                  minimum={520}
                >
                  <div className="w-relation-controls">
                    <label className="w-relation-picker">
                      调查内容
                      <WorkspaceSelect
                        aria-label="关系角色"
                        value={
                          state.mode === "types"
                            ? "overview"
                            : state.mode === "system"
                              ? (state.relation ??
                                relations.data?.selected_relations[0] ??
                                "overview")
                              : state.mode
                        }
                        onChange={(e) => chooseRelation(e.target.value)}
                      >
                        <option value="overview">关系概览</option>
                        {(state.mode === "relay" || state.mode === "operations") && (
                          <option value={state.mode}>
                            {state.mode === "relay" ? "当前文件的相关任务" : "当前文件的操作与引用"}
                          </option>
                        )}
                        {relations.data?.relation_counts.map((r) => (
                          <option
                            key={r.relation}
                            value={r.relation}
                          >
                            {r.label} · {number(r.count)} 条
                          </option>
                        ))}
                      </WorkspaceSelect>
                    </label>
                    {state.fileId && (
                      <div className="w-tabs w-mode-tabs">
                        {(
                          [
                            ["relay", "相关任务"],
                            ["operations", "操作与引用"],
                          ] as ["relay" | "operations", string][]
                        ).map(([id, label]) => {
                          const { Icon, color } = modeVisuals[id];

                          return (
                            <button
                              style={{ "--w-accent": color } as CSSProperties}
                              key={id}
                              aria-pressed={state.mode === id}
                              onClick={() =>
                                transition({
                                  ...state,
                                  mode: id,
                                  edge: undefined,
                                  representation: id === "operations" ? "graph" : "matrix",
                                })
                              }
                            >
                              <Icon size={14} />
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div
                    className="w-relation-summary"
                    data-testid="relation-summary"
                  >
                    <b>
                      当前{" "}
                      {relations.loading || relations.error
                        ? "…"
                        : number(relations.data?.meta.matched_events ?? 0)}{" "}
                      条事件
                    </b>
                    <span>
                      本视图涵盖{" "}
                      {relations.loading || relations.error
                        ? "…"
                        : number(relations.data?.mapped_events ?? 0)}{" "}
                      条 · 未进入本视图{" "}
                      {relations.loading || relations.error
                        ? "…"
                        : number(relations.data?.unmapped_events ?? 0)}{" "}
                      条 · 缺失发起者{" "}
                      {relations.loading || relations.error
                        ? "…"
                        : number(relations.data?.missing_source_events ?? 0)}{" "}
                      条
                    </span>
                  </div>
                  <div className="w-relation-body">
                    <div className="w-relation-main">
                      <div className="w-tabs w-representation">
                        {state.mode === "types" && (
                          <button
                            aria-pressed={state.representation === "overview"}
                            onClick={() => setState((s) => ({ ...s, representation: "overview" }))}
                          >
                            <List size={14} />
                            概览
                          </button>
                        )}
                        <button
                          aria-pressed={state.representation === "graph"}
                          onClick={() => setState((s) => ({ ...s, representation: "graph" }))}
                        >
                          <Share2 size={14} />
                          关系图
                        </button>
                        <button
                          aria-pressed={state.representation === "matrix"}
                          onClick={() => setState((s) => ({ ...s, representation: "matrix" }))}
                        >
                          <Grid2X2 size={14} />
                          关系矩阵
                        </button>
                      </div>
                      <div className="w-relation-visual">
                        <RequestStatus
                          {...relations}
                          loading={false}
                          maskWhileLoading
                        />
                        <PendingRegion
                          {...relations}
                          minimum={390}
                          maskWhileLoading
                          loadingLabel={
                            state.representation === "graph"
                              ? "正在加载关系图…"
                              : state.representation === "matrix"
                                ? "正在加载关系矩阵…"
                                : "正在加载关系概览…"
                          }
                        >
                          {relations.data &&
                            visible.relations &&
                            (relations.data.edges.length ? (
                              state.mode === "types" && state.representation === "overview" ? (
                                <RelationOverview
                                  data={relations.data}
                                  choose={chooseRelation}
                                />
                              ) : state.representation === "graph" ? (
                                <Suspense fallback={<p role="status">正在加载关系画布…</p>}>
                                  <RelationCanvas
                                    data={relations.data}
                                    cache={layoutCache.current}
                                    viewKey={JSON.stringify([
                                      relations.data.meta.data_version,
                                      relationParams,
                                    ])}
                                    selected={state.edge}
                                    focused={state.nodeId}
                                    onEdge={(edge) => {
                                      if (state.mode === "types") {
                                        chooseRelation(edge.relation);
                                      } else {
                                        transition({ ...state, edge, nodeId: undefined });
                                      }
                                    }}
                                    onNode={(id) => setState((s) => ({ ...s, nodeId: id }))}
                                  />
                                </Suspense>
                              ) : (
                                <RelationMatrix
                                  onNode={(id) => setState((s) => ({ ...s, nodeId: id }))}
                                  cache={matrixCache.current}
                                  viewKey={JSON.stringify([
                                    relations.data.meta.data_version,
                                    relationParams,
                                  ])}
                                  data={relations.data}
                                  selected={state.edge}
                                  onEdge={(edge) =>
                                    state.mode === "types"
                                      ? chooseRelation(edge.relation)
                                      : transition({ ...state, edge, nodeId: undefined })
                                  }
                                />
                              )
                            ) : (
                              <p className="mc2-empty">
                                {relations.data.needs_file
                                  ? "请在右侧选择文件，查看它的相关任务、操作与发布引用。"
                                  : "当前范围没有此类明确关系。事件仍保留在证据列表，可换调查内容或调整范围。"}
                              </p>
                            ))}
                        </PendingRegion>
                      </div>
                      <p className="mc2-note">
                        {state.mode === "types"
                          ? "概览按对象类型汇总；选择一种关系后查看具体对象。"
                          : state.mode === "relay"
                            ? "只表示排入涉及此文件的任务，不代表读取成功、完成或传播。"
                            : state.mode === "operations"
                              ? "箭头表示执行者对文件实施动作或引用；不同动作分别查证。"
                              : "方向按关系角色解释；邮件发件角色不等于一次新的发送。"}{" "}
                        同一事件可以支持多种关系，关系数量不宜直接相加。
                      </p>
                    </div>
                    <aside className="w-inspector">
                      {!relations.loading &&
                        !relations.error &&
                        state.nodeId &&
                        relations.data?.nodes.some((n) => n.id === state.nodeId) && (
                          <div className="w-node-inspector">
                            <h3>
                              {relations.data.nodes
                                .find((n) => n.id === state.nodeId)
                                ?.label.replaceAll("MC2:", "")}
                            </h3>
                            <p className="mc2-note">
                              当前只查看此对象的一跳关系，全局筛选保持不变。
                            </p>
                            <div className="w-node-actions">
                              {state.nodeId.startsWith("MC2:") && (
                                <button
                                  className="w-node-filter"
                                  onClick={() =>
                                    apply({
                                      ...state.filters,
                                      startUs: baseFilters.startUs,
                                      endUs: baseFilters.endUs,
                                      participantId: state.nodeId!,
                                    })
                                  }
                                >
                                  <Filter
                                    size={14}
                                    aria-hidden="true"
                                  />
                                  仅看该参与者的全部活动
                                </button>
                              )}
                              <button
                                className="w-node-clear"
                                onClick={() => setState((s) => ({ ...s, nodeId: undefined }))}
                              >
                                <X
                                  size={14}
                                  aria-hidden="true"
                                />
                                取消对象选择
                              </button>
                            </div>
                          </div>
                        )}
                      {!relations.loading && !relations.error && state.edge && (
                        <RelationInspector
                          cache={inspectorCache.current}
                          enabled={visible.relations}
                          key={JSON.stringify(scope)}
                          scope={scope}
                          edge={state.edge}
                          clear={() => transition({ ...state, edge: undefined })}
                          process={showProcess}
                          open={open}
                          types={cap?.types ?? []}
                        />
                      )}
                      {!state.edge && !state.nodeId && (
                        <p className="mc2-note">选择一种关系，再点击边或矩阵格查看对应事件。</p>
                      )}
                      <ObjectFacets
                        cache={facetCache.current}
                        enabled={visible.relations}
                        scope={relationScope}
                        chooseFile={chooseFile}
                        noFile={() =>
                          transition({
                            ...state,
                            noFile: true,
                            fileId: undefined,
                            mode: "system",
                            edge: undefined,
                            representation: "matrix",
                          })
                        }
                        chooseActor={(id) =>
                          apply({
                            ...state.filters,
                            startUs: baseFilters.startUs,
                            endUs: baseFilters.endUs,
                            actorId: id,
                            participantId: null,
                          })
                        }
                        chooseSystem={(id) =>
                          apply({
                            ...state.filters,
                            startUs: baseFilters.startUs,
                            endUs: baseFilters.endUs,
                            participantId: id,
                          })
                        }
                      />
                    </aside>
                  </div>
                </PendingRegion>
              }
            </section>
            <section
              hidden={!visible.process}
              tabIndex={-1}
              className={`mc2-card w-process-section ${state.process ? "has-process" : ""}`}
              ref={processSection}
            >
              <div className="mc2-card-head">
                <div>
                  <span className="w-kicker">03 / 单次活动前后</span>
                  <h2>
                    <Route
                      size={17}
                      aria-hidden="true"
                    />
                    局部过程
                  </h2>
                </div>
                {state.process && (
                  <button onClick={() => transition({ ...state, process: null })}>关闭过程</button>
                )}
              </div>
              {state.process ? (
                <LocalProcess
                  key={state.process.anchor}
                  cache={processCache.current}
                  enabled={visible.process}
                  value={state.process}
                  currentScope={processScope}
                  back={back}
                  update={(process) => transition({ ...state, process })}
                  open={open}
                  types={cap?.types ?? []}
                />
              ) : (
                <div className="w-empty-process">
                  <Route aria-hidden="true" />
                  <div>
                    <b>从一条记录开始，查看前后发生了什么</b>
                    <p className="mc2-note">
                      点击记录的“查看过程”，或使用左侧异常发布入口，按真实时间核对参与活动与入向任务。
                    </p>
                  </div>
                </div>
              )}
            </section>
            <section
              hidden={!visible.evidence}
              className="mc2-card w-evidence-section"
            >
              <div className="mc2-card-head">
                <div>
                  <span className="w-kicker">04 / 原始证据</span>
                  <h2>
                    <Files
                      size={17}
                      aria-hidden="true"
                    />
                    证据记录
                  </h2>
                </div>
                {state.edge && (
                  <button onClick={() => transition({ ...state, edge: undefined })}>
                    返回对象范围
                  </button>
                )}
              </div>
              <p
                className="mc2-note"
                data-testid="mc2-list-scope"
              >
                驱动选择：{scopeLabel}
                {state.day && ` · ${state.day.label}`}
                。局部过程的上下文记录在过程区查看，此列表跟随当前对象／关系。
              </p>
              <EvidenceList
                enabled={visible.evidence}
                scope={scope}
                cache={recordCache.current}
                types={cap?.types ?? []}
                open={open}
                process={showProcess}
              />
            </section>
          </main>
        </div>
      </div>
      {tool && (
        <ResearchOverlay
          kind={tool.kind}
          suspended={!!reader}
          close={closeTool}
        >
          {tool.kind === "patterns" ? (
            <FilePatterns
              types={cap?.types ?? []}
              choose={choosePatternFile}
              open={open}
            />
          ) : (
            <HistoricalComparison
              anchorTime={tool.anchorTime}
              open={open}
              types={cap?.types ?? []}
            />
          )}
        </ResearchOverlay>
      )}
      {reader && (
        <Reader
          initial={reader.target}
          filters={reader.filters}
          types={cap?.types ?? []}
          close={close}
          filterActor={(id) => {
            close();
            setTool(null);
            apply({ ...state.filters, actorId: id });
          }}
        />
      )}
    </div>
  );
}

function RelationInspector({
  scope,
  edge,
  clear,
  process,
  open,
  types,
  enabled = true,
  cache,
}: {
  cache: Map<string, InspectorView>;
  enabled?: boolean;
  scope: Scope;
  edge: Edge;
  clear: () => void;
  process: (e: EventItem) => void;
  open: (t: ReaderTarget, trigger: HTMLButtonElement) => void;
  types: TypeInfo[];
}) {
  const viewKey = JSON.stringify(scope);
  const saved = cache.get(viewKey);
  const [cursor, setCursor] = useState<(string | null)[]>(saved?.cursor ?? [null]);

  const [bucket, setBucket] = useState<{ start: number; end: number } | null>(
    saved?.bucket ?? null,
  );

  useEffect(() => {
    cache.set(viewKey, { cursor, bucket, scroll: cache.get(viewKey)?.scroll ?? 0 });
  }, [cache, viewKey, cursor, bucket]);
  const params = { ...scopeParams(scope), distribution: "true" };

  const distribution = useRequest(
    JSON.stringify(params),
    (s) => query<Evidence>("evidence", params, s),
    enabled,
  );

  const filteredScope = bucket
    ? {
        ...scope,
        filters: {
          ...scope.filters,
          startUs: Math.max(scope.filters.startUs ?? bucket.start, bucket.start),
          endUs: Math.min(scope.filters.endUs ?? bucket.end, bucket.end),
        },
      }
    : scope;

  const pageParams = { ...scopeParams(filteredScope), cursor: cursor.at(-1) ?? undefined };

  const page = useRequest(
    JSON.stringify(pageParams),
    (s) =>
      cursor.length > 1 || bucket
        ? query<Evidence>("evidence", pageParams, s)
        : Promise.resolve(null),
    enabled,
  );

  const data = cursor.length > 1 || bucket ? page : distribution;
  const items = data.data?.items ?? [];
  const timeline = distribution.data?.timeline ?? [];
  const first = timeline[0]?.start ?? edge.first_us;
  const last = timeline.at(-1)?.end ?? edge.last_us + 1;
  const peak = Math.max(1, ...timeline.map((b) => b.count));

  return (
    <section className="w-edge-inspector">
      <h3>选中关系事件</h3>
      <p>
        {relationName[edge.relation]} · {typeLabel(edge.action, types)}
      </p>
      <p className="mc2-note">
        {actor(edge.source)} → {actor(edge.target)}
      </p>
      <b>{edge.count} 条不同事件</b>
      <p className="mc2-note">
        {time(edge.first_us)} 至 {time(edge.last_us)}
      </p>
      <button onClick={clear}>清除关系选择</button>
      <RequestStatus {...distribution} />
      <svg
        viewBox="0 0 260 65"
        role="group"
        aria-label="完整关系事件时间分布"
      >
        {timeline.map((b) => (
          <g
            key={b.start}
            onClick={() => {
              setBucket(b);
              setCursor([null]);
            }}
            role="button"
            tabIndex={0}
            aria-label={`${time(b.start)} ${b.count} 条关系记录`}
            onKeyDown={(k) => {
              if (k.key === "Enter") {
                setBucket(b);
                setCursor([null]);
              }
            }}
            style={{ cursor: "pointer" }}
          >
            <title>
              {time(b.start)} 至 {time(b.end)} · {b.count} 条
            </title>
            <rect
              x={8 + ((b.start - first) / (last - first)) * 242}
              y={52 - (b.count / peak) * 42}
              width={Math.max(4, ((b.end - b.start) / (last - first)) * 242 - 1)}
              height={(b.count / peak) * 42}
              fill={
                bucket?.start === b.start
                  ? "light-dark(#d58c27, var(--status-warning-text))"
                  : barShade("light-dark(#338d83, var(--text-readable))", b.count / peak)
              }
            />
          </g>
        ))}
      </svg>
      <p className="mc2-note">时间图统计全部 {edge.count} 条，点击时间桶列出记录。</p>
      {bucket && (
        <div className="w-notice">
          桶内 {data.data?.meta.matched_events ?? "…"} 条{" "}
          <button
            onClick={() => {
              setBucket(null);
              setCursor([null]);
            }}
          >
            全部时间
          </button>
        </div>
      )}
      <RequestStatus
        {...data}
        maskWhileLoading
        loadingLabel="正在加载关系事件…"
      />
      <PendingRegion
        {...data}
        minimum={185}
        maskWhileLoading
        loadingLabel="正在加载关系事件…"
      >
        <div
          className="w-edge-events"
          ref={(el) => {
            if (el) {
              el.scrollTop = cache.get(viewKey)?.scroll ?? 0;
            }
          }}
          onScroll={(e) =>
            cache.set(viewKey, { cursor, bucket, scroll: e.currentTarget.scrollTop })
          }
        >
          {items.map((e) => (
            <div key={e.event_id}>
              <time>{time(e.time_us)}</time>
              <button onClick={() => process(e)}>查看过程 · {e.event_id.split(":").at(-1)}</button>
              <button
                onClick={(b) =>
                  open(
                    {
                      kind: "event",
                      id: e.event_id,
                      reading: {
                        filters: filteredScope.filters,
                        label: bucket ? "选中关系的时间桶" : "选中关系的全部时间",
                      },
                    },
                    b.currentTarget,
                  )
                }
              >
                阅读
              </button>
            </div>
          ))}
        </div>
      </PendingRegion>
      <div className="mc2-pagination">
        <button
          disabled={cursor.length < 2}
          onClick={() => setCursor((a) => a.slice(0, -1))}
        >
          <ChevronLeft
            size={14}
            aria-hidden="true"
          />
          前页
        </button>
        <span>第 {cursor.length} 页</span>
        <button
          disabled={!data.data?.next_cursor}
          onClick={() => setCursor((a) => [...a, data.data!.next_cursor!])}
        >
          后页
          <ChevronRight
            size={14}
            aria-hidden="true"
          />
        </button>
      </div>
    </section>
  );
}
