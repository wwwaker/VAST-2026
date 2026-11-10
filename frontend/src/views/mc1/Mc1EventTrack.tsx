import { useMemo } from "react";
import { formatUtc, type Mc1Bucket, type Mc1DecisionPayload, type Mc1EnvironmentRecord } from "../../data/api";
import { MC1_CELL_GAP, type Mc1AnchorMark } from "./Mc1Heatmap";

const LABEL_W = 156;
const LANE_H = 24;
const TOP = 18;

/**
 * 与热力图共用列宽和列起点的紧凑事件轨：环境/约束、消息、发布三条轨。
 * 数据来自 /api/mc1/context（真实轨道），不是参考项目的硬编码事件弧线。
 */
export function Mc1EventTrack({
  payload,
  columns,
  cellWidth,
  anchors,
  scrollRef,
  onScroll,
  onSelectEvent,
  onPickEnvironment,
  selectedEventId,
  onFocusAnchor,
}: {
  payload: Mc1DecisionPayload | null;
  columns: Mc1Bucket[];
  cellWidth: number;
  anchors: Mc1AnchorMark[];
  scrollRef: React.RefObject<HTMLDivElement>;
  onScroll: () => void;
  onSelectEvent: (eventId: string, timeUs: number, trigger: Element | null, channel: string | null) => void;
  onPickEnvironment: (record: Mc1EnvironmentRecord, trigger: Element | null) => void;
  selectedEventId?: string | null;
  onFocusAnchor?: () => void;
}) {
  // 底部预留三行锚点标签的位置，避免相邻锚点（17:00 / 18:00）文字互相压住
  const height = TOP + LANE_H * 3 + 34;

  const pitch = cellWidth + MC1_CELL_GAP;

  const geometry = useMemo(() => {
    const usable = columns.filter((column) => column.start_us != null && column.end_us != null);
    const width = LABEL_W + Math.max(1, columns.length) * pitch;
    const indexOf = (timeUs: number) => {
      for (let index = 0; index < usable.length; index += 1) {
        const column = usable[index];
        if (timeUs >= (column.start_us as number) && timeUs < (column.end_us as number)) return index;
      }
      return -1;
    };
    // 列内按真实时间比例定位：列边界仍与热力图对齐，但同一列内的时间先后可分辨
    const xOf = (timeUs: number) => {
      const index = indexOf(timeUs);
      if (index < 0) return null;
      const column = usable[index];
      const start = column.start_us as number;
      const span = Math.max(1, (column.end_us as number) - start);
      const frac = Math.min(0.96, Math.max(0.04, (timeUs - start) / span));
      return LABEL_W + MC1_CELL_GAP + index * pitch + frac * cellWidth;
    };
    return { width, indexOf, xOf };
  }, [cellWidth, columns, pitch]);

  if (!payload) {
    return (
      <p className="muted small">
        事件轨等待 /api/mc1/context：环境轨、约束轨与公开发布需要派生视图。
      </p>
    );
  }

  const lanes = ["环境/约束", "消息", "发布"];
  const laneY = (index: number) => TOP + index * LANE_H + LANE_H / 2;
  const pinned = payload.pinned_events ?? [];
  const drawn = payload.tracks.messages.length;
  const laneTotal = payload.messages_total ?? drawn;

  return (
    <div className="mc1-track-wrap">
      {payload.truncated && (
        <div className="mc1-track-status" role="status" data-testid="mc1-track-truncation">
          <strong>事件轨已截断</strong>
          <span>
            本窗口 {laneTotal} 条 · 绘制 {drawn} 条（单窗口上限 {payload.lane_limit}）
          </span>
          <span className="muted small">
            {pinned.length > 0 ? `已补入关键事件 ${pinned.length} 条（带描边）` : "无需补入关键事件"}
          </span>
          <details>
            <summary>范围与补入明细</summary>
            <p className="muted small">
              未绘制的条目不在图上。
              {pinned.length > 0 ? ` 补入：${pinned.join("、")}。` : ""}
            </p>
            {onFocusAnchor && (
              <button type="button" className="btn btn-quiet" onClick={onFocusAnchor}>
                定位到首条内部确认 ±30m
              </button>
            )}
          </details>
        </div>
      )}
      <div className="mc1-track-scroll" ref={scrollRef} onScroll={onScroll}>
        <svg
          className="mc1-track-svg"
          width={geometry.width}
          height={height}
          role="img"
          aria-label="与环境/约束、消息、发布分轨的事件轨"
        >
          {lanes.map((lane, index) => (
            <g key={lane}>
              <text x={4} y={laneY(index) + 4} className="mc1-track-lane-label">
                {lane}
              </text>
              <line
                x1={LABEL_W - 8}
                y1={laneY(index)}
                x2={geometry.width}
                y2={laneY(index)}
                className="mc1-track-axis"
              />
            </g>
          ))}

          {columns.map((column, index) => (
            <line
              key={column.key}
              x1={LABEL_W + MC1_CELL_GAP + index * pitch}
              y1={TOP - 6}
              x2={LABEL_W + MC1_CELL_GAP + index * pitch}
              y2={height - 18}
              className="mc1-track-grid"
            />
          ))}

          {/* 环境/约束只记录轮次精度：按轮次区间画半透明带，另标出记录时刻，避免伪装成精确点 */}
          {payload.tracks.environment.map((record) => {
            const x1 = geometry.xOf(record.round_start_us ?? record.time_us);
            const x2 = geometry.xOf(record.round_end_us ?? record.time_us);
            if (x1 == null && x2 == null) return null;
            const left = Math.min(x1 ?? x2!, x2 ?? x1!);
            const width = Math.max(7, Math.abs((x2 ?? x1!) - (x1 ?? x2!)));
            return (
              <rect
                key={`env-band-${record.context_id}`}
                x={left}
                y={laneY(0) - 8}
                width={width}
                height={16}
                rx={2}
                className="mc1-track-env-band"
              >
                <title>{`${record.kind} · 轮次精度 ${record.time_precision ?? ""} · ${record.value}`}</title>
              </rect>
            );
          })}

          {payload.tracks.environment.map((record) => {
            const x = geometry.xOf(record.time_us);
            if (x == null) return null;
            return (
              <rect
                key={record.context_id}
                x={x - 3}
                y={laneY(0) - 7}
                width={6}
                height={14}
                rx={1.5}
                className="mc1-track-env"
                tabIndex={0}
                role="button"
                aria-label={`环境记录 ${record.kind} ${formatUtc(record.time_us)}`}
                data-context-id={record.context_id}
                onClick={(event) => onPickEnvironment(record, event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPickEnvironment(record, event.currentTarget);
                  }
                }}
              >
                <title>{`${record.kind} · ${formatUtc(record.time_us)} · ${record.value}`}</title>
              </rect>
            );
          })}

          {payload.tracks.constraints.map((record) => {
            const x1 = geometry.xOf(record.round_start_us ?? record.time_us);
            const x2 = geometry.xOf(record.round_end_us ?? record.time_us);
            if (x1 == null && x2 == null) return null;
            const left = Math.min(x1 ?? x2!, x2 ?? x1!);
            const width = Math.max(7, Math.abs((x2 ?? x1!) - (x1 ?? x2!)));
            return (
              <rect
                key={`constraint-band-${record.context_id}`}
                x={left}
                y={laneY(0) + 2}
                width={width}
                height={7}
                rx={1.5}
                className="mc1-track-constraint-band"
              >
                <title>{`约束区间 · ${record.constraint_basis ?? record.kind} · ${record.value}`}</title>
              </rect>
            );
          })}

          {payload.tracks.constraints.map((record) => {
            const x = geometry.xOf(record.time_us);
            if (x == null) return null;
            return (
              <rect
                key={`c-${record.context_id}`}
                x={x - 4}
                y={laneY(0) + 2}
                width={8}
                height={5}
                className="mc1-track-constraint"
                tabIndex={0}
                role="button"
                aria-label={`约束记录 ${record.constraint_basis ?? record.kind}`}
                onClick={(event) => onPickEnvironment(record, event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPickEnvironment(record, event.currentTarget);
                  }
                }}
              >
                <title>{`约束 · ${record.constraint_basis ?? record.kind} · ${record.value}`}</title>
              </rect>
            );
          })}

          {payload.tracks.markers.map((marker) => {
            const x = geometry.xOf(marker.time_us);
            if (x == null) return null;
            return (
              <rect
                key={marker.context_id}
                x={x - 4}
                y={laneY(1) - 4}
                width={8}
                height={8}
                transform={`rotate(45 ${x} ${laneY(1)})`}
                className="mc1-track-marker"
              >
                <title>{`人工标记（analyst）· ${marker.label}`}</title>
              </rect>
            );
          })}

          {payload.tracks.messages.map((item, index) => {
            const x = geometry.xOf(item.time_us);
            if (x == null) return null;
            const isPublic = item.channel_scope === "public";
            const isPinned = Boolean(item.pinned) || pinned.includes(item.event_id);
            const isSelected = selectedEventId === item.event_id;
            // 同一时刻的多条消息微移，避免完全重叠；lane 内可用高度 ±7px
            const jitter = ((index % 5) - 2) * 3.2;
            return (
              <circle
                key={item.event_id}
                cx={x}
                cy={laneY(1) + jitter}
                r={isSelected ? 5 : 4}
                data-event-id={item.event_id}
                className={`mc1-track-msg${isPublic ? " is-public" : ""}${isPinned ? " is-pinned" : ""}${
                  isSelected ? " is-selected" : ""
                }`}
                tabIndex={0}
                role="button"
                aria-label={`${formatUtc(item.time_us)} ${item.channel ?? ""} ${item.preview?.slice(0, 40) ?? ""}`}
                onClick={(event) =>
                  onSelectEvent(item.event_id, item.time_us, event.currentTarget, item.channel ?? null)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectEvent(item.event_id, item.time_us, event.currentTarget, item.channel ?? null);
                  }
                }}
              >
                <title>{`${formatUtc(item.time_us)} · ${item.channel ?? ""} · ${item.reply_class ?? ""}${
                  isPinned ? " · 截断后补入的关键事件" : ""
                }`}</title>
              </circle>
            );
          })}

          {payload.tracks.releases.map((item) => {
            const x = geometry.xOf(item.time_us);
            if (x == null) return null;
            return (
              <rect
                key={item.event_id}
                x={x - 4}
                y={laneY(2) - 4}
                width={8}
                height={8}
                data-event-id={item.event_id}
                className={`mc1-track-release${
                  (Boolean(item.pinned) || pinned.includes(item.event_id)) ? " is-pinned" : ""
                }${selectedEventId === item.event_id ? " is-selected" : ""}`}
                tabIndex={0}
                role="button"
                aria-label={`公开发布 ${formatUtc(item.time_us)} ${item.channel ?? ""}`}
                onClick={(event) =>
                  onSelectEvent(item.event_id, item.time_us, event.currentTarget, item.channel ?? null)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectEvent(item.event_id, item.time_us, event.currentTarget, item.channel ?? null);
                  }
                }}
              >
                <title>{`公开发布 · ${formatUtc(item.time_us)} · ${item.channel ?? ""}`}</title>
              </rect>
            );
          })}

          {anchors.map((anchor, index) => {
            if (anchor.timeUs == null) return null;
            const x = geometry.xOf(anchor.timeUs);
            if (x == null) return null;
            // 靠右的锚点标签向左对齐，避免被卡片边缘裁掉
            const flip = x > geometry.width - 44;
            return (
              <g key={anchor.key}>
                <line
                  x1={x}
                  y1={TOP - 8}
                  x2={x}
                  y2={height - 18}
                  className={`mc1-track-anchor mc1-anchor-${anchor.tone}`}
                />
                <text
                  x={flip ? x - 3 : x + 3}
                  y={height - 6 - index * 10}
                  textAnchor={flip ? "end" : "start"}
                  className="mc1-track-anchor-label"
                >
                  {anchor.key === "external" ? "17:00 context" : anchor.key === "confirm" ? "确认" : "解禁"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <details className="mc1-track-legend-box">
        <summary>图例与列对齐</summary>
        <p className="mc1-track-legend muted small">
          <span>环境/约束：区间带=轮次精度范围 · 竖条=记录时刻 · 短横=禁发/约束</span>
          <span>消息：实心=内部 · 空心=公开 · 菱形=人工标记 · 描边=截断后补入</span>
          <span>发布：方块=公开发布</span>
          <span>列与热力图共用同一时间桶与列宽，横向滚动同步</span>
        </p>
      </details>
    </div>
  );
}
