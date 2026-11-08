import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import {
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
import { Mc1Heatmap, mc1CellWidth, type Mc1AnchorMark, type Mc1Granularity, type Mc1Scope } from "./Mc1Heatmap";
import { Mc1MessageList } from "./Mc1MessageList";
import { Mc1Network, edgeKey, edgeStyle } from "./Mc1Network";
import { Mc1EventTrack } from "./Mc1EventTrack";
import { DecisionTimeline } from "./DecisionTimeline";
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

const HALF_HOUR_US = 30 * 60 * 1_000_000;

/**
 * MC1 单页：顶部精简控制 + 可收筛选 + 角色活动热力图 → 消息集合 → 事件轨 / 回复网络。
 * 时间窗、选择与回放的真值仍在 workspace reducer，本页不持有第二份时间。
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
    selectEvent,
    setEvidenceOpen,
    setEvidenceTab,
  } = useWorkspace();
  const [granularity, setGranularity] = useState<Mc1Granularity>("day");
  const scope = useMemo(() => scopeFromChannels(filters.channels), [filters.channels]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sideBySide, setSideBySide] = useState(false);
  const [visible, setVisible] = useState<Record<ViewToggle, boolean>>({
    heatmap: true,
    flow: true,
    network: true,
    indicators: false,
  });
  const [cell, setCell] = useState<{ agentId: string; agentLabel: string; column: Mc1Bucket } | null>(null);
  const [edge, setEdge] = useState<Mc1ReplyEdge | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [envPick, setEnvPick] = useState<Mc1EnvironmentRecord | null>(null);

  // 热力图与事件轨分属两个滚动容器，列宽一致；用同一 scrollLeft 保持对齐
  const heatScrollRef = useRef<HTMLDivElement>(null);
  const flowScrollRef = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const syncScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncingScroll.current) return;
    syncingScroll.current = true;
    to.scrollLeft = from.scrollLeft;
    window.requestAnimationFrame(() => {
      syncingScroll.current = false;
    });
  };

  const [activity, setActivity] = useState<PendingState<Mc1ActivityPayload>>(EMPTY_PENDING);
  const [context, setContext] = useState<PendingState<Mc1DecisionPayload>>(EMPTY_PENDING);
  const [network, setNetwork] = useState<PendingState<Mc1ReplyNetworkPayload>>(EMPTY_PENDING);
  const [cellMessages, setCellMessages] = useState<PendingState<{ items: EventItem[]; total: number }>>(EMPTY_PENDING);
  const [cellNote, setCellNote] = useState<string | null>(null);
  // 关闭内联详情后把焦点还给触发元素；全局焦点恢复只覆盖证据坞/事件坞
  const cellTrigger = useRef<HTMLElement | null>(null);
  const envTrigger = useRef<Element | null>(null);
  const edgeTrigger = useRef<Element | null>(null);
  const nodeTrigger = useRef<Element | null>(null);
  const [edgeMessages, setEdgeMessages] = useState<PendingState<{ items: EventItem[]; total: number }>>(EMPTY_PENDING);
  const [nodeMessages, setNodeMessages] = useState<PendingState<{ items: EventItem[]; total: number }>>(EMPTY_PENDING);

  const filterSignature = filterKey(filters, {
    granularity,
    cursor_us: masking ? cursor : undefined,
    masking,
  });
  const timeSignature = `${filters.startUs ?? ""}-${filters.endUs ?? ""}`;

  // 时间窗改变属于显式范围变更：清掉基于旧窗口的格/边/节点详情，避免串场
  useEffect(() => {
    setCell(null);
    setEdge(null);
    setNodeId(null);
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
    if (!cell) return null;
    const columnStart = cell.column.start_us;
    const columnEnd = cell.column.end_us;
    const startUs =
      columnStart == null ? filters.startUs : filters.startUs == null ? columnStart : Math.max(columnStart, filters.startUs);
    const endUs = columnEnd == null ? filters.endUs : filters.endUs == null ? columnEnd : Math.min(columnEnd, filters.endUs);
    const actorConflict = Boolean(filters.actorId && filters.actorId !== cell.agentId);
    const valid =
      startUs != null && endUs != null && startUs < endUs && columnStart != null && columnEnd != null;
    return { startUs, endUs, actorConflict, valid };
  }, [cell, filters.startUs, filters.endUs, filters.actorId]);

  // 点击热力格：只读该格与当前窗口的交集，不写全局筛选
  useEffect(() => {
    if (!cell || !cellWindow) {
      setCellMessages(EMPTY_PENDING);
      setCellNote(null);
      return;
    }
    if (cellWindow.actorConflict) {
      setCellMessages({ loading: false, error: null, data: { items: [], total: 0 } });
      setCellNote(
        `当前角色筛选为 ${String(filters.actorId).split(":").pop()}，该格属于 ${cell.agentId.split(":").pop()}：按空集处理，不替换角色条件。`,
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
      actorId: cell.agentId,
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
  }, [cell, filterSignature]);

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
        eventId: null as string | null,
        tone: "warn" as const,
      },
      {
        key: "confirm",
        label: "首条内部确认（event）",
        timeUs: confirm?.time_us ?? null,
        refId: confirm?.event_id ?? null,
        eventId: confirm?.event_id ?? null,
        tone: "accent" as const,
      },
      {
        key: "lift",
        label: "正式发布/解禁（event）",
        timeUs: lift?.time_us ?? null,
        refId: lift?.event_id ?? null,
        eventId: lift?.event_id ?? null,
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

  const closeCell = () => {
    const trigger = cellTrigger.current;
    setCell(null);
    restoreFocus(trigger);
  };

  const closeEnvironment = () => {
    const trigger = envTrigger.current;
    setEnvPick(null);
    restoreFocus(trigger);
  };

  const closeEdge = () => {
    const trigger = edgeTrigger.current;
    setEdge(null);
    restoreFocus(trigger);
  };

  const closeNode = () => {
    const trigger = nodeTrigger.current;
    setNodeId(null);
    restoreFocus(trigger);
  };

  /** 事件轨点击：选中真实事件并打开证据坞的消息 tab，保证鼠标路径有可见结果。 */
  const openEvent = (eventId: string, timeUs: number) => {
    selectEvent(eventId, timeUs);
    setEvidenceTab("message");
    setEvidenceOpen(true);
  };

  const focusCrisisWindow = () => {
    const anchor = anchorItems.find((item) => item.key === "confirm") ?? anchorItems.find((item) => item.key === "lift");
    if (!anchor?.timeUs) return;
    setFilters({ startUs: anchor.timeUs - HALF_HOUR_US, endUs: anchor.timeUs + HALF_HOUR_US });
  };

  const toggleView = (key: ViewToggle) => setVisible((prev) => ({ ...prev, [key]: !prev[key] }));

  const selectedCellKey = cell ? `${cell.agentId}|${cell.column.key}` : null;
  const selectedNodeLabel = network.data?.nodes.find((item) => item.id === nodeId)?.label ?? nodeId;

  const windowLabel =
    filters.startUs != null && filters.endUs != null
      ? `${formatUtc(filters.startUs)} → ${formatUtc(filters.endUs)}`
      : "全时间范围（源时区未知，不做 UTC 换算）";

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
          {toggleButton("indicators", "先兆候选")}
          <button
            type="button"
            className={`mc1-toggle${sideBySide ? " is-on" : ""}`}
            aria-pressed={sideBySide}
            title="热力图与回复网络并排"
            onClick={() => setSideBySide((value) => !value)}
          >
            并排
          </button>
          <button
            type="button"
            className={`mc1-toggle${filtersOpen ? " is-on" : ""}`}
            aria-pressed={filtersOpen}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((value) => !value)}
          >
            筛选
          </button>
          <button type="button" className="btn btn-quiet" onClick={clearFilters}>
            清空筛选
          </button>
        </div>
      </div>

      <div className="mc1-anchor-row">
        <span className="mc1-window mono">{windowLabel}</span>
        {anchorItems.map((anchor) => (
          <span key={anchor.key} className={`mc1-anchor-chip mc1-anchor-${anchor.tone}`}>
            <span>{anchor.label}</span>
            <span className="mono">{anchor.timeUs != null ? formatUtc(anchor.timeUs) : "缺口"}</span>
            <span className="mono mc1-anchor-id">{anchor.refId ?? "—"}</span>
            {anchor.timeUs != null && (
              <button
                type="button"
                className="mc1-anchor-action"
                title="把统一时间窗定位到该锚点前后 30 分钟（显式改变筛选）"
                onClick={() => {
                  const half = 1_800_000_000;
                  setFilters({ startUs: anchor.timeUs! - half, endUs: anchor.timeUs! + half });
                }}
              >
                定位 ±30m
              </button>
            )}
            {anchor.eventId && (
              <button
                type="button"
                className="mc1-anchor-action"
                onClick={() => setFilters({ startUs: null, endUs: null })}
              >
                全范围
              </button>
            )}
          </span>
        ))}
        <span className="muted small">
          源时区未知：以上时间按源记录原样展示，不与其它数据集比较。
        </span>
      </div>

      <div className={`mc1-body${filtersOpen ? " with-filters" : ""}`}>
        {filtersOpen && (
          <aside className="mc1-filters" aria-label="筛选面板">
            <div className="mc1-filter-group">
              <h3>时间范围</h3>
              <p className="muted small">{windowLabel}</p>
              <p className="muted small">
                时间窗由底部时间轴统一控制；此处只显示真值，避免两份时间。
              </p>
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
              <p className="muted small">使用顶栏搜索框（同一份筛选真值），不在页面内重复一份输入。</p>
              {filters.keyword && <p className="mono small">当前：{filters.keyword}</p>}
            </div>
            <div className="mc1-filter-group">
              <h3>当前筛选</h3>
              <p className="muted small">{state.notice ?? "无异常提示"}</p>
              <button type="button" className="btn btn-quiet" onClick={clearFilters}>
                清空筛选
              </button>
            </div>
          </aside>
        )}

        <div className={`mc1-columns${sideBySide ? " is-side-by-side" : ""}`}>
          <div className="mc1-col">
          {visible.heatmap && (
            <section className="mc1-card" aria-label="活动热力图">
              <header className="mc1-card-head">
                <h2>角色活动热力图</h2>
                <p className="muted small">
                  7 个角色 × 真实时间桶；点格读该格消息，不会隐式改写全局筛选。
                </p>
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
                  setEdge(null);
                  setNodeId(null);
                  cellTrigger.current = trigger;
                  setCell({ agentId, agentLabel, column });
                }}
                scrollRef={heatScrollRef}
                onScroll={() => syncScroll(heatScrollRef.current, flowScrollRef.current)}
              />
              {cell && (
                <div
                  className="mc1-detail-card"
                  role="region"
                  aria-label="热力格消息集合"
                  data-testid="mc1-cell-detail"
                  data-total={cellMessages.data?.total ?? ""}
                >
                  <div className="mc1-detail-head">
                    <div>
                      <strong>
                        {cell.agentLabel} ·{" "}
                        {cell.column.start_us != null
                          ? `${formatUtc(cell.column.start_us)} 起`
                          : cell.column.label}
                      </strong>
                      <p className="muted small">
                        真实消息集合：当前筛选 ∩ 该格时间桶
                        <span className="mono">
                          {" "}
                          [
                          {cellWindow?.startUs != null ? formatUtc(cellWindow.startUs) : "—"},{" "}
                          {cellWindow?.endUs != null ? formatUtc(cellWindow.endUs) : "—"})
                        </span>
                        {cellMessages.data ? ` · 共 ${cellMessages.data.total} 条` : ""}
                      </p>
                    </div>
                    <div className="mc1-detail-actions">
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() =>
                          setFilters({
                            startUs: cell.column.start_us,
                            endUs: cell.column.end_us,
                            actorId: cell.agentId,
                          })
                        }
                      >
                        把此格设为筛选
                      </button>
                      <button type="button" className="btn btn-quiet" onClick={closeCell}>
                        关闭
                      </button>
                    </div>
                  </div>
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
                    emptyText="该格在当前筛选下没有匹配消息（空状态不等于未履职）。"
                    scopeNote="点击消息展开外发正文、内部审议与原始字段；普通点击不会改写全局筛选。"
                  />
                </div>
              )}
            </section>
          )}

          {visible.flow && (
            <section className="mc1-card" aria-label="事件轨">
              <header className="mc1-card-head">
                <h2>事件轨</h2>
                <p className="muted small">
                  环境/约束、消息、发布三条轨与热力图共用时间桶和列宽；横向滚动同步。
                  点消息点或发布方块在证据坞打开真实事件；环境/约束标记可点开 source pointer。
                </p>
              </header>
              <Mc1EventTrack
                payload={context.data}
                columns={activity.data?.columns ?? []}
                cellWidth={mc1CellWidth(granularity)}
                anchors={anchors}
                scrollRef={flowScrollRef}
                onScroll={() => syncScroll(flowScrollRef.current, heatScrollRef.current)}
                selectedEventId={state.selection?.kind === "event" ? state.selection.id : null}
                onSelectEvent={openEvent}
                onPickEnvironment={(record, trigger) => {
                  envTrigger.current = trigger;
                  setEnvPick(record);
                }}
                onFocusAnchor={focusCrisisWindow}
              />
              {envPick && (
                <div className="mc1-detail-card" role="region" aria-label="环境记录" data-testid="mc1-env-detail">
                  <div className="mc1-detail-head">
                    <div>
                      <strong>
                        {envPick.kind} · {formatUtc(envPick.time_us)}
                      </strong>
                      <p className="muted small">
                        精度 {envPick.time_precision ?? "—"} · provenance {envPick.provenanceKind}
                        {envPick.constraint_basis ? ` · 约束依据 ${envPick.constraint_basis}` : ""}
                      </p>
                    </div>
                    <button type="button" className="btn btn-quiet" onClick={closeEnvironment}>
                      关闭
                    </button>
                  </div>
                  <p className="mc1-msg-text">{envPick.value}</p>
                  <p className="muted small mono">来源：{envPick.source_pointer ?? "—"}</p>
                </div>
              )}
            </section>
          )}
          </div>

          <div className="mc1-col">
          {visible.network && (
            <section className="mc1-card" aria-label="回复网络">
              <header className="mc1-card-head">
                <h2>回复与点名网络</h2>
                <p className="muted small">
                  点节点读该角色消息；点边读该聚合边的真实消息。reply 与 mention 分开。
                </p>
              </header>
              <Mc1Network
                payload={network.data}
                loading={network.loading}
                error={network.error}
                selectedEdgeKey={edge ? edgeKey(edge) : null}
                selectedNodeId={nodeId}
                onSelectEdge={(next, trigger) => {
                  setCell(null);
                  setNodeId(null);
                  edgeTrigger.current = trigger;
                  setEdge(next);
                }}
                onSelectNode={(id, trigger) => {
                  setCell(null);
                  setEdge(null);
                  nodeTrigger.current = trigger;
                  setNodeId(id);
                }}
              />
              {edge && (
                <div className="mc1-detail-card" role="region" aria-label="回复边证据">
                  <div className="mc1-detail-head">
                    <div>
                      <strong>
                        {edgeStyle(edge).label}：{edge.source.split(":").pop()} →{" "}
                        {edge.target.split(":").pop()}
                      </strong>
                      <p className="muted small">
                        聚合边证据 · {edgeStyle(edge).label}
                        {edge.kind === "reply" ? `（${edge.reply_class}）` : ""} · 去重事件{" "}
                        {edge.evidence_count} 条
                        {edgeMessages.data ? ` · 已加载 ${edgeMessages.data.total}` : ""}
                      </p>
                    </div>
                    <button type="button" className="btn btn-quiet" onClick={closeEdge}>
                      关闭
                    </button>
                  </div>
                  <Mc1MessageList
                    items={edgeMessages.data?.items ?? []}
                    loading={edgeMessages.loading}
                    error={edgeMessages.error}
                    total={edgeMessages.data?.total ?? null}
                    emptyText="该聚合边在当前筛选下没有可读消息。"
                    scopeNote="只含该边的原始消息；reply 与 mention 的语义不同，不合并统计。"
                  />
                </div>
              )}

              {nodeId && (
                <div className="mc1-detail-card" role="region" aria-label="节点消息">
                  <div className="mc1-detail-head">
                    <div>
                      <strong>{selectedNodeLabel} 的消息</strong>
                      <p className="muted small">
                        当前筛选 ∩ 该角色
                        {nodeMessages.data ? ` · 共 ${nodeMessages.data.total} 条` : ""}
                      </p>
                    </div>
                    <button type="button" className="btn btn-quiet" onClick={closeNode}>
                      关闭
                    </button>
                  </div>
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
                    emptyText="该角色在当前筛选下没有消息。"
                  />
                </div>
              )}
            </section>
          )}
          </div>
        </div>
      </div>

      <details className="mc1-card mc1-flow-details">
        <summary>决策泳道与回复分类（详细视图，含环境/约束区间）</summary>
        <DecisionTimeline payload={context.data} loading={context.loading} error={context.error} />
      </details>

      {visible.indicators && (
        <section className="mc1-card" aria-label="先兆候选">
          <LeadingIndicators indicators={context.data?.leading_indicators ?? null} />
        </section>
      )}

      {dataset !== "MC1" && <p className="muted small">当前数据集不是 MC1。</p>}
    </div>
  );
}
