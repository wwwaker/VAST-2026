import { useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { useTheme } from "../../theme/theme";
import {
  formatUtc,
  type Mc1AnalystMarker,
  type Mc1DecisionPayload,
  type Mc1EnvironmentRecord,
  type Mc1EventRef,
} from "../../data/api";

const W = 1000;
const H = 230;
const LEFT = 108;
const RIGHT = 24;
const LANES = [
  { key: "environment", label: "外部环境轨" },
  { key: "constraints", label: "禁发约束轨" },
  { key: "messages", label: "agent 消息轨" },
  { key: "releases", label: "公开发布轨" },
];

type Picked =
  | { kind: "environment"; item: Mc1EnvironmentRecord }
  | { kind: "marker"; item: Mc1AnalystMarker }
  | { kind: "event"; item: Mc1EventRef };

/** 决策泳道：外部环境 / 禁发约束 / agent 消息 / 公开发布严格分层。 */
export function DecisionTimeline({
  payload,
  loading,
  error,
}: {
  payload: Mc1DecisionPayload | null;
  loading: boolean;
  error: string | null;
}) {
  const { selectEvent } = useWorkspace();
  const { colors } = useTheme();
  const [picked, setPicked] = useState<Picked | null>(null);

  const layout = useMemo(() => {
    if (!payload) return null;
    const start = payload.window.start_us;
    const end = payload.window.end_us;
    const span = Math.max(1, end - start);
    const xOf = (us: number) => LEFT + ((us - start) / span) * (W - LEFT - RIGHT);
    const laneY = (lane: number) => 56 + lane * 40;
    return { start, end, span, xOf, laneY };
  }, [payload]);

  if (error) {
    return (
      <div className="callout callout-warn">
        <strong>决策泳道不可用</strong>
        <p className="muted small">{error}</p>
      </div>
    );
  }

  const anchors = payload?.anchors;
  const reportUs = anchors?.external_report?.time_us ?? null;
  const confirmUs = anchors?.first_internal_confirmation?.time_us ?? null;
  const liftUs = anchors?.formal_lift?.time_us ?? null;

  return (
    <section className="mc1-block" aria-label="MC1 决策泳道">
      <div className="canvas-subbar">
        <strong>决策泳道</strong>
        <span className="muted small">
          窗口 {payload ? `${formatUtc(payload.window.start_us)} → ${formatUtc(payload.window.end_us)}` : "—"}
          {payload?.window.source === "default" ? "（默认：目标帖 ±2 小时）" : ""}
        </span>
        {payload && payload.reply_audit.baseline_compatible === false && (
          <span className="tag tag-warn">回复分类与派生基线不一致</span>
        )}
      </div>

      {loading && !payload && <p className="muted small">正在读取决策泳道…</p>}

      {payload && layout && (
        <>
          <div className="mc1-anchors">
            <span className="mc1-anchor mc1-anchor-env">
              17:00 外部报道 <code className="mono">{anchors?.external_report?.context_id ?? "缺口"}</code>
            </span>
            <span className="mc1-anchor mc1-anchor-agent">
              17:25 内部确认{" "}
              <code className="mono">{anchors?.first_internal_confirmation?.event_id ?? "缺口"}</code>
            </span>
            <span className="mc1-anchor mc1-anchor-lift">
              18:00 解禁 <code className="mono">{anchors?.formal_lift?.event_id ?? "缺口"}</code>
            </span>
            <span className="muted small">{anchors?.note}</span>
          </div>

          <svg className="mc1-lanes" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="MC1 决策泳道时间轴">
            {[0, 1, 2, 3, 4].map((index) => {
              const us = layout.start + (layout.span * index) / 4;
              const x = layout.xOf(us);
              return (
                <g key={index}>
                  <line x1={x} y1={18} x2={x} y2={H - 28} stroke={colors.grid} strokeDasharray="2 4" opacity={0.7} />
                  <text x={x} y={H - 10} textAnchor="middle" fontSize={10} fill={colors.textMuted}>
                    {formatUtc(us)}
                  </text>
                </g>
              );
            })}

            {LANES.map((lane, index) => (
              <g key={lane.key}>
                <text x={LEFT - 10} y={layout.laneY(index) + 4} textAnchor="end" fontSize={11} fill={colors.textMuted}>
                  {lane.label}
                </text>
                <line x1={LEFT} y1={layout.laneY(index)} x2={W - RIGHT} y2={layout.laneY(index)} stroke={colors.grid} />
              </g>
            ))}

            {/* 环境轨：轮次精度画成区间带，不伪装成精确点 */}
            {payload.tracks.environment.map((item) => {
              const x1 = layout.xOf(item.round_start_us ?? item.time_us);
              const x2 = layout.xOf(item.round_end_us ?? item.time_us + 1);
              return (
                <rect
                  key={item.context_id}
                  x={Math.min(x1, x2)}
                  y={layout.laneY(0) - 6}
                  width={Math.max(2, Math.abs(x2 - x1))}
                  height={12}
                  fill={colors.accent}
                  opacity={item.time_precision === "round" ? 0.18 : 0.45}
                  onClick={() => setPicked({ kind: "environment", item })}
                >
                  <title>{`${item.kind} · ${item.time_precision ?? ""} · ${item.value}`}</title>
                </rect>
              );
            })}

            {/* 约束轨：环境叙事或人工标记，注明依据 */}
            {payload.tracks.constraints.map((item) => {
              const x1 = layout.xOf(item.round_start_us ?? item.time_us);
              const x2 = layout.xOf(item.round_end_us ?? item.time_us + 1);
              return (
                <rect
                  key={`c-${item.context_id}`}
                  x={Math.min(x1, x2)}
                  y={layout.laneY(1) - 6}
                  width={Math.max(2, Math.abs(x2 - x1))}
                  height={12}
                  fill={colors.warn}
                  opacity={0.35}
                  onClick={() => setPicked({ kind: "environment", item })}
                >
                  <title>{`${item.constraint_basis} · ${item.value}`}</title>
                </rect>
              );
            })}

            {payload.tracks.markers.map((marker) => {
              const x = layout.xOf(marker.time_us);
              return (
                <g key={marker.context_id} onClick={() => setPicked({ kind: "marker", item: marker })}>
                  <path
                    d={`M ${x} ${layout.laneY(2) - 8} L ${x + 6} ${layout.laneY(2)} L ${x} ${layout.laneY(2) + 8} L ${x - 6} ${layout.laneY(2)} Z`}
                    fill="none"
                    stroke={colors.warn}
                    strokeDasharray="2 2"
                  />
                  <title>{`人工标记（analyst）· ${marker.label}`}</title>
                </g>
              );
            })}

            {/* agent 消息轨：内部实心、公开空心 */}
            {payload.tracks.messages.map((item) => {
              const x = layout.xOf(item.time_us);
              const isPublic = item.channel_scope === "public";
              return (
                <circle
                  key={item.event_id}
                  cx={x}
                  cy={layout.laneY(2)}
                  r={4}
                  fill={isPublic ? "none" : colors.accent}
                  stroke={isPublic ? colors.accent : "none"}
                  onClick={() => selectEvent(item.event_id, item.time_us)}
                >
                  <title>{`${formatUtc(item.time_us)} · ${item.channel} · ${item.reply_class ?? ""}`}</title>
                </circle>
              );
            })}

            {/* 公开发布轨 */}
            {payload.tracks.releases.map((item) => {
              const x = layout.xOf(item.time_us);
              return (
                <rect
                  key={`r-${item.event_id}`}
                  x={x - 4}
                  y={layout.laneY(3) - 4}
                  width={8}
                  height={8}
                  fill={colors.textMuted}
                  onClick={() => selectEvent(item.event_id, item.time_us)}
                >
                  <title>{`${formatUtc(item.time_us)} · ${item.channel} · ${item.preview}`}</title>
                </rect>
              );
            })}

            {/* 三个锚点竖线，避免外部报道与内部确认混淆 */}
            {[
              { us: reportUs, color: colors.warn },
              { us: confirmUs, color: colors.accent },
              { us: liftUs, color: colors.textMuted },
            ].map((anchor, index) =>
              anchor.us == null ? null : (
                <line
                  key={`anchor-${index}`}
                  x1={layout.xOf(anchor.us)}
                  y1={22}
                  x2={layout.xOf(anchor.us)}
                  y2={H - 28}
                  stroke={anchor.color}
                  strokeWidth={1.4}
                  strokeDasharray={index === 0 ? "6 3" : undefined}
                />
              ),
            )}
          </svg>

          <div className="mc1-lane-legend muted small">
            <span>环境/约束按轮次区间画带（半透明，不是精确时刻）</span>
            <span>消息：实心=内部 · 空心=公开</span>
            <span>菱形虚线=人工标记（analyst）</span>
          </div>

          <div className="mc1-detail">
            {picked ? (
              <PickedDetail picked={picked} />
            ) : (
              <p className="muted small">点击轨道上的记录查看来源；点击消息点可在事件详情中回查原始记录。</p>
            )}
          </div>

          <details className="mc1-flow-audit">
            <summary>回复引用分类与口径（{payload.reply_audit.reply_edges} 条 reply 边）</summary>
            <div className="mc1-audit">
              <strong>回复引用分类</strong>
              <span className="muted small">
                valid {payload.reply_audit.counts.reply_valid ?? 0} · future{" "}
                {payload.reply_audit.counts.reply_future_reference ?? 0} · empty{" "}
                {payload.reply_audit.counts.empty_reference ?? 0} · mention{" "}
                {payload.reply_audit.counts.mention ?? 0} · unresolved{" "}
                {payload.reply_audit.counts.unresolved_reference ?? 0}
              </span>
              <span className="muted small">{payload.reply_audit.mapping_note}</span>
            </div>
            <ul className="tight-list muted small">
              {payload.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

function PickedDetail({ picked }: { picked: Picked }) {
  if (picked.kind === "event") {
    return (
      <div className="callout">
        <strong className="mono">{picked.item.event_id}</strong>
        <p className="muted small">
          {formatUtc(picked.item.time_us)} · {picked.item.channel} · {picked.item.reply_class}
        </p>
        <p className="muted small">{picked.item.preview}</p>
      </div>
    );
  }
  if (picked.kind === "marker") {
    return (
      <div className="callout">
        <strong>
          人工标记 · {picked.item.label} <span className="tag tag-warn">analyst</span>
        </strong>
        <p className="muted small">
          {formatUtc(picked.item.time_us)} · {picked.item.kind} ·{" "}
          {picked.item.message_ids.length} 条关联消息
        </p>
        <p className="muted small">来源：{picked.item.source_pointers.join("；") || "—"}</p>
      </div>
    );
  }
  const item = picked.item;
  return (
    <div className="callout">
      <strong className="mono">{item.context_id}</strong>
      <p className="muted small">
        {item.kind} · {formatUtc(item.time_us)} · 精度 {item.time_precision ?? "—"}
        {item.constraint_basis ? ` · 约束依据 ${item.constraint_basis}` : ""}
      </p>
      <p className="muted small">{item.value}</p>
      <p className="muted small">来源：{item.source_pointer ?? "—"}</p>
    </div>
  );
}
