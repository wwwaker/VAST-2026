import { WorkspaceSelect } from "./WorkspaceSelect";
import { ArrowRight, ChevronLeft, ChevronRight, Pin, PinOff } from "lucide-react";
import { timeTicks, relativeTime, shortUtc } from "../timeDisplay";
import { ProcessTimeRange } from "./ProcessTimeRange";
import { entityVisual } from "./EntityLabel";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EventItem, TypeInfo } from "../../../shared/api/client";
import { EMPTY_FILTERS } from "../../../shared/api/filters";
import type { ProcessData, ProcessItem, ProcessMembers, Scope } from "../api";
import { query, scopeParams } from "../api";
import { processLayout, type ProcessMark } from "../layout/process";
import {
  actor,
  categoryColors,
  displayId,
  number,
  PendingRegion,
  RequestStatus,
  time,
  typeLabel,
  useRequest,
  type ReaderTarget,
} from "../eventPresentation";

export type ProcessSelection = {
  anchor: string;
  anchorTime?: number;
  scope: Scope;
  entryScope?: Scope;
  lastValidScope?: Scope;
  context: boolean;
  expand: boolean;
  pinned: boolean;
  seconds: number;
  actors?: string[];
  selectedId?: string;
  dataVersion?: string;
};
type Open = (target: ReaderTarget, trigger: HTMLElement | SVGElement) => void;
export type ProcessView = {
  showAllLanes: boolean;
  fitEvents: boolean;
  expanded: boolean;
  view: string;
  zoom: [number, number] | null;
  detail: ProcessItem | null;
  mark: ProcessMark | null;
  extracted?: string;
  lastValid: ProcessSelection | null;
};

export function ProcessSymbol({
  x,
  y,
  type,
  color,
  fill,
  stroke,
  className = "w-process-symbol",
}: {
  x: number;
  y: number;
  type: string;
  color: string;
  fill?: string;
  stroke?: string;
  className?: string;
}) {
  const props = { className, fill: fill ?? color, stroke: stroke ?? color, strokeWidth: 2 };

  return type === "queue_subordinate_task" ? (
    <path
      {...props}
      d={`M${x} ${y - 7}l7 7l-7 7l-7 -7z`}
    />
  ) : type.includes("post") ? (
    <g>
      <path
        {...props}
        d={`M${x} ${y - 8}l8 14h-16z`}
      />
      {type.includes("check") && (
        <path
          d={`M${x - 3} ${y + 1}l2 2l4 -4`}
          fill="none"
          stroke={
            fill === "light-dark(white, var(--border-default))"
              ? color
              : "light-dark(white, var(--border-default))"
          }
          strokeWidth={1.4}
        />
      )}
    </g>
  ) : type.includes("file") ? (
    <rect
      {...props}
      x={x - 6}
      y={y - 6}
      width={12}
      height={12}
    />
  ) : (
    <circle
      {...props}
      cx={x}
      cy={y}
      r={6}
    />
  );
}

export function LocalProcess({
  value,
  currentScope,
  update,
  open,
  types,
  back,
  enabled = true,
  cache,
}: {
  value: ProcessSelection;
  currentScope: Scope;
  update: (p: ProcessSelection) => void;
  open: Open;
  types: TypeInfo[];
  back?: () => void;
  enabled?: boolean;
  cache?: Map<string, ProcessView>;
}) {
  const options = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (options.current?.open && !e.composedPath().includes(options.current)) {
        options.current.open = false;
      }
    };

    window.addEventListener("pointerdown", outside);

    return () => window.removeEventListener("pointerdown", outside);
  }, []);
  const saved = cache?.get(value.anchor);
  const [showAllLanes, setShowAllLanes] = useState(saved?.showAllLanes ?? true);
  const [fitEvents, setFitEvents] = useState(saved?.fitEvents ?? true);
  const [expanded, setExpanded] = useState(saved?.expanded ?? false);
  const [view, setView] = useState(saved?.view ?? "graph");
  const [zoom, setZoom] = useState<[number, number] | null>(saved?.zoom ?? null);
  const [detail, setDetail] = useState<ProcessItem | null>(saved?.detail ?? null);
  const [mark, setMark] = useState<ProcessMark | null>(saved?.mark ?? null);
  const [extracted, setExtracted] = useState<string | undefined>(saved?.extracted);
  const [hover, setHover] = useState<{ title: string; lines: string[] } | null>(null);
  const [lastValid, setLastValid] = useState<ProcessSelection | null>(saved?.lastValid ?? null);
  useEffect(() => {
    cache?.set(value.anchor, {
      showAllLanes,
      fitEvents,
      expanded,
      view,
      zoom,
      detail,
      mark,
      extracted,
      lastValid,
    });
  }, [
    cache,
    value.anchor,
    showAllLanes,
    fitEvents,
    expanded,
    view,
    zoom,
    detail,
    mark,
    extracted,
    lastValid,
  ]);
  const scope = value.pinned ? value.scope : currentScope;

  const params = {
    ...scopeParams(scope),
    anchor: value.anchor,
    expected_version: value.pinned ? value.dataVersion : undefined,
    seconds: value.seconds,
    context: String(value.context),
    expand: String(value.expand),
    actors: (value.actors ?? []).join(","),
    selected_event: extracted,
  };

  const key = JSON.stringify(params);

  const resource = useRequest(
    key,
    (signal) => query<ProcessData>("process", params, signal),
    enabled,
  );

  const data =
    enabled && !resource.loading && !resource.error && resource.data?.valid ? resource.data : null;

  useEffect(() => {
    if (data) {
      setLastValid({ ...value, scope, lastValidScope: scope, dataVersion: data.data_version });
    }
    setMark(null);
    setHover(null);
    // 仅在查询选择身份改变时记录有效范围、重置临时图元状态。
    // value/scope 的展示更新不应清空用户选择或反复写入 lastValid。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.selection_key]);

  const change = (extra: Partial<ProcessSelection>) => {
    setDetail(null);
    setMark(null);
    setZoom(null);
    update({ ...value, ...extra });
  };

  const lanes = data?.lanes ?? [];

  const displayLanes = showAllLanes
    ? lanes
    : lanes.filter(
        (l) =>
          l.id === data?.items.find((i) => i.event_id === value.anchor)?.actor_id ||
          data?.links.some((k) => k.source === l.id || k.target === l.id),
      );

  const bounds = useMemo(() => {
    if (!data) {
      return [0, 1];
    }

    const times = [
      ...data.items.map((i) => i.time_us),
      ...data.aggregates.flatMap((a) => [a.bucket_start, a.bucket_end - 1]),
    ];

    const first = Math.min(...times);
    const last = Math.max(...times);
    const pad = Math.max(1e6, (last - first) * 0.15);

    const boundedZoom = zoom
      ? [
          Math.max(data.start, Math.min(zoom[0], data.end - 1)),
          Math.min(data.end, Math.max(zoom[1], data.start + 1)),
        ]
      : null;

    return boundedZoom && boundedZoom[0] < boundedZoom[1]
      ? boundedZoom
      : fitEvents && times.length > 1
        ? [Math.max(data.start, first - pad), Math.min(data.end, last + pad + 1)]
        : [data.start, data.end];
  }, [data, fitEvents, zoom]);

  const layout = useMemo(
    () =>
      processLayout(
        data?.items ?? [],
        data?.aggregates ?? [],
        displayLanes.map((l) => l.id),
        bounds[0],
        bounds[1],
        value.anchor,
        detail?.event_id,
        expanded,
      ),
    [data, displayLanes, bounds, value.anchor, detail?.event_id, expanded],
  );

  const select = (item: ProcessItem) => {
    setDetail(item);
    setMark(null);
    if (!data?.items.some((i) => i.event_id === item.event_id)) {
      setExtracted(item.event_id);
    }
  };

  const read = (item: ProcessItem, trigger: HTMLElement | SVGElement) => {
    const filters = item.context
      ? { ...EMPTY_FILTERS, startUs: data?.start ?? null, endUs: data?.end ?? null }
      : { ...scope.filters, startUs: data?.start ?? null, endUs: data?.end ?? null };

    open(
      {
        kind: "event",
        id: item.event_id,
        reading: {
          filters,
          label: item.context
            ? "此过程窗口内的文件活动（附近补充独立范围）"
            : value.pinned
              ? "固定过程范围"
              : "当前过程窗口",
          independent: item.context || value.pinned,
        },
      },
      trigger,
    );
  };

  return (
    <>
      <div className="w-process-tools">
        <label>
          窗口
          <WorkspaceSelect
            aria-label="局部时间窗口"
            value={value.seconds}
            onChange={(e) => change({ seconds: Number(e.target.value) })}
          >
            {[
              [10, "前后10秒"],
              [60, "前后60秒"],
              [300, "前后5分钟"],
              [1500, "前后25分钟"],
              [3600, "前后1小时"],
            ].map(([n, t]) => (
              <option
                key={n}
                value={n}
              >
                {t}
              </option>
            ))}
          </WorkspaceSelect>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={value.context}
            onChange={(e) => change({ context: e.target.checked })}
          />
          加入附近参与活动（含入向任务）
        </label>
        <button
          disabled={!data && !value.pinned}
          onClick={() =>
            update(
              value.pinned
                ? { ...value, pinned: false }
                : { ...(lastValid ?? value), scope, lastValidScope: scope, pinned: true },
            )
          }
        >
          {value.pinned ? <PinOff size={14} /> : <Pin size={14} />}{" "}
          {value.pinned ? "取消固定，跟随当前选择" : "固定此过程"}
        </button>
        <details
          className="w-process-options"
          ref={options}
          onKeyDown={(e) => {
            if (e.key === "Escape" && options.current?.open) {
              e.stopPropagation();
              options.current.open = false;
              options.current.querySelector("summary")?.focus({ preventScroll: true });
            }
          }}
        >
          <summary>范围与显示</summary>
          <div className="w-process-popover">
            {data && (
              <p>
                完整查询区间（含起点、不含终点）：
                <br />[{time(data.start)}, {time(data.end)})
              </p>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={value.expand}
                onChange={(e) => change({ expand: e.target.checked })}
              />
              允许窗口超出父级时间
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={fitEvents}
                onChange={(e) => {
                  setFitEvents(e.target.checked);
                  setZoom(null);
                }}
              />
              图中聚焦实际活动
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={expanded}
                onChange={(e) => setExpanded(e.target.checked)}
              />
              展开碰撞标记的全部轨道
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={showAllLanes}
                onChange={(e) => setShowAllLanes(e.target.checked)}
              />
              显示全部泳道
            </label>
            {value.actors?.map((id) => (
              <button
                key={id}
                onClick={() => change({ actors: value.actors!.filter((a) => a !== id) })}
              >
                移除补入对象 · {actor(id)}
              </button>
            ))}
          </div>
        </details>
      </div>
      {value.pinned && (
        <p className="w-notice">
          固定上下文，不随当前选择变化 · 锚点 {displayId(value.anchor)} · 数据{" "}
          {value.dataVersion?.slice(0, 8)}
        </p>
      )}
      <RequestStatus {...resource} />
      <PendingRegion
        {...resource}
        minimum={180}
      >
        {!resource.loading && resource.data && !resource.data.valid && (
          <div
            className="mc2-empty"
            data-testid="process-outside"
          >
            <b>保留的锚点不符合当前选择</b>
            <ul>
              {resource.data.invalid_reasons.map((r) => (
                <li key={r.code}>{r.label}</li>
              ))}
            </ul>
            <p>旧过程已停止绘制与交互。</p>
            {back && <button onClick={back}>返回上一步</button>}
            <button
              disabled={
                !lastValid || resource.data.invalid_reasons.some((r) => r.code === "missing")
              }
              onClick={() => lastValid && update({ ...lastValid, pinned: true })}
            >
              查看原范围并固定
            </button>
          </div>
        )}
        {data && (
          <>
            <p
              className="mc2-note"
              data-testid="process-summary"
            >
              主选 {data.main_count} 条 ＋ 附近补充 {data.context_count} 条 ＝ 合计{" "}
              {number(data.total)} 条 · 父时间外补充 {data.outside_main} 条 · 可见{" "}
              {displayLanes.length}/{lanes.length} 个泳道 · {layout.marks.length} 个标记
            </p>
            {data.anchor_outside_time && (
              <p className="w-notice">锚点位于父时间外，属于时间扩展补充，不计入主选。</p>
            )}
            <div className="w-process-anchor">
              锚点 {shortUtc(data.anchor_time, true)} · 图中{" "}
              {relativeTime(bounds[0] - data.anchor_time)}～
              {relativeTime(bounds[1] - data.anchor_time)}{" "}
              <details>
                <summary>精确时间与范围</summary>
                <p>
                  锚点 {time(data.anchor_time)}
                  <br />
                  图中 [{time(bounds[0])}, {time(bounds[1])})<br />
                  查询 [{time(data.start)}, {time(data.end)})
                </p>
                <p>
                  附近活动按明确来源/目标的一跳角色补入，可放宽内容筛选；实心为主选、空心为补充。时间相邻不表示因果。
                </p>
              </details>
            </div>
            <div className="w-tabs">
              <button
                aria-pressed={view === "graph"}
                onClick={() => setView("graph")}
              >
                时间泳道
              </button>
              <button
                aria-pressed={view === "reading"}
                onClick={() => setView("reading")}
              >
                按时间阅读过程
              </button>
            </div>
            {view === "graph" && (
              <ProcessTimeRange
                start={data.start}
                end={data.end}
                bounds={bounds}
                points={[
                  ...data.items.map((i) => ({ time: i.time_us, count: 1 })),
                  ...data.aggregates.map((a) => ({ time: a.bucket_start, count: a.count })),
                ]}
                change={(v) => {
                  setZoom(v);
                  setHover(null);
                }}
                focus={() => {
                  setZoom(null);
                  setFitEvents(true);
                  setHover(null);
                }}
              />
            )}
            {view === "graph" ? (
              <div className="w-process-plot">
                <div
                  className="w-timeline-scroll"
                  tabIndex={0}
                  aria-label="局部过程时间泳道"
                >
                  <svg
                    width="100%"
                    style={{ minWidth: 1050 }}
                    height={layout.height}
                    viewBox={`0 0 1050 ${layout.height}`}
                    role="group"
                    aria-label="真实时间执行者泳道"
                  >
                    <defs>
                      <marker
                        id="mc2-arrow"
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="5"
                        markerHeight="5"
                        orient="auto"
                      >
                        <path
                          d="M0 0L10 5L0 10z"
                          fill="light-dark(#bf6965, var(--tone-danger-text))"
                        />
                      </marker>
                    </defs>
                    {timeTicks(bounds[0] - data.anchor_time, bounds[1] - data.anchor_time).map(
                      (t) => {
                        const x =
                          205 +
                          ((t.value + data.anchor_time - bounds[0]) / (bounds[1] - bounds[0])) *
                            810;

                        return (
                          <g key={t.value}>
                            <line
                              x1={x}
                              x2={x}
                              y1={32}
                              y2={layout.height - 15}
                              stroke="light-dark(#d5e0ea, var(--border-default))"
                            />
                            <text
                              x={x}
                              y={20}
                              textAnchor="middle"
                              fontSize={12}
                              fill="light-dark(#52677d, var(--text-readable))"
                            >
                              {t.label}
                            </text>
                          </g>
                        );
                      },
                    )}
                    {data.anchor_time >= bounds[0] && data.anchor_time < bounds[1] && (
                      <line
                        x1={205 + ((data.anchor_time - bounds[0]) / (bounds[1] - bounds[0])) * 810}
                        x2={205 + ((data.anchor_time - bounds[0]) / (bounds[1] - bounds[0])) * 810}
                        y1={42}
                        y2={layout.height - 15}
                        stroke="light-dark(#d58c27, var(--selection-anchor))"
                        strokeDasharray="4 3"
                      />
                    )}
                    {displayLanes.map((lane, i) => {
                      const v = entityVisual(lane.entity_type);
                      const Icon = v.Icon;

                      return (
                        <g
                          key={lane.id}
                          onMouseEnter={() =>
                            setHover({
                              title: actor(lane.id),
                              lines: [
                                lane.id,
                                lane.role_only
                                  ? "只记录了目标角色，未推断其执行活动"
                                  : `${v.label} · 此泳道按真实时间排列`,
                              ],
                            })
                          }
                          onMouseLeave={() => setHover(null)}
                        >
                          <Icon
                            x={10}
                            y={layout.offsets[i] + 10}
                            width={14}
                            height={14}
                            color={v.color}
                          />
                          <text
                            x={30}
                            y={layout.offsets[i] + 23}
                            fontSize={12}
                            fill="light-dark(#34516e, var(--text-readable))"
                          >
                            <title>{lane.id}</title>
                            {displayId(lane.label?.slice(0, 24) ?? actor(lane.id))}
                          </text>
                          <text
                            x={30}
                            y={layout.offsets[i] + 40}
                            fontSize={12}
                            fill="light-dark(#52677d, var(--text-readable))"
                          >
                            {lane.role_only ? "仅有目标角色" : v.label}
                          </text>
                          <line
                            x1={205}
                            x2={1015}
                            y1={layout.offsets[i] + 28}
                            y2={layout.offsets[i] + 28}
                            stroke={v.color}
                            strokeOpacity={0.25}
                          />
                        </g>
                      );
                    })}
                    {data.links.map((link) => {
                      const m = layout.marks.find((m) => m.id === link.event_id);
                      const target = displayLanes.findIndex((l) => l.id === link.target);
                      if (!m || target < 0) {
                        return null;
                      }
                      const item = m.events[0];

                      return (
                        <g
                          key={`${link.event_id}:${link.target}`}
                          role="button"
                          tabIndex={0}
                          aria-label={`选择任务 ${displayId(link.event_id)} 的目标 ${actor(link.target)}`}
                          onMouseEnter={() =>
                            setHover({
                              title: "任务目标关系",
                              lines: [
                                `${actor(link.source)} → ${actor(link.target)}`,
                                "同一任务记录的明确目标角色，不代表已执行或完成",
                              ],
                            })
                          }
                          onMouseLeave={() => setHover(null)}
                          onClick={() => select(item)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              select(item);
                            }
                          }}
                        >
                          <title>同一任务记录的目标角色，不代表执行完成</title>
                          <line
                            x1={m.x}
                            x2={m.x}
                            y1={m.y}
                            y2={layout.offsets[target] + 28}
                            stroke="light-dark(#bf6965, var(--tone-danger-text))"
                            strokeWidth={2}
                            markerEnd="url(#mc2-arrow)"
                          />
                          <circle
                            cx={m.x}
                            cy={layout.offsets[target] + 28}
                            r={4}
                            fill="light-dark(white, var(--surface-subtle))"
                            stroke="light-dark(#bf6965, var(--tone-danger-text))"
                          />
                        </g>
                      );
                    })}
                    {layout.marks.map((m) => {
                      const i = m.events[0];
                      const multi = m.count > 1 || m.aggregates.length > 0;

                      const color = i
                        ? categoryColors[(i.category - 1) % categoryColors.length]
                        : "light-dark(#657f96, var(--text-readable))";

                      const pick = () => {
                        if (multi) {
                          setMark(m);
                          setDetail(null);
                        } else {
                          select(i);
                        }
                      };

                      const tip = {
                        title: multi
                          ? `聚合 ${number(m.count)} 条 · ${m.context ? "附近补充（空心）" : "当前筛选主选（实心）"}`
                          : `${typeLabel(i.event_type, types)} · ${m.context ? "附近补充（空心）" : "当前筛选主选（实心）"}`,
                        lines: [
                          `${actor(m.lane)} · ${time(m.time)}`,
                          ...m.aggregates.map(
                            (a) =>
                              `${time(a.bucket_start)} → ${time(a.bucket_end)} · ${number(a.count)} 条`,
                          ),
                          multi
                            ? `${m.events.length} 条逐条记录＋${m.aggregates.length} 个精确时间桶；点击查看全部成员`
                            : i.preview || displayId(i.event_id),
                          m.id === value.anchor
                            ? "橙环：本次过程锚点"
                            : m.context
                              ? "补充用于核对参与上下文，不计入当前主选"
                              : "实心表示符合当前筛选条件，不表示活动完成",
                        ],
                      };

                      return (
                        <g
                          key={m.id}
                          className={`w-process-mark ${detail?.event_id === m.id ? "selected" : ""}`}
                          role="button"
                          tabIndex={0}
                          aria-pressed={detail?.event_id === m.id}
                          aria-label={
                            multi
                              ? `聚合 ${m.count} 条 ${m.context ? "补充" : "主选"}`
                              : `${displayId(m.id)} ${i.event_type} ${m.context ? "附近补充" : "主选"}`
                          }
                          onMouseEnter={() => setHover(tip)}
                          onMouseLeave={() => setHover(null)}
                          onFocus={() => setHover(tip)}
                          onBlur={() => setHover(null)}
                          onClick={pick}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              pick();
                            }
                          }}
                        >
                          <title>
                            {time(m.time)} ·{" "}
                            {multi
                              ? `${m.count}条，点击展开全部成员`
                              : typeLabel(i.event_type, types)}{" "}
                            · {m.context ? "补充" : "主选"}
                          </title>
                          <circle
                            className="w-process-hit"
                            cx={m.x}
                            cy={m.y}
                            r={13}
                            fill="transparent"
                          />
                          {m.id === value.anchor && (
                            <circle
                              cx={m.x}
                              cy={m.y}
                              r={10}
                              fill="none"
                              stroke="light-dark(#d58c27, var(--selection-anchor))"
                              strokeWidth={2}
                            />
                          )}{" "}
                          {detail?.event_id === m.id && (
                            <circle
                              className="w-process-halo"
                              cx={m.x}
                              cy={m.y}
                              r={13}
                              fill="none"
                              stroke="light-dark(#3188b5, var(--border-control-strong))"
                              strokeWidth={2}
                            />
                          )}
                          {multi ? (
                            <>
                              <circle
                                className="w-process-aggregate"
                                cx={m.x}
                                cy={m.y}
                                r={18}
                                fill={
                                  m.context
                                    ? "light-dark(white, var(--surface-subtle))"
                                    : "light-dark(#e5eef7, var(--surface-subtle))"
                                }
                                stroke="light-dark(#6385a3, var(--border-control-strong))"
                                strokeWidth={2}
                              />
                              <circle
                                cx={m.x}
                                cy={m.y}
                                r={22}
                                fill="none"
                                stroke="light-dark(#6385a3, var(--border-control-strong))"
                                strokeOpacity={0.2}
                                strokeDasharray="2 3"
                              />
                              <text
                                x={m.x}
                                y={m.y + 4}
                                textAnchor="middle"
                                fontSize={12}
                              >
                                {m.count > 9999
                                  ? m.count.toLocaleString("zh-CN", {
                                      notation: "compact",
                                      maximumFractionDigits: 1,
                                    })
                                  : m.count}
                              </text>
                            </>
                          ) : (
                            <ProcessSymbol
                              x={m.x}
                              y={m.y}
                              type={i.event_type}
                              color={color}
                              fill={m.context ? "light-dark(white, var(--surface-subtle))" : color}
                              stroke={
                                m.id === value.anchor
                                  ? "light-dark(#d58c27, var(--selection-anchor))"
                                  : color
                              }
                            />
                          )}{" "}
                          {!multi && m.label && (
                            <text
                              x={m.x + 11}
                              y={m.y - 13}
                              fontSize={12}
                              fill="light-dark(#34516e, var(--text-readable))"
                            >
                              {m.id === value.anchor ? "锚点 · " : ""}
                              {typeLabel(i.event_type, types)}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>
                {hover && (
                  <div
                    className="w-process-tooltip"
                    role="tooltip"
                  >
                    <b>{hover.title}</b>
                    {hover.lines.map((line, index) => (
                      <span key={index}>{line}</span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <ProcessRecords
                params={params}
                data={data}
                group="all"
                enabled={enabled}
                select={select}
                read={read}
                types={types}
              />
            )}
            <div className="w-process-legend">
              {["queue_subordinate_task", "saidit_post", "read_file", "other"].map((t) => (
                <span key={t}>
                  <svg
                    width={18}
                    height={18}
                  >
                    <ProcessSymbol
                      x={9}
                      y={9}
                      type={t}
                      color="light-dark(#638a98, var(--text-readable))"
                    />
                  </svg>
                  {t === "other" ? "其他活动" : typeLabel(t, types)}
                </span>
              ))}
              <span>
                <svg
                  width={20}
                  height={20}
                >
                  <circle
                    cx={10}
                    cy={10}
                    r={8}
                    fill="light-dark(#e5eef7, var(--surface-subtle))"
                    stroke="light-dark(#6385a3, var(--border-control-strong))"
                  />
                  <text
                    x={10}
                    y={13}
                    textAnchor="middle"
                    fontSize={12}
                  >
                    n
                  </text>
                </svg>
                圆形计数：聚合
              </span>
              <span>实心：当前筛选内 · 空心：附近补充 · 橙环：锚点 · 蓝环：当前选中</span>
            </div>
            {detail && (
              <div className="w-event-inspector">
                <b>
                  {typeLabel(detail.event_type, types)} · {time(detail.time_us)}
                </b>
                <p>{detail.preview}</p>
                <p className="mc2-note">
                  {displayId(detail.event_id)} ·{" "}
                  {detail.context ? detail.context_sources.join("、") || "附近补充" : "主选"}
                </p>
                <button onClick={(e) => read(detail, e.currentTarget)}>阅读原始记录</button>
                {detail.roles
                  .filter((r) => r.relation.startsWith("queue_target"))
                  .map((r) => (
                    <button
                      key={r.dst_id}
                      disabled={value.actors?.includes(r.dst_id)}
                      onClick={() =>
                        change({ actors: [...new Set([...(value.actors ?? []), r.dst_id])] })
                      }
                    >
                      加入该目标的附近活动 · {actor(r.dst_id)}
                    </button>
                  ))}
              </div>
            )}
            {mark && (
              <section className="w-event-inspector">
                <h3>
                  聚合 {mark.count} 条 · {mark.context ? "补充" : "主选"}
                </h3>
                <button onClick={() => setMark(null)}>关闭聚合详情</button>
                {mark.events.length > 0 && (
                  <>
                    <p>像素碰撞分组，精确时间未移动 · {mark.events.length}条</p>
                    {mark.events.map((i) => (
                      <button
                        key={i.event_id}
                        onClick={() => select(i)}
                      >
                        {time(i.time_us)} · {typeLabel(i.event_type, types)} ·{" "}
                        {displayId(i.event_id)}
                      </button>
                    ))}
                  </>
                )}
                {mark.aggregates.map((a) => (
                  <div key={a.aggregate_id}>
                    <p>
                      {time(a.bucket_start)} → {time(a.bucket_end)} · {a.count} 条 · {a.file_count}{" "}
                      个文件 · {a.task_count} 条任务 / {a.task_targets} 个目标角色
                    </p>
                    <p>
                      {Object.entries(a.types)
                        .map(([t, n]) => `${typeLabel(t, types)} ${n}`)
                        .join("；")}
                    </p>
                    <ProcessRecords
                      params={params}
                      data={data}
                      group={a.aggregate_id}
                      enabled={enabled}
                      select={select}
                      read={read}
                      types={types}
                      tasks={a.task_count > 0}
                    />
                  </div>
                ))}
              </section>
            )}
            {data.total <= 1 && (
              <p className="w-notice">
                当前窗口仅有锚点，没有记录的步骤不会自动补出。
                <button
                  onClick={() =>
                    change({
                      seconds: Math.min(3600, Math.max(300, value.seconds * 5)),
                      context: true,
                    })
                  }
                >
                  扩大窗口并查看参与活动
                </button>
              </p>
            )}
          </>
        )}
      </PendingRegion>
    </>
  );
}

export function eventFromItem(item: EventItem, scope: Scope): ProcessSelection {
  return {
    anchor: item.event_id,
    anchorTime: item.time_us,
    scope,
    entryScope: scope,
    seconds: 60,
    context: true,
    expand: false,
    pinned: false,
  };
}

function ProcessRecords({
  params,
  data,
  group,
  select,
  read,
  types,
  tasks = false,
  enabled = true,
}: {
  params: Record<string, string | number | undefined>;
  data: Extract<ProcessData, { valid: true }>;
  group: string;
  select: (i: ProcessItem) => void;
  read: (i: ProcessItem, t: HTMLElement) => void;
  types: TypeInfo[];
  tasks?: boolean;
  enabled?: boolean;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [onlyTasks, setOnlyTasks] = useState(false);
  const key = JSON.stringify([data.selection_key, group, onlyTasks]);
  const [previous, setPrevious] = useState(key);
  if (previous !== key) {
    setPrevious(key);
    setCursors([null]);
  }

  const args = {
    ...params,
    aggregate_id: group,
    data_version: data.data_version,
    selection_key: data.selection_key,
    cursor: cursors.at(-1) ?? undefined,
    member_action: onlyTasks ? "queue_subordinate_task" : undefined,
  };

  const resource = useRequest(
    JSON.stringify(args),
    (s) => query<ProcessMembers>("process-members", args, s),
    enabled,
  );

  return (
    <div className="w-process-records">
      <p className="mc2-note">
        精确成员 {resource.loading ? "…" : (resource.data?.total ?? "…")} 条 ·
        按时间、记录ID稳定分页 · 第 {cursors.length} 页
      </p>
      {tasks && (
        <label className="check">
          <input
            type="checkbox"
            checked={onlyTasks}
            onChange={(e) => setOnlyTasks(e.target.checked)}
          />
          只看任务成员及其目标角色
        </label>
      )}
      <RequestStatus {...resource} />
      <PendingRegion
        {...resource}
        minimum={120}
      >
        <ol className="w-process-story">
          {resource.data?.items.map((i) => (
            <li
              key={i.event_id}
              style={{ borderLeftColor: categoryColors[(i.category - 1) % categoryColors.length] }}
            >
              <p>
                {time(i.time_us)} · {actor(i.actor_id)} · {typeLabel(i.event_type, types)} ·{" "}
                {i.context ? i.context_sources.join("、") || "补充" : "主选"}
              </p>
              <p>{i.preview}</p>
              {i.roles
                .filter((r) => r.relation.startsWith("queue_target"))
                .map((r) => (
                  <p key={r.dst_id}>任务目标：{actor(r.dst_id)}</p>
                ))}
              <button onClick={() => select(i)}>定位/选中 {displayId(i.event_id)}</button>
              <button onClick={(e) => read(i, e.currentTarget)}>
                阅读记录
                <ArrowRight size={14} />
              </button>
            </li>
          ))}
        </ol>
      </PendingRegion>
      <div className="mc2-pagination">
        <button
          disabled={cursors.length < 2 || resource.loading}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          <ChevronLeft size={14} />
          上一页过程成员
        </button>
        <button
          disabled={!resource.data?.next_cursor || resource.loading}
          onClick={() => setCursors((c) => [...c, resource.data!.next_cursor!])}
        >
          下一页过程成员
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
