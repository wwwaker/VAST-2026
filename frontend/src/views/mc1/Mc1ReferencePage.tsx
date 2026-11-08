import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import {
  fetchDatasets,
  fetchEvents,
  fetchMc1Activity,
  fetchMc1Context,
  fetchMc1ReplyEvidence,
  fetchMc1ReplyNetwork,
  formatUtc,
  type EventItem,
  type Mc1ActivityPayload,
  type Mc1Bucket,
  type Mc1DecisionPayload,
  type Mc1EnvironmentRecord,
  type Mc1ReplyEdge,
  type Mc1ReplyNetworkPayload,
} from "../../data/api";
import { filterKey } from "../../data/filterContext";
import { EventStream } from "../../components/EventStream";
import { CompareView } from "../CompareView";
import { Mc1Heatmap, mc1CellWidth, type Mc1AnchorMark, type Mc1Granularity, type Mc1Scope } from "./Mc1Heatmap";
import { Mc1MessageList } from "./Mc1MessageList";
import { Mc1Network, edgeKey, edgeStyle } from "./Mc1Network";
import { Mc1EventTrack } from "./Mc1EventTrack";
import { Mc1EventReader, Mc1Reader } from "./Mc1Reader";
import { LeadingIndicators } from "./LeadingIndicators";

const PUBLIC_CHANNELS = [
  "MC1:channel:personal_post",
  "MC1:channel:official_post",
  "MC1:channel:anonymous_post",
];
const INTERNAL_CHANNELS = [
  "MC1:channel:comms_huddle",
  "MC1:channel:side_huddle",
  "MC1:channel:one_on_one_chat",
];

type ViewToggle = "heatmap" | "flow" | "network" | "indicators";
type ToolPanel = "events" | "compare" | null;

/** 同一时刻只有一个阅读对象：热力格、回复边、角色节点、环境记录或单条事件。 */
type Reader =
  | { kind: "cell"; agentId: string; agentLabel: string; column: Mc1Bucket }
  | { kind: "edge"; edge: Mc1ReplyEdge }
  | { kind: "node"; id: string }
  | { kind: "environment"; record: Mc1EnvironmentRecord }
  | { kind: "event"; eventId: string; timeUs: number | null; channel: string | null; preview?: string };

interface PendingState<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
}

const EMPTY_PENDING: PendingState<never> = { loading: false, error: null, data: null };

function sameChannelSet(list: string[], expected: string[]): boolean {
  return list.length === expected.length && expected.every((item) => list.includes(item));
}

/** 渠道按钮不再是独立状态：只从共享筛选推导，避免"按钮说公开、查询查全部"的两份真值。 */
function scopeFromChannels(channels: string[]): Mc1Scope {
  if (!channels.length) return "both";
  if (sameChannelSet(channels, PUBLIC_CHANNELS)) return "public";
  if (sameChannelSet(channels, INTERNAL_CHANNELS)) return "internal";
  return "custom";
}

/**
 * MC1 单页：紧凑工具条 + 时间锚点 + 热力图/事件轨（主区）/回复网络（侧区）+ 单一阅读面板。
 * 时间窗、选择与回放的真值仍在 workspace reducer，本页不持有第二份时间。
 * 旧的概览/追踪/对照/结论不再出现在导航里；恢复旧快照时按 task/mode 映射到对应工具或区域。
 */
export function Mc1ReferencePage() {
  const {
    filters,
    setFilters,
    clearFilters,
    cursor,
    masking,
    dataset,
    state,
    changeTask,
    evidenceOpen,
    setEvidenceOpen,
    setEvidenceTab,
    selectEvent,
    restoreSeq,
    restoreMissing,
  } = useWorkspace();
  const [granularity, setGranularity] = useState<Mc1Granularity>("day");
  const scope = useMemo(() => scopeFromChannels(filters.channels), [filters.channels]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [tool, setTool] = useState<ToolPanel>(null);
  const [visible, setVisible] = useState<Record<ViewToggle, boolean>>({
    heatmap: true,
    flow: true,
    network: true,
    indicators: false,
  });
  const [reader, setReader] = useState<Reader | null>(null);

  // 热力图与事件轨分属两个滚动容器，列宽一致；用同一 scrollLeft 保持对齐
  const heatScrollRef = useRef<HTMLDivElement>(null);
  const flowScrollRef = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const flowCardRef = useRef<HTMLElement>(null);
  const networkCardRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [mainWidth, setMainWidth] = useState(0);
  const syncScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncingScroll.current) return;
    syncingScroll.current = true;
    to.scrollLeft = from.scrollLeft;
    window.requestAnimationFrame(() => {
      syncingScroll.current = false;
    });
  };

  const [coverage, setCoverage] = useState<{ withCount: number; total: number } | null>(null);
  const [activity, setActivity] = useState<PendingState<Mc1ActivityPayload>>(EMPTY_PENDING);
  const [context, setContext] = useState<PendingState<Mc1DecisionPayload>>(EMPTY_PENDING);
  const [network, setNetwork] = useState<PendingState<Mc1ReplyNetworkPayload>>(EMPTY_PENDING);
  const [cellMessages, setCellMessages] = useState<PendingState<{ items: EventItem[]; total: number }>>(EMPTY_PENDING);
  const [cellNote, setCellNote] = useState<string | null>(null);
  const [edgeMessages, setEdgeMessages] = useState<PendingState<{ items: EventItem[]; total: number }>>(EMPTY_PENDING);
  const [nodeMessages, setNodeMessages] = useState<PendingState<{ items: EventItem[]; total: number }>>(EMPTY_PENDING);

  // 关闭阅读面板后把焦点还给触发的图元；全局焦点恢复只覆盖证据坞/事件坞
  const cellTrigger = useRef<HTMLElement | null>(null);
  const envTrigger = useRef<Element | null>(null);
  const edgeTrigger = useRef<Element | null>(null);
  const nodeTrigger = useRef<Element | null>(null);
  const eventTrigger = useRef<Element | null>(null);

  // 主区宽度决定热力图/事件轨的列宽：宽屏铺满，窄屏保持最小列宽并横向滚动
  useEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setMainWidth(Math.round(width));
    });
    observer.observe(element);
    setMainWidth(Math.round(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);

  const columnCount = activity.data?.columns.length ?? 0;
  const cellWidth = useMemo(() => {
    const base = mc1CellWidth(granularity);
    if (!columnCount || mainWidth <= 0) return base;
    // 热力格标签列 132px，卡片内边距与列间距也要扣掉
    const usable = mainWidth - 24 - (132 + 12) - 2 * columnCount;
    return Math.max(base, Math.min(96, Math.floor(usable / columnCount)));
  }, [columnCount, granularity, mainWidth]);

  // 内部审议的全库覆盖率：用于阅读面板的双声道说明，只取一次
  useEffect(() => {
    if (dataset !== "MC1") return;
    let cancelled = false;
    fetchDatasets()
      .then((list) => {
        if (cancelled) return;
        const info = list.find((item) => item.dataset_id === "MC1");
        if (info) setCoverage({ withCount: info.deliberation_count, total: info.event_count });
      })
      .catch(() => !cancelled && setCoverage(null));
    return () => {
      cancelled = true;
    };
  }, [dataset]);

  const filterSignature = filterKey(filters, {
    granularity,
    cursor_us: masking ? cursor : undefined,
    masking,
  });
  const timeSignature = `${filters.startUs ?? ""}-${filters.endUs ?? ""}`;

  // 时间窗改变属于显式范围变更：清掉基于旧窗口的阅读对象，避免串场
  useEffect(() => {
    setReader(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSignature]);

  useEffect(() => {
    const controller = new AbortController();
    setActivity({ loading: true, error: null, data: null });
    fetchMc1Activity(
      { granularity, filters, cursorUs: masking ? cursor : null, masking },
      controller.signal,
    )
      .then((data) => !controller.signal.aborted && setActivity({ loading: false, error: null, data }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setActivity({ loading: false, error: err instanceof Error ? err.message : "活动矩阵加载失败", data: null });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSignature]);

  useEffect(() => {
    const controller = new AbortController();
    setContext({ loading: true, error: null, data: null });
    // 未显式设置时间窗时，/api/mc1/context 会回落到锚点 ±2h，与热力图全范围不一致；
    // 这里用热力图的真实列跨度作为事件轨窗口，保证同一份时间范围。
    const scopedFilters =
      filters.startUs == null && filters.endUs == null && activity.data?.columns.length
        ? {
            ...filters,
            startUs: activity.data.columns[0].start_us,
            endUs: activity.data.columns[activity.data.columns.length - 1].end_us,
          }
        : filters;
    fetchMc1Context({ filters: scopedFilters, cursorUs: masking ? cursor : null, masking }, controller.signal)
      .then((data) => !controller.signal.aborted && setContext({ loading: false, error: null, data }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setContext({ loading: false, error: err instanceof Error ? err.message : "事件轨加载失败", data: null });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSignature, activity.data?.columns.length, activity.data?.columns[0]?.start_us]);

  useEffect(() => {
    const controller = new AbortController();
    setNetwork({ loading: true, error: null, data: null });
    fetchMc1ReplyNetwork({ filters, cursorUs: masking ? cursor : null, masking }, controller.signal)
      .then((data) => !controller.signal.aborted && setNetwork({ loading: false, error: null, data }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setNetwork({ loading: false, error: err instanceof Error ? err.message : "回复网络加载失败", data: null });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSignature]);

  /**
   * 格子与当前时间窗的交集。普通查看绝不能扩张窗口：
   * 已有时间窗时取较窄的一方；角色筛选与格子角色冲突时按空集处理，不静默换角色。
   */
  const cellWindow = useMemo(() => {
    if (reader?.kind !== "cell") return null;
    const columnStart = reader.column.start_us;
    const columnEnd = reader.column.end_us;
    const startUs =
      columnStart == null ? filters.startUs : filters.startUs == null ? columnStart : Math.max(columnStart, filters.startUs);
    const endUs = columnEnd == null ? filters.endUs : filters.endUs == null ? columnEnd : Math.min(columnEnd, filters.endUs);
    const actorConflict = Boolean(filters.actorId && filters.actorId !== reader.agentId);
    const valid =
      startUs != null && endUs != null && startUs < endUs && columnStart != null && columnEnd != null;
    return { startUs, endUs, actorConflict, valid };
  }, [reader, filters.startUs, filters.endUs, filters.actorId]);

  // 点击热力格：只读该格与当前窗口的交集，不写全局筛选
  useEffect(() => {
    if (reader?.kind !== "cell" || !cellWindow) {
      setCellMessages(EMPTY_PENDING);
      setCellNote(null);
      return;
    }
    if (cellWindow.actorConflict) {
      setCellMessages({ loading: false, error: null, data: { items: [], total: 0 } });
      setCellNote(
        `当前角色筛选为 ${String(filters.actorId).split(":").pop()}，该格属于 ${reader.agentId.split(":").pop()}：按空集处理，不替换角色条件。`,
      );
      return;
    }
    if (!cellWindow.valid) {
      setCellMessages({ loading: false, error: null, data: { items: [], total: 0 } });
      setCellNote("该格与当前时间窗没有交集，或该时间桶缺少精确边界。");
      return;
    }
    const controller = new AbortController();
    setCellMessages({ loading: true, error: null, data: null });
    setCellNote(null);
    const scoped = {
      ...filters,
      startUs: cellWindow.startUs,
      endUs: cellWindow.endUs,
      actorId: reader.agentId,
    };
    fetchEvents(
      { dataset: "MC1", filters: scoped, limit: 50, direction: "desc", cursorUs: masking ? cursor : null, masking },
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setCellMessages({ loading: false, error: null, data: { items: page.items, total: page.meta.matched_events } });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setCellMessages({ loading: false, error: err instanceof Error ? err.message : "消息集合加载失败", data: null });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, filterSignature]);

  const edge = reader?.kind === "edge" ? reader.edge : null;

  useEffect(() => {
    if (!edge) {
      setEdgeMessages(EMPTY_PENDING);
      return;
    }
    const controller = new AbortController();
    setEdgeMessages({ loading: true, error: null, data: null });
    fetchMc1ReplyEvidence(
      {
        filters,
        sourceAgent: edge.source,
        targetAgent: edge.target,
        kind: edge.kind,
        replyClass: edge.kind === "reply" ? edge.reply_class : null,
        limit: 50,
        cursorUs: masking ? cursor : null,
        masking,
      },
      controller.signal,
    )
      .then((payload) => {
        if (controller.signal.aborted) return;
        setEdgeMessages({
          loading: false,
          error: null,
          data: { items: payload.items, total: payload.meta.matched_events },
        });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setEdgeMessages({ loading: false, error: err instanceof Error ? err.message : "边证据加载失败", data: null });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edge, filterSignature]);

  const nodeId = reader?.kind === "node" ? reader.id : null;
  // 节点查看同样是"当前结果集 ∩ 该角色"：角色筛选冲突时按空集处理，不替换全局条件
  const nodeActorConflict = Boolean(nodeId && filters.actorId && filters.actorId !== nodeId);

  useEffect(() => {
    if (!nodeId) {
      setNodeMessages(EMPTY_PENDING);
      return;
    }
    if (nodeActorConflict) {
      setNodeMessages({ loading: false, error: null, data: { items: [], total: 0 } });
      return;
    }
    const controller = new AbortController();
    setNodeMessages({ loading: true, error: null, data: null });
    fetchEvents(
      {
        dataset: "MC1",
        filters: { ...filters, actorId: nodeId },
        limit: 50,
        direction: "desc",
        cursorUs: masking ? cursor : null,
        masking,
      },
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setNodeMessages({ loading: false, error: null, data: { items: page.items, total: page.meta.matched_events } });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setNodeMessages({ loading: false, error: err instanceof Error ? err.message : "角色消息加载失败", data: null });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, filterSignature, nodeActorConflict]);

  const anchorItems = useMemo(() => {
    const data = context.data;
    const external = data?.anchors.external_report ?? null;
    const confirm = data?.anchors.first_internal_confirmation ?? null;
    const lift = data?.anchors.formal_lift ?? null;
    return [
      {
        key: "external",
        label: "外部报道（context）",
        timeUs: external?.time_us ?? null,
        refId: external?.context_id ?? null,
        tone: "warn" as const,
      },
      {
        key: "confirm",
        label: "首条内部确认（event）",
        timeUs: confirm?.time_us ?? null,
        refId: confirm?.event_id ?? null,
        tone: "accent" as const,
      },
      {
        key: "lift",
        label: "正式发布/解禁（event）",
        timeUs: lift?.time_us ?? null,
        refId: lift?.event_id ?? null,
        tone: "muted" as const,
      },
    ];
  }, [context.data]);

  const anchors: Mc1AnchorMark[] = useMemo(
    () => anchorItems.map(({ key, label, timeUs, tone }) => ({ key, label, timeUs, tone })),
    [anchorItems],
  );

  const applyScope = (next: Mc1Scope) => {
    if (next === "custom") return;
    setFilters({ channels: next === "public" ? PUBLIC_CHANNELS : next === "internal" ? INTERNAL_CHANNELS : [] });
  };

  const restoreFocus = (trigger: Element | null) => {
    window.requestAnimationFrame(() => {
      if (trigger && typeof (trigger as HTMLElement).focus === "function") (trigger as HTMLElement).focus();
    });
  };

  const closeReader = () => {
    const current = reader;
    setReader(null);
    const trigger =
      current?.kind === "cell" ? cellTrigger.current
        : current?.kind === "environment" ? envTrigger.current
          : current?.kind === "edge" ? edgeTrigger.current
            : current?.kind === "node" ? nodeTrigger.current
              : eventTrigger.current;
    restoreFocus(trigger);
  };

  /** 阅读面板与证据侧栏互斥：不叠两个竞争空间的辅助区。 */
  const openReader = (next: Reader) => {
    setEvidenceOpen(false);
    setReader(next);
    // 单一选中真值：阅读对象同时写进 reducer 的 selection，快照/笔记/关联不吃第二份状态
    if (next.kind === "event") selectEvent(next.eventId, next.timeUs);
  };

  useEffect(() => {
    if (evidenceOpen) setReader(null);
  }, [evidenceOpen]);

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

  /** 事件轨点击：在同一个阅读面板里读正文，不再转跳证据坞。 */
  const openEvent = (eventId: string, timeUs: number, trigger?: Element | null, channel: string | null = null, preview?: string) => {
    eventTrigger.current = trigger ?? null;
    openReader({ kind: "event", eventId, timeUs, channel, preview });
  };

  const locateAnchor = (timeUs: number) => {
    const half = 1_800_000_000;
    setFilters({ startUs: timeUs - half, endUs: timeUs + half });
  };

  /**
   * 旧快照的 task/mode 不再是导航，但恢复后要落到相应工具或区域。
   * restoreSeq 让"同 task/mode 的重复恢复"也能重新应用：普通关闭不会触发它。
   */
  const handledIntent = useRef("");
  const lastRestoreSeq = useRef(restoreSeq);
  useEffect(() => {
    const restored = lastRestoreSeq.current !== restoreSeq;
    lastRestoreSeq.current = restoreSeq;
    const key = `${state.task}/${state.mode}`;
    if (!restored && handledIntent.current === key) return;
    handledIntent.current = key;

    const scrollTo = (target: HTMLElement | null) => {
      const run = () => target?.scrollIntoView({ block: "start", behavior: "smooth" });
      run();
      window.setTimeout(run, 600);
    };
    const reveal = (part: "flow" | "network") =>
      setVisible((prev) => (prev[part] ? prev : { ...prev, [part]: true }));
    // 恢复出来的选中事件要落到唯一阅读入口；缺失引用已由通知说明，不再请求一个不存在的对象
    const openRestoredSelection = () => {
      if (state.selection?.kind !== "event") return;
      if (restoreMissing.includes(state.selection.id)) return;
      openReader({
        kind: "event",
        eventId: state.selection.id,
        timeUs: state.selection.timeUs,
        channel: null,
      });
    };

    if (state.task === "compare") {
      setTool("compare");
      openRestoredSelection();
      return;
    }
    if (state.task === "findings") {
      // 证据面板与阅读面板互斥：恢复笔记/证据时优先让工具面板可见
      setEvidenceTab(state.mode === "notes" ? "notes" : "basket");
      setEvidenceOpen(true);
      return;
    }
    if (state.mode === "decision") {
      reveal("flow");
      scrollTo(flowCardRef.current);
      openRestoredSelection();
      return;
    }
    if (state.mode === "localGraph" || state.mode === "relations" || state.task === "trace") {
      reveal("network");
      scrollTo(networkCardRef.current);
      openRestoredSelection();
      return;
    }
    if (state.mode === "time") {
      reveal("flow");
      scrollTo(flowCardRef.current);
      openRestoredSelection();
      return;
    }
    // 只读切换（如关闭对照返回概览）不重新打开阅读面板；恢复才落对象
    if (restored) openRestoredSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.task, state.mode, restoreSeq]);

  const openCompare = () => {
    setTool("compare");
    changeTask("compare", "window");
  };

  const closeCompare = () => {
    setTool(null);
    changeTask("overview", "activity");
  };

  const toggleView = (key: ViewToggle) => setVisible((prev) => ({ ...prev, [key]: !prev[key] }));

  const selectedCellKey = reader?.kind === "cell" ? `${reader.agentId}|${reader.column.key}` : null;
  const selectedNodeId = reader?.kind === "node" ? reader.id : null;
  const selectedNodeLabel = network.data?.nodes.find((item) => item.id === selectedNodeId)?.label ?? selectedNodeId;
  const selectedEventId = reader?.kind === "event" ? reader.eventId : state.selection?.kind === "event" ? state.selection.id : null;

  const windowLabel =
    filters.startUs != null && filters.endUs != null
      ? `${formatUtc(filters.startUs)} → ${formatUtc(filters.endUs)}`
      : "全时间范围";

  const toggleButton = (key: ViewToggle, label: string) => (
    <button
      key={key}
      type="button"
      className={`mc1-toggle${visible[key] ? " is-on" : ""}`}
      aria-pressed={visible[key]}
      onClick={() => toggleView(key)}
    >
      {label}
    </button>
  );

  const closeTools = (node: HTMLElement) => node.closest("details")?.removeAttribute("open");

  const replyAudit = context.data?.reply_audit ?? null;
  const auditCounts = replyAudit?.counts ?? {};

  return (
    <div className="mc1-page" data-testid="mc1-page">
      <div className="mc1-topbar">
        <div className="seg" role="group" aria-label="热力图粒度">
          {(["day", "hour", "round"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`seg-item${granularity === item ? " seg-active" : ""}`}
              aria-pressed={granularity === item}
              onClick={() => setGranularity(item)}
            >
              {item === "day" ? "按天" : item === "hour" ? "按小时" : "按轮次"}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="渠道范围">
          {(["both", "public", "internal"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`seg-item${scope === item ? " seg-active" : ""}`}
              aria-pressed={scope === item}
              onClick={() => applyScope(item)}
            >
              {item === "both" ? "全部渠道" : item === "public" ? "公开发布" : "内部渠道"}
            </button>
          ))}
          {scope === "custom" && (
            <span className="mc1-scope-note" role="status" data-testid="mc1-custom-scope">
              自定义渠道子集（{filters.channels.length}/6）
            </span>
          )}
        </div>
        <div className="mc1-toggles" role="group" aria-label="图表显隐">
          {toggleButton("heatmap", "热力图")}
          {toggleButton("flow", "事件轨")}
          {toggleButton("network", "回复网络")}
          <button
            type="button"
            className={`mc1-toggle${filtersOpen ? " is-on" : ""}`}
            aria-pressed={filtersOpen}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((value) => !value)}
          >
            筛选
          </button>
          <details className="mc1-tools">
            <summary>工具</summary>
            <div className="mc1-tools-menu">
              <button
                type="button"
                aria-pressed={tool === "events"}
                onClick={(event) => {
                  setTool((current) => (current === "events" ? null : "events"));
                  closeTools(event.currentTarget);
                }}
              >
                事件查询
              </button>
              <button
                type="button"
                aria-pressed={tool === "compare"}
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  if (tool === "compare") closeCompare();
                  else openCompare();
                }}
              >
                时间窗对照
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
                aria-pressed={visible.indicators}
                onClick={(event) => {
                  closeTools(event.currentTarget);
                  toggleView("indicators");
                }}
              >
                先兆候选
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

      <div className="mc1-context">
        <span className="mc1-window mono">{windowLabel}</span>
        {anchorItems.map((anchor) => (
          <span
            key={anchor.key}
            className={`mc1-anchor-chip mc1-anchor-${anchor.tone}`}
            title={anchor.refId ? `原始 ID：${anchor.refId}` : "该锚点在源数据中缺失"}
          >
            <span>{anchor.label}</span>
            <span className="mono">{anchor.timeUs != null ? formatUtc(anchor.timeUs) : "缺口"}</span>
            {anchor.timeUs != null && (
              <button
                type="button"
                className="mc1-anchor-action"
                title="把统一时间窗定位到该锚点前后 30 分钟"
                onClick={() => locateAnchor(anchor.timeUs as number)}
              >
                ±30m
              </button>
            )}
          </span>
        ))}
        <span className="tag" title="MC1 源记录时区未知：时间按源记录原样展示，不与其它数据集换算。">
          源时区未知
        </span>
      </div>

      <div className={`mc1-body${filtersOpen ? " with-filters" : ""}`}>
        {filtersOpen && (
          <aside className="mc1-filters" aria-label="筛选面板">
            <div className="mc1-filter-group">
              <h3>时间范围</h3>
              <p className="muted small mono">{windowLabel}</p>
              <button type="button" className="btn btn-quiet" onClick={() => setFilters({ startUs: null, endUs: null })}>
                重置为全范围
              </button>
            </div>
            <div className="mc1-filter-group">
              <h3>角色</h3>
              <div className="mc1-actor-list">
                <button
                  type="button"
                  className={`mc1-actor${!filters.actorId ? " is-on" : ""}`}
                  onClick={() => setFilters({ actorId: null })}
                >
                  全部角色
                </button>
                {(activity.data?.agents ?? []).map((agent) => (
                  <button
                    key={agent.agent_id}
                    type="button"
                    className={`mc1-actor${filters.actorId === agent.agent_id ? " is-on" : ""}`}
                    data-actor-id={agent.agent_id}
                    aria-pressed={filters.actorId === agent.agent_id}
                    onClick={() => setFilters({ actorId: agent.agent_id })}
                  >
                    {agent.label ?? agent.agent_id.split(":").pop()}
                  </button>
                ))}
              </div>
            </div>
            <div className="mc1-filter-group">
              <h3>关键词</h3>
              <p className="muted small">{filters.keyword ? <span className="mono">{filters.keyword}</span> : "未设置（在顶栏搜索）"}</p>
            </div>
            {state.notice && (
              <div className="mc1-filter-group">
                <h3>当前状态</h3>
                <p className="muted small">{state.notice}</p>
              </div>
            )}
          </aside>
        )}

        <div className="mc1-layout">
          <div className="mc1-main" ref={mainRef}>
            {visible.heatmap && (
              <section className="mc1-card" aria-label="活动热力图">
                <header className="mc1-card-head">
                  <h2>角色活动热力图</h2>
                  <p className="muted small">7 个角色 × 真实时间桶；点格读该格消息，不会隐式改写全局筛选。</p>
                </header>
                <Mc1Heatmap
                  payload={activity.data}
                  loading={activity.loading}
                  error={activity.error}
                  granularity={granularity}
                  scope={scope}
                  anchors={anchors}
                  selectedKey={selectedCellKey}
                  onPick={(agentId, column, trigger) => {
                    const agentLabel =
                      activity.data?.agents.find((item) => item.agent_id === agentId)?.label ??
                      agentId.split(":").pop() ??
                      agentId;
                    cellTrigger.current = trigger;
                    openReader({ kind: "cell", agentId, agentLabel, column });
                  }}
                  scrollRef={heatScrollRef}
                  onScroll={() => syncScroll(heatScrollRef.current, flowScrollRef.current)}
                  cellWidth={cellWidth}
                />
              </section>
            )}

            {visible.flow && (
              <section className="mc1-card" aria-label="事件轨" ref={flowCardRef}>
                <header className="mc1-card-head">
                  <h2>事件轨</h2>
                  <p className="muted small">
                    环境/约束、消息、发布三条轨与热力图共用时间桶；点消息点或发布方块在此面板读正文。
                  </p>
                </header>
                <Mc1EventTrack
                  payload={context.data}
                  columns={activity.data?.columns ?? []}
                  cellWidth={cellWidth}
                  anchors={anchors}
                  scrollRef={flowScrollRef}
                  onScroll={() => syncScroll(flowScrollRef.current, heatScrollRef.current)}
                  selectedEventId={selectedEventId}
                  onSelectEvent={(eventId, timeUs, trigger, channel) =>
                    openEvent(eventId, timeUs, trigger, channel ?? null)
                  }
                  onPickEnvironment={(record, trigger) => {
                    envTrigger.current = trigger;
                    openReader({ kind: "environment", record });
                  }}
                  onFocusAnchor={() => {
                    const confirm = anchorItems.find((item) => item.key === "confirm") ?? anchorItems.find((item) => item.key === "lift");
                    if (confirm?.timeUs) locateAnchor(confirm.timeUs);
                  }}
                />
                {replyAudit && (
                  <div className="mc1-audit" data-testid="mc1-reply-audit">
                    <strong>回复引用分类</strong>
                    <span className="muted small">
                      有效 {auditCounts.reply_valid ?? 0} · 未来引用 {auditCounts.reply_future_reference ?? 0} · 空引用{" "}
                      {auditCounts.empty_reference ?? 0} · 点名 {auditCounts.mention ?? 0} · 未解析{" "}
                      {auditCounts.unresolved_reference ?? 0}
                    </span>
                    <span className="muted small">reply / future / mention 分开统计，不合并成因果。</span>
                  </div>
                )}
              </section>
            )}

            {tool === "events" && (
              <section className="mc1-card" aria-label="事件查询">
                <header className="mc1-card-head">
                  <h2>事件查询</h2>
                  <p className="muted small">共享当前时间窗与筛选；点行在上方阅读面板查看正文。</p>
                </header>
                <EventStream
                  onOpenEvent={(item) => {
                    eventTrigger.current = document.activeElement;
                    openReader({
                      kind: "event",
                      eventId: item.event_id,
                      timeUs: item.time_us,
                      channel: item.channel_id,
                      preview: item.preview,
                    });
                  }}
                />
              </section>
            )}

            {tool === "compare" && (
              <section className="mc1-card" aria-label="时间窗对照">
                <header className="mc1-card-head">
                  <h2>时间窗对照</h2>
                  <button type="button" className="btn btn-quiet" onClick={closeCompare}>
                    返回 MC1
                  </button>
                </header>
                <CompareView />
              </section>
            )}

            {visible.indicators && (
              <section className="mc1-card" aria-label="先兆候选">
                <header className="mc1-card-head">
                  <h2>先兆候选</h2>
                  <p className="muted small">候选层，不进入已确认统计；每条候选都带规则来源与局限。</p>
                </header>
                <LeadingIndicators indicators={context.data?.leading_indicators ?? null} />
              </section>
            )}
          </div>

          <aside className="mc1-aside">
            {visible.network && (
              <section className="mc1-card" aria-label="回复网络" ref={networkCardRef}>
                <header className="mc1-card-head">
                  <h2>回复与点名网络</h2>
                  <p className="muted small">点节点读该角色消息；点边读该聚合边的真实消息。reply 与 mention 分开。</p>
                </header>
                <Mc1Network
                  payload={network.data}
                  loading={network.loading}
                  error={network.error}
                  selectedEdgeKey={edge ? edgeKey(edge) : null}
                  selectedNodeId={selectedNodeId}
                  onSelectEdge={(next, trigger) => {
                    edgeTrigger.current = trigger;
                    openReader({ kind: "edge", edge: next });
                  }}
                  onSelectNode={(id, trigger) => {
                    nodeTrigger.current = trigger;
                    openReader({ kind: "node", id });
                  }}
                />
              </section>
            )}

            {reader?.kind === "cell" && (
              <Mc1Reader
                ariaLabel="热力格消息集合"
                testId="mc1-cell-detail"
                dataTotal={cellMessages.data?.total ?? ""}
                title={`${reader.agentLabel} · ${reader.column.start_us != null ? `${formatUtc(reader.column.start_us)} 起` : reader.column.label}`}
                meta={
                  <>
                    当前筛选 ∩ 该格时间桶
                    <span className="mono">
                      {" ["}
                      {cellWindow?.startUs != null ? formatUtc(cellWindow.startUs) : "—"},{" "}
                      {cellWindow?.endUs != null ? formatUtc(cellWindow.endUs) : "—"})
                    </span>
                    {cellMessages.data ? ` · 共 ${cellMessages.data.total} 条` : ""}
                  </>
                }
                actions={
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() =>
                      setFilters({
                        startUs: reader.column.start_us,
                        endUs: reader.column.end_us,
                        actorId: reader.agentId,
                      })
                    }
                  >
                    把此格设为筛选
                  </button>
                }
                onClose={closeReader}
              >
                {cellNote && (
                  <p className="callout callout-warn small" role="status">
                    {cellNote}
                  </p>
                )}
                <Mc1MessageList
                  items={cellMessages.data?.items ?? []}
                  loading={cellMessages.loading}
                  error={cellMessages.error}
                  total={cellMessages.data?.total ?? null}
                  coverage={coverage}
                  emptyText="该格在当前筛选下没有匹配消息（空状态不等于未履职）。"
                  scopeNote="点击消息展开外发正文、内部审议与原始字段；普通点击不会改写全局筛选。"
                />
              </Mc1Reader>
            )}

            {reader?.kind === "edge" && (
              <Mc1Reader
                ariaLabel="回复边证据"
                title={`${edgeStyle(reader.edge).label}：${reader.edge.source.split(":").pop()} → ${reader.edge.target.split(":").pop()}`}
                meta={
                  <>
                    聚合边证据 · 去重事件 {reader.edge.evidence_count} 条
                    {edgeMessages.data ? ` · 已加载 ${edgeMessages.data.total}` : ""}
                  </>
                }
                onClose={closeReader}
              >
                <Mc1MessageList
                  items={edgeMessages.data?.items ?? []}
                  loading={edgeMessages.loading}
                  error={edgeMessages.error}
                  total={edgeMessages.data?.total ?? null}
                  coverage={coverage}
                  emptyText="该聚合边在当前筛选下没有可读消息。"
                  scopeNote="只含该边的原始消息；reply 与 mention 的语义不同，不合并统计。"
                />
              </Mc1Reader>
            )}

            {reader?.kind === "node" && (
              <Mc1Reader
                ariaLabel="节点消息"
                title={`${selectedNodeLabel} 的消息`}
                meta={
                  <>
                    当前筛选 ∩ 该角色
                    {nodeMessages.data ? ` · 共 ${nodeMessages.data.total} 条` : ""}
                  </>
                }
                onClose={closeReader}
              >
                {nodeActorConflict && (
                  <p className="callout callout-warn small" role="status">
                    当前角色筛选为 {String(filters.actorId).split(":").pop()}，该节点为{" "}
                    {String(nodeId).split(":").pop()}：按空集处理，不替换角色条件。
                  </p>
                )}
                <Mc1MessageList
                  items={nodeMessages.data?.items ?? []}
                  loading={nodeMessages.loading}
                  error={nodeMessages.error}
                  total={nodeMessages.data?.total ?? null}
                  coverage={coverage}
                  emptyText="该角色在当前筛选下没有消息。"
                />
              </Mc1Reader>
            )}

            {reader?.kind === "environment" && (
              <Mc1Reader
                ariaLabel="环境记录"
                testId="mc1-env-detail"
                title={`${reader.record.kind} · ${formatUtc(reader.record.time_us)}`}
                meta={
                  <>
                    精度 {reader.record.time_precision ?? "—"}
                    {reader.record.constraint_basis ? ` · 约束依据 ${reader.record.constraint_basis}` : ""}
                  </>
                }
                onClose={closeReader}
              >
                <p className="mc1-msg-text">{reader.record.value}</p>
                <details className="mc1-msg-raw-details">
                  <summary>来源定位</summary>
                  <p className="muted small mono">{reader.record.source_pointer ?? "—"}</p>
                  <p className="muted small mono">{reader.record.context_id}</p>
                </details>
              </Mc1Reader>
            )}

            {reader?.kind === "event" && (
              <Mc1Reader
                ariaLabel="消息详情"
                testId="mc1-event-detail"
                title={reader.timeUs != null ? formatUtc(reader.timeUs) : "消息详情"}
                meta={
                  reader.channel || reader.preview ? (
                    <>
                      {reader.channel ? reader.channel.split(":").pop() : ""}
                      {reader.preview ? `${reader.channel ? " · " : ""}${reader.preview}` : ""}
                    </>
                  ) : (
                    "从时间轨、列表或恢复的调查打开"
                  )
                }
                onClose={closeReader}
              >
                <Mc1EventReader
                  eventId={reader.eventId}
                  timeUs={reader.timeUs}
                  channel={reader.channel}
                  preview={reader.preview}
                  coverage={coverage}
                />
              </Mc1Reader>
            )}
          </aside>
        </div>
      </div>

      {dataset !== "MC1" && <p className="muted small">当前数据集不是 MC1。</p>}
    </div>
  );
}
