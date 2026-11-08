import { useMemo } from "react";
import type { Mc1ReplyEdge, Mc1ReplyNetworkPayload } from "../../data/api";

const W = 760;
const H = 430;
const CENTER = { x: W / 2, y: H / 2 + 6 };
const RADIUS = 148;

export function edgeKey(edge: Mc1ReplyEdge): string {
  return `${edge.source}>${edge.target}|${edge.kind}|${edge.reply_class}`;
}

const EDGE_STYLE: Record<string, { label: string; className: string }> = {
  reply_valid: { label: "有效回复", className: "mc1-edge-reply" },
  reply_future_reference: { label: "未来引用", className: "mc1-edge-future" },
  mention: { label: "点名提及", className: "mc1-edge-mention" },
};

/** 7 个角色的完整名较长，图上只显示角色短名（悬停仍有完整名）。 */
export function shortAgentLabel(label: string): string {
  return label.replace(/\s*-?\s*agent$/i, "").replace(/_/g, " ") || label;
}

export function edgeStyle(edge: Mc1ReplyEdge) {
  return EDGE_STYLE[edge.kind === "mention" ? "mention" : edge.reply_class] ?? {
    label: edge.reply_class || "回复",
    className: "mc1-edge-reply",
  };
}

/**
 * agent 级回复/点名称网络：边来自 /api/mc1/reply-network 的真实聚合，
 * 点击边读取该聚合边的原始消息；点击节点读取该角色在当前筛选下的消息。
 */
export function Mc1Network({
  payload,
  loading,
  error,
  selectedEdgeKey,
  selectedNodeId,
  onSelectEdge,
  onSelectNode,
}: {
  payload: Mc1ReplyNetworkPayload | null;
  loading: boolean;
  error: string | null;
  selectedEdgeKey: string | null;
  selectedNodeId: string | null;
  onSelectEdge: (edge: Mc1ReplyEdge, trigger: Element | null) => void;
  onSelectNode: (id: string, trigger: Element | null) => void;
}) {
  const layout = useMemo(() => {
    const nodes = payload?.nodes ?? [];
    const positions = new Map<string, { x: number; y: number }>();
    nodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(1, nodes.length);
      positions.set(node.id, {
        x: CENTER.x + Math.cos(angle) * RADIUS,
        y: CENTER.y + Math.sin(angle) * RADIUS,
      });
    });
    return positions;
  }, [payload]);

  const maxMessages = useMemo(
    () => Math.max(1, ...(payload?.nodes ?? []).map((node) => node.messages)),
    [payload],
  );

  const drawnEdges = useMemo(() => {
    const edges = payload?.edges ?? [];
    const groups = new Map<string, Mc1ReplyEdge[]>();
    for (const edge of edges) {
      const pair = `${edge.source}>${edge.target}`;
      const list = groups.get(pair) ?? [];
      list.push(edge);
      groups.set(pair, list);
    }
    return edges.map((edge) => {
      const pair = `${edge.source}>${edge.target}`;
      const siblings = groups.get(pair) ?? [];
      const index = siblings.indexOf(edge);
      const offset = siblings.length > 1 ? (index - (siblings.length - 1) / 2) * 26 : 0;
      return { edge, offset };
    });
  }, [payload]);

  if (error) {
    return (
      <div className="callout callout-warn">
        <strong>回复网络不可用</strong>
        <p className="muted small">{error}</p>
      </div>
    );
  }

  const nodes = payload?.nodes ?? [];

  return (
    <div className="mc1-net">
      {loading && !payload && <p className="muted small">正在聚合回复网络…</p>}
      {payload && (
        <>
          <svg
            className="mc1-net-svg"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label="MC1 角色回复与点名网络"
          >
            <defs>
              {Object.entries(EDGE_STYLE).map(([key, style]) => (
                <marker
                  key={key}
                  id={`mc1-arrow-${key}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className={`mc1-arrow ${style.className}`} />
                </marker>
              ))}
            </defs>

            {drawnEdges.map(({ edge, offset }) => {
              const from = layout.get(edge.source);
              const to = layout.get(edge.target);
              if (!from || !to) return null;
              const style = edgeStyle(edge);
              const key = edgeKey(edge);
              const isSelf = edge.source === edge.target;
              let d: string;
              let labelX: number;
              let labelY: number;
              if (isSelf) {
                const reach = 52 + Math.abs(offset) * 0.4;
                d = `M ${from.x - 12} ${from.y - 12} C ${from.x - reach} ${from.y - 110}, ${from.x + reach} ${from.y - 110}, ${from.x + 12} ${from.y - 12}`;
                labelX = from.x;
                labelY = from.y - 96;
              } else {
                const mx = (from.x + to.x) / 2;
                const my = (from.y + to.y) / 2;
                const dx = to.x - from.x;
                const dy = to.y - from.y;
                const length = Math.max(1, Math.hypot(dx, dy));
                const nx = -dy / length;
                const ny = dx / length;
                const cx = mx + nx * (28 + offset);
                const cy = my + ny * (28 + offset);
                d = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
                labelX = cx;
                labelY = cy;
              }
              const width = 1.4 + Math.sqrt(edge.evidence_count) * 0.55;
              return (
                <g key={key} className={`mc1-edge ${style.className}${selectedEdgeKey === key ? " is-selected" : ""}`}>
                  <path d={d} className="mc1-edge-line" strokeWidth={width} markerEnd={`url(#mc1-arrow-${edge.kind === "mention" ? "mention" : edge.reply_class})`} />
                  <path
                    d={d}
                    className="mc1-edge-hit"
                    tabIndex={0}
                    role="button"
                    aria-label={`${style.label}：${edge.source} → ${edge.target}，${edge.evidence_count} 条消息`}
                    onClick={(event) => onSelectEdge(edge, event.currentTarget)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectEdge(edge, event.currentTarget);
                      }
                    }}
                  >
                    <title>
                      {`${style.label} · ${edge.source.split(":").pop()} → ${edge.target.split(":").pop()} · ${edge.evidence_count} 条`}
                    </title>
                  </path>
                  {edge.evidence_count >= 30 || selectedEdgeKey === key ? (
                    <text x={labelX} y={labelY} className="mc1-edge-label" textAnchor="middle">
                      {edge.evidence_count}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {nodes.map((node) => {
              const pos = layout.get(node.id);
              if (!pos) return null;
              const r = 15 + Math.sqrt(node.messages / maxMessages) * 17;
              return (
                <g
                  key={node.id}
                  className={`mc1-node${selectedNodeId === node.id ? " is-selected" : ""}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${node.label}：${node.messages} 条消息，回复出 ${node.reply_out} 入 ${node.reply_in}`}
                  onClick={(event) => onSelectNode(node.id, event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectNode(node.id, event.currentTarget);
                    }
                  }}
                >
                  <circle cx={pos.x} cy={pos.y} r={r} />
                  <text x={pos.x} y={pos.y + r + 14} textAnchor="middle" className="mc1-node-label">
                    {shortAgentLabel(node.label)}
                  </text>
                  <text x={pos.x} y={pos.y + 4} textAnchor="middle" className="mc1-node-count">
                    {node.messages}
                  </text>
                  <title>
                    {`${node.label} · 消息 ${node.messages}（含内部审议 ${node.with_deliberation}）· 回复出/入 ${node.reply_out}/${node.reply_in} · 点名出/入 ${node.mention_out}/${node.mention_in}`}
                  </title>
                </g>
              );
            })}
          </svg>

          <div className="mc1-net-legend">
            <span className="mc1-edge-key mc1-edge-reply">有效回复 reply_valid</span>
            <span className="mc1-edge-key mc1-edge-future">未来引用 reply_future_reference</span>
            <span className="mc1-edge-key mc1-edge-mention">点名提及 mention</span>
            <span className="muted small">节点面积=筛选后消息数；边宽=去重事件数</span>
            <span className="muted small">
              {payload.counts.reply_edges} 条回复边（有效 {payload.counts.by_reply_class.reply_valid ?? 0} ·
              未来 {payload.counts.by_reply_class.reply_future_reference ?? 0}）· {payload.counts.mention_edges} 条点名边
            </span>
          </div>
          <details className="mc1-net-notes">
            <summary>口径与限制</summary>
            <ul className="tight-list muted small">
              {payload.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
