import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { useTheme } from "../../theme/theme";
import {
  fetchTrace,
  fetchTraceRoots,
  formatUtc,
  type TraceEdge,
  type TraceNode,
  type TracePayload,
  type TraceRootItem,
} from "../../data/api";
import { filterKey } from "../../data/filterContext";
import { FileTrack } from "./FileTrack";
import { PatternCompare } from "./PatternCompare";
import { InterventionPanel } from "./InterventionPanel";

type TraceMode = "chain" | "patterns" | "intervention";

const MODES: { key: TraceMode; label: string }[] = [
  { key: "chain", label: "目标链" },
  { key: "patterns", label: "历史实例" },
  { key: "intervention", label: "干预论证" },
];

const W = 1000;
const H = 190;
const LEFT = 92;
const RIGHT = 24;

const LANES: { key: string; label: string }[] = [
  { key: "root", label: "发布事件" },
  { key: "file_operation", label: "文件操作" },
  { key: "candidate_file", label: "候选文件" },
];

const PROVENANCE_TEXT: Record<string, string> = {
  recorded: "记录",
  derived: "规范化",
  candidate: "候选",
  analyst: "人工",
};

/** MC2 来源链：post → 内容文件 → 文件操作，候选层单独标注。 */
export function SourceTrace() {
  const { dataset, filters, cursor, masking, selectedEventId, selectEvent, traceRootId, traceFileId, openTrace } =
    useWorkspace();
  const { colors } = useTheme();
  const [roots, setRoots] = useState<TraceRootItem[]>([]);
  const [payload, setPayload] = useState<TracePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<TraceMode>("chain");

  const rootId = traceRootId ?? selectedEventId;

  useEffect(() => {
    const controller = new AbortController();
    fetchTraceRoots(controller.signal)
      .then((data) => setRoots(data.items))
      .catch(() => setRoots([]));
    return () => controller.abort();
  }, []);

  const key = filterKey(filters, {
    root: rootId,
    cursor_us: masking ? cursor : undefined,
    masking,
  });

  useEffect(() => {
    if (!rootId) {
      setPayload(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchTrace({ rootEventId: rootId, filters, cursorUs: masking ? cursor : null, masking }, controller.signal)
      .then((data) => setPayload(data))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : "来源链加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // filters 通过 key 参与依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rootId]);

  const layout = useMemo(() => {
    if (!payload) return null;
    const eventNodes = payload.nodes.filter((node) => node.kind === "event" && node.time_us != null);
    const times = [
      ...eventNodes.map((node) => node.time_us as number),
      ...payload.files.flatMap((file) => [file.first_us, file.last_us].filter((v): v is number => v != null)),
    ];
    if (times.length === 0) return null;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const span = Math.max(1, max - min);
    const xOf = (us: number) => LEFT + ((us - min) / span) * (W - LEFT - RIGHT);
    const laneOf = (node: TraceNode) => {
      if (node.role === "root") return 0;
      if (node.role === "file_operation") return 1;
      return 2;
    };
    const laneY = (lane: number) => 54 + lane * 44;
    return { min, max, xOf, laneOf, laneY, eventNodes };
  }, [payload]);

  if (dataset !== "MC2") {
    return <div className="empty-state"><p className="muted">来源链只适用于 MC2。</p></div>;
  }

  const fileEdgeFor = (node: TraceNode): TraceEdge | undefined =>
    payload?.edges.find((edge) => edge.targetId === node.id && edge.provenanceKind === "recorded");

  return (
    <div className="trace-view">
      <div className="canvas-subbar">
        <div className="seg" role="tablist" aria-label="来源链子模式">
          {MODES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`seg-item${mode === item.key ? " seg-active" : ""}`}
              onClick={() => setMode(item.key)}
              aria-pressed={mode === item.key}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {mode === "patterns" && <PatternCompare />}
      {mode === "intervention" && <InterventionPanel />}

      {mode === "chain" && (
        <>
      <div className="canvas-subbar trace-roots">
        <div className="seg">
          {roots.map((item) => (
            <button
              key={item.event_id}
              type="button"
              className={`seg-item${rootId === item.event_id ? " seg-active" : ""}`}
              onClick={() => openTrace({ rootEventId: item.event_id, fileId: item.file_id })}
              title={`${item.event_id} · ${formatUtc(item.time_us)}`}
            >
              {item.file_path ?? item.event_id}
            </button>
          ))}
        </div>
        <span className="muted small">
          链根来自日志明确记录的 post_content_source；选中事件流中的任意事件也可作为根。
        </span>
      </div>

      {!rootId && (
        <div className="empty-state">
          <p className="muted">先在事件流中选择一条事件，或点击上面的链根。</p>
        </div>
      )}

      {error && (
        <div className="callout callout-warn">
          <strong>{error.includes("root_after_cursor") ? "根事件晚于回放游标" : "来源链不可用"}</strong>
          <p className="muted small">
            {error.includes("root_after_cursor")
              ? "关闭回放遮蔽，或把游标移到该事件之后再看来源链。"
              : error}
          </p>
        </div>
      )}

      {loading && !payload && <p className="muted small">正在读取来源链…</p>}

      {payload && layout && (
        <>
          <div className="trace-head">
            <span className="mono">{payload.root_event_id}</span>
            <span className="muted small">
              记录边 {payload.recorded_edge_count} · 候选边 {payload.candidate_edge_count} · 文件操作上限{" "}
              {payload.budget.events}（已用 {payload.budget.used}）
            </span>
            {payload.budget.truncated && (
              <span className="tag tag-warn">已裁剪：{payload.budget.reasons.join("、")}</span>
            )}
            {payload.unresolved.count > 0 && (
              <span className="tag tag-warn">{payload.unresolved.count} 个引用未解析</span>
            )}
          </div>

          <svg className="trace-lanes" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="来源链时间轴">
            <line x1={LEFT} y1={H - 26} x2={W - RIGHT} y2={H - 26} stroke={colors.grid} />
            {[0, 1, 2, 3, 4].map((index) => {
              const us = layout.min + ((layout.max - layout.min) * index) / 4;
              const x = layout.xOf(us);
              return (
                <g key={index}>
                  <line x1={x} y1={20} x2={x} y2={H - 26} stroke={colors.grid} strokeDasharray="2 4" opacity={0.6} />
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
                <line
                  x1={LEFT}
                  y1={layout.laneY(index)}
                  x2={W - RIGHT}
                  y2={layout.laneY(index)}
                  stroke={colors.grid}
                  opacity={0.4}
                />
              </g>
            ))}

            {payload.files.map((file) => {
              const us = file.first_us ?? layout.min;
              const x = layout.xOf(us);
              return (
                <g key={file.file_id}>
                  <line
                    x1={x}
                    y1={26}
                    x2={x}
                    y2={H - 26}
                    stroke={colors.accent}
                    strokeWidth={1.5}
                    opacity={0.5}
                  />
                  <text x={x + 4} y={34} fontSize={10} fill={colors.accent}>
                    {file.path}
                  </text>
                </g>
              );
            })}

            {payload.candidates.map((candidate) => {
              const node = payload.nodes.find((item) => item.id === candidate.file_id);
              if (!node) return null;
              const us = layout.min + (layout.max - layout.min) * 0.98;
              const x = layout.xOf(us);
              return (
                <g key={candidate.file_id}>
                  <circle
                    cx={x}
                    cy={layout.laneY(2)}
                    r={6}
                    fill="none"
                    stroke={colors.warn}
                    strokeDasharray="3 3"
                  />
                  <text x={x - 8} y={layout.laneY(2) - 8} textAnchor="end" fontSize={10} fill={colors.warn}>
                    {candidate.path}（{candidate.relay_event_count} 次接力）
                  </text>
                </g>
              );
            })}

            {layout.eventNodes.map((node) => {
              const x = layout.xOf(node.time_us as number);
              const lane = layout.laneOf(node);
              const isRoot = node.role === "root";
              return (
                <g key={node.id}>
                  {!isRoot && (
                    <line
                      x1={layout.xOf(
                        payload.files.find((file) => file.first_us != null && file.first_us <= (node.time_us as number))
                          ?.first_us ?? (node.time_us as number),
                      )}
                      y1={layout.laneY(0) + 6}
                      x2={x}
                      y2={layout.laneY(lane) - 6}
                      stroke={colors.border}
                      strokeWidth={1}
                    />
                  )}
                  <circle
                    cx={x}
                    cy={layout.laneY(lane)}
                    r={isRoot ? 7 : 5}
                    fill={isRoot ? colors.accent : colors.textMuted}
                    stroke={isRoot ? colors.accent : "none"}
                  />
                  <text x={x} y={layout.laneY(lane) - 10} textAnchor="middle" fontSize={10} fill={colors.textMuted}>
                    {node.event_type}
                  </text>
                </g>
              );
            })}
          </svg>

          <div className="trace-body">
            <div className="trace-chain">
              <h3>记录层</h3>
              <ul className="trace-list">
                {payload.nodes
                  .filter((node) => node.kind === "event" && node.role !== "root")
                  .map((node) => {
                    const edge = fileEdgeFor(node);
                    return (
                      <li key={node.id}>
                        <button
                          type="button"
                          className="trace-item"
                          onClick={() => selectEvent(node.event_id ?? null, node.time_us ?? null)}
                        >
                          <span className="mono small">{formatUtc(node.time_us ?? 0)}</span>
                          <span className="stream-type">{node.event_type}</span>
                          <span className="mono small">{node.actor_label ?? node.actor_id ?? "—"}</span>
                          <span className="muted small">{node.preview || "（无摘要）"}</span>
                          {edge && (
                            <span className="role-chip">
                              {edge.relation} · {PROVENANCE_TEXT[edge.provenanceKind]}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
              </ul>
              {payload.nodes.filter((node) => node.kind === "event" && node.role !== "root").length === 0 && (
                <p className="muted small">当前窗口内没有该文件的操作记录。</p>
              )}

              <h3>候选层</h3>
              {payload.candidates.length === 0 ? (
                <p className="muted small">没有同名前缀候选。</p>
              ) : (
                <>
                  <p className="muted small">
                    候选只表示文件名前缀相同，日志没有记录这些文件被转交给发布者；不能据此认定传播。
                  </p>
                  <ul className="trace-list">
                    {payload.candidates.map((candidate) => (
                      <li key={candidate.file_id}>
                        <button
                          type="button"
                          className="trace-item"
                          onClick={() => openTrace({ fileId: candidate.file_id })}
                        >
                          <span className="tag tag-warn">候选 · shared_prefix_hint</span>
                          <span className="mono small">{candidate.path}</span>
                          <span className="muted small">{candidate.relay_event_count} 次排队转交记录</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <h3>内容可用性</h3>
              {payload.files.map((file) => (
                <div key={file.file_id} className="callout">
                  <strong className="mono">{file.path}</strong>
                  <p className="muted small">
                    状态 <code>{file.content_status}</code> · {file.reason}
                  </p>
                  <p className="muted small">
                    可支持：{file.supports.join("；")}。
                  </p>
                  <p className="muted small">
                    不能支持：{file.cannot_support.join("；")}。
                  </p>
                  <button type="button" className="btn" onClick={() => openTrace({ fileId: file.file_id })}>
                    查看文件轨迹
                  </button>
                </div>
              ))}
            </div>

            <div className="trace-file">
              {traceFileId ? (
                <FileTrack fileId={traceFileId} onPickRoot={(eventId) => openTrace({ rootEventId: eventId })} />
              ) : (
                <p className="muted small">
                  点击左侧文件的「查看文件轨迹」，或在图上选择文件，可查看该文件的全部操作事件。
                </p>
              )}
            </div>
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
}
