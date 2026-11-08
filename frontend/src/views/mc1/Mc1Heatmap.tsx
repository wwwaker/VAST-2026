import { useMemo } from "react";
import type { Mc1ActivityPayload, Mc1Bucket } from "../../data/api";

export type Mc1Granularity = "day" | "hour" | "round";
/** custom = 快照/URL 带入的非标准渠道子集；此时不把任何按钮标成"全部" */
export type Mc1Scope = "both" | "public" | "internal" | "custom";

/** 热力图与事件轨共用的列宽与列间距；改这里两图一起变，避免列错位。 */
export function mc1CellWidth(granularity: Mc1Granularity): number {
  return granularity === "hour" ? 54 : granularity === "round" ? 70 : 46;
}

export const MC1_CELL_GAP = 2;

export interface Mc1AnchorMark {
  key: string;
  label: string;
  timeUs: number | null;
  tone: "warn" | "accent" | "muted";
}

/**
 * 参考项目风格的角色 × 时间热力图：DOM 网格、行=角色、列=真实时间桶。
 * hover 只给标题摘要，不写任何全局筛选；点击由父级决定（默认只看成员）。
 */
export function Mc1Heatmap({
  payload,
  loading,
  error,
  granularity,
  scope,
  anchors,
  selectedKey,
  onPick,
  scrollRef,
  onScroll,
  cellWidth: preferredCellWidth,
}: {
  payload: Mc1ActivityPayload | null;
  loading: boolean;
  error: string | null;
  granularity: Mc1Granularity;
  scope: Mc1Scope;
  anchors: Mc1AnchorMark[];
  selectedKey: string | null;
  onPick: (agentId: string, column: Mc1Bucket, trigger: HTMLElement | null) => void;
  scrollRef?: React.RefObject<HTMLDivElement>;
  onScroll?: () => void;
  /** 与事件轨共用的列宽：由页面按可用宽度计算后传入，保证两图对齐 */
  cellWidth?: number;
}) {
  const cellMap = useMemo(() => {
    const map = new Map<string, Mc1ActivityPayload["cells"][number]>();
    for (const cell of payload?.cells ?? []) map.set(`${cell.agent_id}|${cell.bucket}`, cell);
    return map;
  }, [payload]);

  const maxCount = useMemo(() => {
    let max = 0;
    for (const cell of payload?.cells ?? []) {
      const value = scope === "public" ? cell.public : scope === "internal" ? cell.internal : cell.public + cell.internal + cell.other;
      if (value > max) max = value;
    }
    return Math.max(1, max);
  }, [payload, scope]);

  const anchorColumns = useMemo(() => {
    const map = new Map<string, Mc1AnchorMark[]>();
    for (const column of payload?.columns ?? []) {
      if (column.start_us == null || column.end_us == null) continue;
      const hits = anchors.filter(
        (anchor) => anchor.timeUs != null && anchor.timeUs >= column.start_us! && anchor.timeUs < column.end_us!,
      );
      if (hits.length) map.set(column.key, hits);
    }
    return map;
  }, [anchors, payload]);

  const cellWidth = preferredCellWidth ?? mc1CellWidth(granularity);

  const shortLabel = (column: Mc1Bucket) => {
    if (!column.start_us) return column.label;
    const iso = new Date(column.start_us / 1000).toISOString();
    if (granularity === "day") return iso.slice(5, 10);
    if (granularity === "hour") return `${iso.slice(5, 10)} ${iso.slice(11, 13)}h`;
    return column.label;
  };

  const cellFill = (value: number) => {
    if (value <= 0) return undefined;
    const ratio = Math.min(1, Math.sqrt(value / maxCount));
    const pct = Math.round(12 + ratio * 62);
    return { background: `color-mix(in srgb, var(--accent) ${pct}%, var(--panel))` };
  };

  if (error) {
    return (
      <div className="callout callout-warn">
        <strong>活动热力图不可用</strong>
        <p className="muted small">{error}</p>
      </div>
    );
  }

  return (
    <div className="mc1-heat">
      {loading && !payload && <p className="muted small">正在读取活动矩阵…</p>}
      {payload && (
        <>
          <div className="mc1-heat-scroll" ref={scrollRef} onScroll={onScroll}>
            <div
              className="mc1-heat-grid"
              style={{
                gridTemplateColumns: `132px repeat(${Math.max(1, payload.columns.length)}, ${cellWidth}px)`,
                gap: `${MC1_CELL_GAP}px`,
              }}
              aria-label="角色活动热力图"
            >
              <div className="mc1-heat-corner">角色 \ 时间</div>
              {payload.columns.map((column) => {
                const marks = anchorColumns.get(column.key) ?? [];
                return (
                  <div
                    key={column.key}
                    className={`mc1-heat-col${marks.length ? " has-anchor" : ""}`}
                    title={`${column.label} · ${column.matched_events} 条事件`}
                  >
                    <span>{shortLabel(column)}</span>
                    {marks.map((mark) => (
                      <span
                        key={mark.key}
                        className={`mc1-anchor-dot mc1-anchor-${mark.tone}`}
                        title={`锚点：${mark.label}`}
                      />
                    ))}
                  </div>
                );
              })}

              {payload.agents.map((agent) => (
                <div className="mc1-heat-row" key={agent.agent_id} style={{ display: "contents" }}>
                  <div className="mc1-heat-label" title={agent.agent_id}>
                    {agent.label ?? agent.agent_id.split(":").pop()}
                  </div>
                  {payload.columns.map((column) => {
                    const cell = cellMap.get(`${agent.agent_id}|${column.key}`);
                    const pub = cell?.public ?? 0;
                    const internal = cell?.internal ?? 0;
                    const other = cell?.other ?? 0;
                    const value = scope === "public" ? pub : scope === "internal" ? internal : pub + internal + other;
                    const key = `${agent.agent_id}|${column.key}`;
                    const label = agent.label ?? agent.agent_id.split(":").pop();
                    return (
                      <button
                        key={column.key}
                        type="button"
                        tabIndex={cell?.empty ? -1 : 0}
                        className={`mc1-heat-cell${cell?.empty ? " is-empty" : ""}${selectedKey === key ? " is-selected" : ""}`}
                        style={cellFill(value)}
                        aria-pressed={selectedKey === key}
                        data-cell-key={key}
                        aria-label={
                          cell?.empty
                            ? `${label} ${column.label} 无记录`
                            : `${label} ${column.label} 公开 ${pub} 内部 ${internal}`
                        }
                        title={
                          cell?.empty
                            ? `${label} · ${column.label}：无记录（空状态，不等于未履职）`
                            : `${label} · ${column.label}\n公开 ${pub} · 内部 ${internal}${other ? ` · 其他 ${other}` : ""}`
                        }
                        onClick={(event) => onPick(agent.agent_id, column, event.currentTarget)}
                      >
                        {cell?.empty ? (
                          <span className="mc1-cell-dash">—</span>
                        ) : (
                          <span className="mc1-cell-nums">
                            {scope !== "internal" && pub > 0 && <em className="mc1-num-public">{pub}</em>}
                            {scope !== "public" && internal > 0 && <em className="mc1-num-internal">{internal}</em>}
                            {scope !== "both" && (scope === "public" ? pub : internal) === 0 && other > 0 && (
                              <em className="mc1-num-other">{other}</em>
                            )}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="mc1-heat-legend">
            <span>
              <em className="mc1-num-public">n</em> 公开渠道
            </span>
            <span>
              <em className="mc1-num-internal">n</em> 内部渠道
            </span>
            <span>— 该时段无记录（区分于 0 条）</span>
            <span className="mc1-heat-counts">
              匹配消息 {payload.matched_messages} · 公开 {payload.public_messages} · 内部 {payload.internal_messages}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
