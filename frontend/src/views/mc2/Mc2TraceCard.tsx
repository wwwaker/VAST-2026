import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { useTheme } from "../../theme/theme";
import {
  fetchTrace,
  formatUtc,
  type TraceEdge,
  type TraceNode,
  type TracePayload,
  type TraceRootItem,
} from "../../data/api";
import { filterKey } from "../../data/filterContext";

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

/** 靠右的文字改用 end 对齐，避免末端标签被画布裁掉。 */
function anchorOf(x: number, width = W - RIGHT): "start" | "end" | "middle" {
  if (x > width - 150) return "end";
  if (x < LEFT + 6) return "start";
  return "middle";
}

/**
 * 目标来源链卡片：post → 内容文件 → 文件操作，候选层单独标注。
 * 本卡片不做 mode 切换；链根由共享 traceObject 承接，点事件/文件落到页面的唯一阅读面板。
 */
export function Mc2TraceCard({
  roots,
  onOpenEvent,
  onOpenFile,
  activeFileId,
  missingIds,
  onSummary,
}: {
  /** 链根候选由页面统一读取（同时用于默认目标帖与顶部定位动作） */
  roots: TraceRootItem[];
  /** trigger 用于关闭阅读面板后把焦点还给触发控件 */
  onOpenEvent: (eventId: string, timeUs: number | null, trigger?: Element | null) => void;
  onOpenFile: (fileId: string, path: string, candidate?: boolean, trigger?: Element | null) => void;
  activeFileId: string | null;
  /** 恢复快照时判定缺失的引用：已知缺失的根不再发请求，也不伪造链图 */
  missingIds: readonly string[];
  /** 把当前链根/记录文件/候选文件交给页面，用于恢复后的文件身份判断；链清空时传 null */
  onSummary?: (summary: { rootId: string | null; recorded: string[]; candidates: string[] } | null) => void;
}) {
  const { filters, cursor, masking, traceRootId, openTrace } = useWorkspace();
  const { colors } = useTheme();
  const [payload, setPayload] = useState<TracePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);

  const rootId = traceRootId;

  const key = filterKey(filters, {
    root: rootId,
    cursor_us: masking ? cursor : undefined,
    masking,
  });

  // 游标在链根之前时直接按同一条件说明，不反复请求 409（根事件本身还不可见）
  const rootTimeUs = roots.find((item) => item.event_id === rootId)?.time_us ?? null;
  const rootAfterCursor = masking && cursor != null && rootTimeUs != null && rootTimeUs > cursor;
  // 恢复时会带上缺失引用：已知缺失的根不再请求（否则必然 404），保留原 ID 与说明
  const rootMissing = rootId != null && missingIds.includes(rootId);

  useEffect(() => {
    if (!rootId) {
      setPayload(null);
      return;
    }
    if (rootMissing) {
      setPayload(null);
      setLoading(false);
      setError("root_missing_reference");
      return;
    }
    if (rootAfterCursor) {
      setPayload(null);
      setLoading(false);
      setError("root_after_cursor");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPayload(null);
    fetchTrace({ rootEventId: rootId, filters, cursorUs: masking ? cursor : null, masking }, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setPayload(data);
      })
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
  }, [key, rootId, rootAfterCursor, rootMissing, retry]);

  // 把当前链的真实文件身份交给页面：恢复后的候选/记录判断以链结果为准，不看页面局部标记。
  // 链清空（换根/加载/失败）时同步清空，避免旧根的文件身份留在新根上。
  useEffect(() => {
    if (!onSummary) return;
    if (!payload) {
      onSummary(null);
      return;
    }
    onSummary({
      rootId: payload.root_event_id,
      recorded: payload.files.map((file) => file.file_id),
      candidates: payload.candidates.map((candidate) => candidate.file_id),
    });
  }, [payload, onSummary]);

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

  const fileEdgeFor = (node: TraceNode): TraceEdge | undefined =>
    payload?.edges.find((edge) => edge.targetId === node.id && edge.provenanceKind === "recorded");

  const rootNode = payload?.nodes.find((node) => node.role === "root") ?? null;
  const activeFile = payload?.files.find((file) => file.file_id === activeFileId) ?? null;

  return (
    <section className="mc2-card" aria-label="目标来源链" data-testid="mc2-trace-card">
      <header className="mc2-card-head">
        <h2>目标来源链</h2>
        <p className="muted small">
          链根来自日志明确记录的 <code>post_content_source</code>；点事件或文件在右侧阅读面板核查原始记录。
          更换链根是显式动作，普通点击不会改写全局筛选。
        </p>
      </header>

      <div className="trace-roots" aria-label="链根">
        <div className="seg">
          {roots.map((item) => (
            <button
              key={item.event_id}
              type="button"
              className={`seg-item${rootId === item.event_id ? " seg-active" : ""}`}
              aria-pressed={rootId === item.event_id}
              onClick={() => openTrace({ rootEventId: item.event_id, fileId: item.file_id })}
              title={`${item.event_id} · ${formatUtc(item.time_us)}`}
            >
              {item.file_path ?? item.event_id}
            </button>
          ))}
        </div>
        <span className="muted small">
          {rootId ? `当前链根 ${rootId}` : "尚未选择链根"}
        </span>
      </div>

      {!rootId && (
        <div className="empty-state">
          <p className="muted">点击上面的链根，或对事件使用“追踪来源”动作。</p>
        </div>
      )}

      {error && (
        <div className="callout callout-warn" role="status" data-testid="mc2-trace-error">
          <strong>
            {error.includes("root_missing_reference")
              ? "链根引用在日志中缺失"
              : error.includes("root_after_cursor")
                ? "根事件晚于回放游标"
                : error.includes("root_outside_window")
                  ? "根事件早于当前观察窗口"
                  : "来源链不可用"}
          </strong>
          <p className="muted small">
            {error.includes("root_missing_reference")
              ? `快照保存的链根 ${rootId} 在日志里找不到。原引用保留在快照中，这里不替换成其它事件，也不再请求已缺失的对象。`
              : error.includes("root_after_cursor")
                ? "关闭回放遮蔽，或把游标移到该事件之后再看来源链。"
                : error.includes("root_outside_window")
                  ? "当前时间窗不包含链根，来源链按窗口过滤文件操作；把窗口调到包含该事件，或清除时间窗。"
                  : error.includes("Failed to fetch")
                    ? "请求没有到达服务：确认本地 API 在运行，然后重试。"
                    : error}
          </p>
          {!error.includes("root_missing_reference") && (
            <button type="button" className="btn btn-quiet" onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          )}
        </div>
      )}

      {loading && !payload && <p className="muted small">正在读取来源链…</p>}

      {payload && layout && (
        <>
          <div className="trace-head">
            {rootNode ? (
              <button
                type="button"
                className="mc2-root-event mono"
                title="打开目标帖原始记录"
                onClick={(event) => onOpenEvent(rootNode.event_id as string, rootNode.time_us ?? null, event.currentTarget)}
              >
                {payload.root_event_id}
              </button>
            ) : (
              <span className="mono">{payload.root_event_id}</span>
            )}
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
            {activeFile && (
              <button type="button" className="btn btn-quiet" onClick={(event) => onOpenFile(activeFile.file_id, activeFile.path, false, event.currentTarget)}>
                重新打开 {activeFile.path} 轨迹
              </button>
            )}
          </div>

          <div className="mc2-lanes-wrap">
          <svg className="trace-lanes" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="来源链时间轴">
            <line x1={LEFT} y1={H - 26} x2={W - RIGHT} y2={H - 26} stroke={colors.grid} />
            {[0, 1, 2, 3, 4].map((index) => {
              const us = layout.min + ((layout.max - layout.min) * index) / 4;
              const x = layout.xOf(us);
              return (
                <g key={index}>
                  <line x1={x} y1={20} x2={x} y2={H - 26} stroke={colors.grid} strokeDasharray="2 4" opacity={0.6} />
                  <text
                    x={x}
                    y={H - 10}
                    textAnchor={index === 4 ? "end" : index === 0 ? "start" : "middle"}
                    fontSize={10}
                    fill={colors.textMuted}
                  >
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
              const anchor = anchorOf(x + 4);
              return (
                <g
                  key={file.file_id}
                  className="mc2-svg-hit"
                  role="button"
                  tabIndex={0}
                  aria-label={`查看文件 ${file.path} 的操作轨迹`}
                  onClick={(event) => onOpenFile(file.file_id, file.path, false, event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenFile(file.file_id, file.path, false, event.currentTarget);
                    }
                  }}
                >
                  <line
                    x1={x}
                    y1={26}
                    x2={x}
                    y2={H - 26}
                    stroke={colors.accent}
                    strokeWidth={1.5}
                    opacity={0.5}
                  />
                  <text
                    x={anchor === "end" ? x - 4 : x + 4}
                    y={34}
                    textAnchor={anchor}
                    fontSize={10}
                    fill={colors.accent}
                  >
                    {file.path}
                  </text>
                  {/* 扩大命中区，文件标签本身只有 10px 高 */}
                  <rect x={x - 8} y={22} width={16} height={H - 50} fill="transparent" />
                </g>
              );
            })}

            {payload.candidates.map((candidate) => {
              const node = payload.nodes.find((item) => item.id === candidate.file_id);
              if (!node) return null;
              const us = layout.min + (layout.max - layout.min) * 0.98;
              const x = layout.xOf(us);
              return (
                <g
                  key={candidate.file_id}
                  className="mc2-svg-hit"
                  role="button"
                  tabIndex={0}
                  aria-label={`查看候选文件 ${candidate.path}`}
                  onClick={(event) => onOpenFile(candidate.file_id, candidate.path, true, event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenFile(candidate.file_id, candidate.path, true, event.currentTarget);
                    }
                  }}
                >
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
              const labelAnchor = anchorOf(x);
              return (
                <g
                  key={node.id}
                  className="mc2-svg-hit"
                  role="button"
                  tabIndex={0}
                  aria-label={`查看事件 ${node.event_id} 的原始记录`}
                  onClick={(event) => onOpenEvent(node.event_id as string, node.time_us ?? null, event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenEvent(node.event_id as string, node.time_us ?? null, event.currentTarget);
                    }
                  }}
                >
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
                  <text
                    x={labelAnchor === "end" ? x - 8 : labelAnchor === "start" ? x + 8 : x}
                    y={layout.laneY(lane) - 10}
                    textAnchor={labelAnchor}
                    fontSize={10}
                    fill={colors.textMuted}
                  >
                    {node.event_type}
                  </text>
                </g>
              );
            })}
          </svg>
          </div>

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
                          onClick={(event) => onOpenEvent(node.event_id as string, node.time_us ?? null, event.currentTarget)}
                          title="打开该事件的原始记录"
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
                <p className="muted small">
                  {masking && cursor != null
                    ? `当前窗口内没有可见的文件操作：回放游标（${formatUtc(cursor)}）之后的事件被遮蔽。空集不等于“没有发生过”。`
                    : "当前窗口内没有该文件的操作记录（空集，不是“没有发生过”）。"}
                </p>
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
                          onClick={(event) => onOpenFile(candidate.file_id, candidate.path, true, event.currentTarget)}
                          title="查看该候选文件的操作轨迹"
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

            </div>

            <div className="trace-chain">
              <h3>内容可用性</h3>
              {payload.files.map((file) => (
                <div key={file.file_id} className="callout">
                  <strong className="mono">{file.path}</strong>
                  <p className="muted small">
                    状态 <code>{file.content_status}</code> · {file.reason}
                  </p>
                  {file.content_status !== "available" && (
                    <p className="muted small">
                      事件载荷与文件实体都没有正文文本；这里只呈现文件名、元数据与操作记录，不生成推测内容。
                    </p>
                  )}
                  <p className="muted small">可支持：{file.supports.join("；")}。</p>
                  <p className="muted small">不能支持：{file.cannot_support.join("；")}。</p>
                  <button type="button" className="btn" onClick={(event) => onOpenFile(file.file_id, file.path, false, event.currentTarget)}>
                    查看文件轨迹
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
