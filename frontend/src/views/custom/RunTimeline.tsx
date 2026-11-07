import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { useTheme } from "../../theme/theme";
import {
  SECOND_US,
  fetchRun,
  formatDuration,
  formatUtc,
  type EventItem,
  type RunAuditRule,
  type RunDetailPayload,
} from "../../data/api";

const ROLES = ["controller", "coordinator", "researcher", "writer", "reviewer", "publisher", "unknown"] as const;
const ROLE_LABEL: Record<string, string> = {
  controller: "controller",
  coordinator: "coordinator",
  researcher: "researcher",
  writer: "writer",
  reviewer: "reviewer",
  publisher: "publisher",
  unknown: "未知执行者",
};

const W = 1000;
const LANE_H = 44;
const TOP = 30;
const LEFT = 96;
const RIGHT = 20;

const OK_STATUS = new Set(["valid", "current", "published_current", "false", "ok"]);
const RISK_STATUS = new Set(["invalid", "stale", "published_stale", "denied", "failed", "true"]);

function statusClass(status: string): string {
  if (OK_STATUS.has(status)) return "tag tag-ok";
  if (RISK_STATUS.has(status)) return "tag tag-risk";
  return "tag tag-warn";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    valid: "有效",
    invalid: "无效",
    unknown: "未知",
    current: "当前版本",
    stale: "旧版本",
    published_current: "发布当前版本",
    published_stale: "发布旧版本",
    denied: "被拒绝",
    failed: "失败",
    true: "是",
    false: "否",
    candidate: "线索",
  };
  return labels[status] ?? status;
}

function roleOf(entityId: string | null): string {
  if (!entityId) return "unknown";
  return entityId.slice(entityId.lastIndexOf(":") + 1);
}

export function RunTimeline({
  runId,
  onBack,
  onCompare,
}: {
  runId: string;
  onBack: () => void;
  onCompare: (runId: string) => void;
}) {
  const { cursor, masking, selectedEventId, selectEvent, filters } = useWorkspace();
  const { colors } = useTheme();
  const [detail, setDetail] = useState<RunDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRule, setActiveRule] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDetail(null);
    fetchRun(runId, { cursorUs: cursor, masking, filters }, controller.signal)
      .then((payload) => {
        if (!controller.signal.aborted) setDetail(payload);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [runId, cursor, masking, filters]);

  const layout = useMemo(() => {
    if (!detail) return null;
    const events = detail.events;
    if (events.length === 0) return null;
    const startUs = detail.run.start_us ?? events[0].time_us;
    const endUs = detail.run.end_us ?? events[events.length - 1].time_us;
    const span = Math.max(SECOND_US, endUs - startUs);
    const xOf = (us: number) => LEFT + ((us - startUs) / span) * (W - LEFT - RIGHT);
    const laneOf = (event: EventItem) => {
      const role = roleOf(event.actor_id);
      const index = ROLES.indexOf(role as (typeof ROLES)[number]);
      return index === -1 ? ROLES.length - 1 : index;
    };
    const positions = new Map<string, { x: number; y: number; event: EventItem; lane: number }>();
    for (const event of events) {
      const lane = laneOf(event);
      positions.set(event.event_id, {
        x: xOf(event.time_us),
        y: TOP + lane * LANE_H + LANE_H / 2,
        event,
        lane,
      });
    }
    return { events, startUs, endUs, span, xOf, positions };
  }, [detail]);

  if (error) {
    return (
      <div className="empty-state">
        <h2>运行读取失败</h2>
        <p>{error}</p>
        <button type="button" className="btn" onClick={onBack}>返回运行列表</button>
      </div>
    );
  }

  if (!detail || !layout) {
    return <div className="empty-state"><p className="muted">{loading ? "正在载入运行…" : "该运行当前没有可见事件"}</p></div>;
  }

  const { run, audit } = detail;
  const height = TOP + ROLES.length * LANE_H + 24;
  const ticks = [0, 1, 2, 3, 4, 5].map((index) => layout.startUs + (layout.span * index) / 5);

  const selectEvidence = (eventId: string) => {
    const event = layout.events.find((item) => item.event_id === eventId);
    if (event) selectEvent(event.event_id, event.time_us);
  };

  return (
    <div className="run-detail">
      <div className="run-detail-head">
        <div>
          <h2>
            <span className="mono">{run.run_id}</span>
          </h2>
          <p className="muted small">
            {run.model ?? "模型未知"} · {(run.fixture ?? "fixture 未知").split("/").pop()} · 场景{" "}
            {run.scenario ?? "未标注"} · observed {String(run.observed)} · {run.event_count} 条事件 ·{" "}
            {formatDuration(run.duration_us)}
            {masking && cursor != null && ` · 回放截止 ${formatUtc(cursor)}`}
          </p>
        </div>
        <div className="run-detail-tools">
          <button type="button" className="btn btn-quiet" onClick={onBack}>返回运行列表</button>
          <button
            type="button"
            className="btn"
            onClick={() => onCompare(run.run_id)}
            disabled={!detail.pair}
            title={detail.pair ? "与同模型同任务的正常对照比较" : "该运行没有已核验的正常对照"}
          >
            与正常对照比较
          </button>
        </div>
      </div>

      <div className="run-lanes">
        <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label="单次运行流程泳道" preserveAspectRatio="xMidYMid meet">
          {ROLES.map((role, index) => (
            <g key={role}>
              <rect
                x={LEFT}
                y={TOP + index * LANE_H}
                width={W - LEFT - RIGHT}
                height={LANE_H}
                fill={index % 2 === 0 ? colors.panel : "transparent"}
                opacity={0.4}
              />
              <text x={LEFT - 10} y={TOP + index * LANE_H + LANE_H / 2 + 4} textAnchor="end" fontSize={11} fill={colors.textMuted}>
                {ROLE_LABEL[role]}
              </text>
              <line
                x1={LEFT}
                y1={TOP + index * LANE_H + LANE_H}
                x2={W - RIGHT}
                y2={TOP + index * LANE_H + LANE_H}
                stroke={colors.grid}
                strokeWidth={1}
              />
            </g>
          ))}

          {/* 模型调用区间：只画有起止配对的调用 */}
          {detail.calls
            .filter((call) => !call.unpaired && call.start_us != null)
            .map((call, index) => {
              const role = call.role ?? "unknown";
              const lane = Math.max(0, ROLES.indexOf(role as (typeof ROLES)[number]));
              const x0 = layout.xOf(call.start_us as number);
              const x1 = Math.max(x0 + 2, layout.xOf(call.end_us));
              return (
                <rect
                  key={`call-${index}`}
                  x={x0}
                  y={TOP + lane * LANE_H + 6}
                  width={x1 - x0}
                  height={LANE_H - 12}
                  rx={4}
                  fill={colors.accent}
                  opacity={0.08}
                >
                  <title>{`模型调用 ${formatDuration((call.end_us - (call.start_us as number)))}`}</title>
                </rect>
              );
            })}

          {detail.links.map((link) => {
            const from = layout.positions.get(link.source_event_id);
            const to = layout.positions.get(link.target_event_id);
            if (!from || !to) return null;
            return (
              <path
                key={`${link.source_event_id}-${link.target_event_id}`}
                d={`M ${from.x} ${from.y} C ${(from.x + to.x) / 2} ${from.y} ${(from.x + to.x) / 2} ${to.y} ${to.x} ${to.y}`}
                fill="none"
                stroke={colors.textFaint}
                strokeWidth={1}
                opacity={0.55}
              />
            );
          })}

          {layout.events.map((event) => {
            const position = layout.positions.get(event.event_id);
            if (!position) return null;
            const selected = event.event_id === selectedEventId;
            const isPublish = event.event_type.startsWith("publish");
            const isReview = ["submit_review", "review_decision", "version_updated"].includes(event.event_type);
            const isFile = event.event_type.startsWith("file_");
            const fill = colors.categories[Math.max(0, Math.min(7, event.category - 1))];
            return (
              <g
                key={event.event_id}
                className="run-event"
                onClick={() => selectEvent(event.event_id, event.time_us)}
                role="button"
                tabIndex={0}
                onKeyDown={(keyboard) => {
                  if (keyboard.key === "Enter" || keyboard.key === " ") selectEvent(event.event_id, event.time_us);
                }}
              >
                <title>{`${formatUtc(event.time_us)}\n${event.event_type}\n${event.actor_label ?? event.actor_id ?? "执行者未知"}\n${event.preview}`}</title>
                {isPublish ? (
                  <polygon
                    points={`${position.x},${position.y - 7} ${position.x - 6},${position.y + 5} ${position.x + 6},${position.y + 5}`}
                    fill={fill}
                    stroke={selected ? colors.accent : colors.panel}
                    strokeWidth={selected ? 2.5 : 1}
                  />
                ) : isReview ? (
                  <rect
                    x={position.x - 5}
                    y={position.y - 5}
                    width={10}
                    height={10}
                    transform={`rotate(45 ${position.x} ${position.y})`}
                    fill={fill}
                    stroke={selected ? colors.accent : colors.panel}
                    strokeWidth={selected ? 2.5 : 1}
                  />
                ) : isFile ? (
                  <rect
                    x={position.x - 5}
                    y={position.y - 5}
                    width={10}
                    height={10}
                    fill={fill}
                    stroke={selected ? colors.accent : colors.panel}
                    strokeWidth={selected ? 2.5 : 1}
                  />
                ) : (
                  <circle
                    cx={position.x}
                    cy={position.y}
                    r={event.event_type === "agent_message" ? 5 : 3.5}
                    fill={fill}
                    stroke={selected ? colors.accent : colors.panel}
                    strokeWidth={selected ? 2.5 : 1}
                  />
                )}
              </g>
            );
          })}

          <line x1={LEFT} y1={TOP - 6} x2={W - RIGHT} y2={TOP - 6} stroke={colors.border} />
          {ticks.map((tick, index) => (
            <text
              key={index}
              x={layout.xOf(tick)}
              y={TOP - 12}
              textAnchor={index === 0 ? "start" : index === 5 ? "end" : "middle"}
              fontSize={10}
              fill={colors.textFaint}
            >
              +{formatDuration(tick - layout.startUs)}
            </text>
          ))}
        </svg>
      </div>

      <div className="row">
        <span className="legend-item">● 消息</span>
        <span className="legend-item">■ 文件</span>
        <span className="legend-item">◆ 审核/版本</span>
        <span className="legend-item">▲ 发布</span>
        <span className="legend-item legend-off">浅色条 = 模型调用区间</span>
        <span className="legend-item legend-off">连线 = 明确 parent 记录</span>
      </div>

      <div className="audit">
        <div className="audit-head">
          <h3>审计（由事件字段重算）</h3>
          <p className="muted small">
            尝试 {audit.summary.attempt_count} · 审核有效 {audit.summary.review_valid} / 无效{" "}
            {audit.summary.review_invalid} / 未知 {audit.summary.review_unknown} · 发布当前版本{" "}
            {audit.summary.published_current} / 旧版 {audit.summary.published_stale} / 拒绝{" "}
            {audit.summary.denied} · 重复交接 {audit.summary.repeated_handoff}
          </p>
        </div>

        <div className="audit-rules">
          {audit.rules.map((rule: RunAuditRule, index) => (
            <div
              key={`${rule.rule_id}-${rule.scope ?? "run"}-${index}`}
              className={`audit-rule${activeRule === `${rule.rule_id}-${index}` ? " audit-rule-active" : ""}`}
              onClick={() => setActiveRule(`${rule.rule_id}-${index}`)}
            >
              <span className="mono">{rule.rule_id}</span>
              <span className={statusClass(rule.status)}>{statusLabel(rule.status)}</span>
              <span className="audit-reason">{rule.reason}</span>
              <span className="audit-evidence">
                {rule.evidence_event_ids.slice(0, 3).map((eventId) => {
                  const visible = layout.positions.has(eventId);
                  return (
                    <button
                      key={eventId}
                      type="button"
                      className="btn btn-quiet audit-evidence-btn"
                      disabled={!visible}
                      title={visible ? "定位到该证据事件" : "该证据位于当前回放/筛选之外"}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectEvidence(eventId);
                      }}
                    >
                      {eventId.slice(0, 8)}
                    </button>
                  );
                })}
                {rule.evidence_event_ids.length > 3 && (
                  <span className="muted small">+{rule.evidence_event_ids.length - 3}</span>
                )}
              </span>
            </div>
          ))}
        </div>

        {audit.handoff.pairs.length > 0 && (
          <p className="muted small">
            交接对：
            {audit.handoff.pairs
              .map((pair) => `${pair.source_role}→${pair.target_role}×${pair.count}`)
              .join("；")}
            {audit.handoff.loops.length > 0 && ` · 回返路径 ${audit.handoff.loops.length} 条`}
          </p>
        )}
        <p className="muted small">
          审计只使用当前可见事件；结果缺失时为 unknown，不推断成功或失败。规则状态是待核验证据，
          不是对流程意图的判断。
        </p>
      </div>
    </div>
  );
}
