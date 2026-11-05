import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { scaleSqrt } from "d3-scale";
import { useWorkspace } from "../state/workspace";
import { useTheme } from "../theme/theme";
import { fetchGraph, type GraphPayload } from "../data/api";

const W = 1000;
const H = 620;
const LAYER_RADIUS = [0, 135, 235, 335];
const TRANSITION_MS = 380;

const TYPE_COLOR_INDEX: Record<string, number> = {
  agent: 1,
  actor: 2,
  person: 2,
  system: 3,
  team: 4,
  department: 5,
  task: 5,
  room: 6,
  channel: 6,
  company: 7,
  world: 7,
  file_path: 8,
  file: 8,
  document: 8,
  document_version: 8,
  unknown: 8,
};

const TYPE_LABEL: Record<string, string> = {
  agent: "智能体",
  actor: "执行者",
  person: "人员",
  system: "系统",
  team: "团队",
  department: "部门",
  task: "任务",
  room: "场所",
  channel: "频道",
  company: "公司",
  world: "外部",
  file_path: "文件",
  file: "文件",
  document: "文档",
  document_version: "文档版本",
  unknown: "未知",
};

interface SimNode extends SimulationNodeDatum {
  id: string;
  label: string;
  entity_type: string;
  degree: number;
  is_center: boolean;
  level: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  relation: string;
  derivation: string;
  evidence_count: number;
  curveOffset: number;
}

interface DrawnLink {
  source: SimNode;
  target: SimNode;
  relation: string;
  derivation: string;
  evidence_count: number;
  curveOffset: number;
}

interface GraphLayout {
  id: number;
  nodes: SimNode[];
  links: DrawnLink[];
  radius: (n: SimNode) => number;
  showLabel: (n: SimNode) => boolean;
  unlinked: number;
}

interface GraphTransform {
  x: number;
  y: number;
  scale: number;
}

function stableAngle(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
}

function edgeKey(edge: DrawnLink): string {
  const a = edge.source.id;
  const b = edge.target.id;
  return `${a < b ? a : b}\u0000${a < b ? b : a}`;
}

function edgePath(edge: DrawnLink): string {
  const sx = edge.source.x ?? W / 2;
  const sy = edge.source.y ?? H / 2;
  const tx = edge.target.x ?? W / 2;
  const ty = edge.target.y ?? H / 2;
  const dx = tx - sx;
  const dy = ty - sy;
  const length = Math.max(1, Math.hypot(dx, dy));
  const cx = (sx + tx) / 2 - (dy / length) * edge.curveOffset;
  const cy = (sy + ty) / 2 + (dx / length) * edge.curveOffset;
  return `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`;
}

function edgeMidpoint(edge: DrawnLink): { x: number; y: number } {
  const sx = edge.source.x ?? W / 2;
  const sy = edge.source.y ?? H / 2;
  const tx = edge.target.x ?? W / 2;
  const ty = edge.target.y ?? H / 2;
  const dx = tx - sx;
  const dy = ty - sy;
  const length = Math.max(1, Math.hypot(dx, dy));
  return {
    x: (sx + tx) / 2 - (dy / length) * edge.curveOffset / 2,
    y: (sy + ty) / 2 + (dx / length) * edge.curveOffset / 2,
  };
}

export function RelationGraph() {
  const { dataset, focusedEntityId, focusEntity } = useWorkspace();
  const { colors } = useTheme();

  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [depth, setDepth] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [leavingLayout, setLeavingLayout] = useState<GraphLayout | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [viewTransform, setViewTransform] = useState<GraphTransform>({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const graphStageRef = useRef<HTMLDivElement>(null);
  const previousLayout = useRef<GraphLayout | null>(null);
  const layoutSequence = useRef(0);
  const panStart = useRef<{ pointerId: number; clientX: number; clientY: number; transform: GraphTransform } | null>(null);

  function buildLayout(data: GraphPayload | null): GraphLayout | null {
    if (!data) return null;
    const nodes: SimNode[] = data.nodes.map((n) => ({
      ...n,
      x: n.is_center
        ? W / 2
        : W / 2 + Math.cos(stableAngle(n.id)) * LAYER_RADIUS[Math.min(n.level, LAYER_RADIUS.length - 1)],
      y: n.is_center
        ? H / 2
        : H / 2 + Math.sin(stableAngle(n.id)) * LAYER_RADIUS[Math.min(n.level, LAYER_RADIUS.length - 1)],
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = data.edges
      .filter((e) => e.source && byId.has(e.source) && byId.has(e.target))
      .map((e) => ({
        source: byId.get(e.source)!,
        target: byId.get(e.target)!,
        relation: e.relation,
        derivation: e.derivation,
        evidence_count: e.evidence_count,
        curveOffset: 0,
      }));

    const parallelEdges = new Map<string, SimLink[]>();
    for (const edge of links) {
      const key = edgeKey(edge as unknown as DrawnLink);
      parallelEdges.set(key, [...(parallelEdges.get(key) ?? []), edge]);
    }
    for (const edges of parallelEdges.values()) {
      edges.sort((a, b) => a.relation.localeCompare(b.relation) || a.derivation.localeCompare(b.derivation));
      edges.forEach((edge, index) => {
        edge.curveOffset = (index - (edges.length - 1) / 2) * 14;
      });
    }

    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((e) => (Math.max((e.source as SimNode).level, (e.target as SimNode).level) > 1 ? 105 : 130))
          .strength(0.7),
      )
      .force("charge", forceManyBody().strength(-320))
      .force("center", forceCenter(W / 2, H / 2))
      .force(
        "radial",
        forceRadial<SimNode>((n) => LAYER_RADIUS[Math.min(n.level, LAYER_RADIUS.length - 1)], W / 2, H / 2)
          .strength(0.8),
      )
      .force("collide", forceCollide<SimNode>().radius((n) => (n.is_center ? 34 : 25)))
      .stop();

    sim.randomSource(() => 0.5);
    for (let i = 0; i < 300; i++) sim.tick();

    const maxDegree = Math.max(1, ...nodes.map((n) => n.degree));
    const radius = scaleSqrt().domain([0, maxDegree]).range([7, 20]);
    const ranked = [...nodes].sort((a, b) => b.degree - a.degree);
    const topIds = new Set(ranked.slice(0, 12).map((n) => n.id));
    const firstLayerCount = nodes.filter((n) => n.level === 1).length;
    return {
      id: ++layoutSequence.current,
      nodes,
      links: links as unknown as DrawnLink[],
      radius: (n: SimNode) => (n.is_center ? Math.max(14, radius(n.degree)) : radius(n.degree)),
      showLabel: (n: SimNode) =>
        n.is_center ||
        (n.level === 1 && firstLayerCount <= 20) ||
        topIds.has(n.id),
      unlinked: data.edges.length - links.length,
    };
  }

  useEffect(() => {
    if (!focusedEntityId) {
      setPayload(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPayload(null);
    fetchGraph(dataset, focusedEntityId, depth)
      .then((data) => {
        if (!cancelled) setPayload(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "读取失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataset, focusedEntityId, depth]);

  useEffect(() => {
    setViewTransform({ x: 0, y: 0, scale: 1 });
  }, [dataset, focusedEntityId]);

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest(".graph-node")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panStart.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      transform: viewTransform,
    };
    setPanning(true);
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>) {
    const start = panStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - start.clientX) * W / Math.max(1, rect.width) / start.transform.scale;
    const dy = (event.clientY - start.clientY) * H / Math.max(1, rect.height) / start.transform.scale;
    setViewTransform({ ...start.transform, x: start.transform.x + dx, y: start.transform.y + dy });
  }

  function endPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (panStart.current?.pointerId !== event.pointerId) return;
    panStart.current = null;
    setPanning(false);
  }

  function zoomGraph(event: WheelEvent) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0012);
    setViewTransform((current) => {
      const scale = Math.max(0.55, Math.min(3.5, current.scale * factor));
      const ratio = scale / current.scale;
      return {
        x: W / 2 - (W / 2 - current.x) * ratio,
        y: H / 2 - (H / 2 - current.y) * ratio,
        scale,
      };
    });
  }

  useEffect(() => {
    const stage = graphStageRef.current;
    if (!stage) return;
    stage.addEventListener("wheel", zoomGraph, { passive: false });
    return () => stage.removeEventListener("wheel", zoomGraph);
  }, [payload]);

  const layout = useMemo(() => buildLayout(payload), [payload]);

  useEffect(() => {
    if (!layout) return;
    const previous = previousLayout.current;
    if (previous && previous !== layout) {
      setLeavingLayout(previous);
      const timer = window.setTimeout(() => setLeavingLayout(null), TRANSITION_MS);
      previousLayout.current = layout;
      return () => window.clearTimeout(timer);
    }
    previousLayout.current = layout;
  }, [layout]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of payload?.nodes ?? []) {
      counts.set(n.entity_type, (counts.get(n.entity_type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [payload]);

  function renderLayer(graphLayout: GraphLayout, className: string, interactive: boolean) {
    const levelOpacity = [1, 0.94, 0.66, 0.42];
    return (
      <g
        key={`layout-${graphLayout.id}`}
        className={className}
        pointerEvents={interactive ? "auto" : "none"}
      >
        <g>
          {graphLayout.links.map((edge, index) => {
            const derived = edge.derivation.startsWith("adapter:");
            const midpoint = edgeMidpoint(edge);
            const edgeId = `${edge.source.id}\u0000${edge.target.id}\u0000${edge.relation}\u0000${edge.derivation}`;
            const active = interactive && hoveredEdge === edgeId;
            const opacity = levelOpacity[Math.min(Math.max(edge.source.level, edge.target.level), 3)];
            return (
              <g
                key={`edge-${index}`}
                className="graph-edge"
                onMouseEnter={interactive ? () => setHoveredEdge(edgeId) : undefined}
                onMouseLeave={interactive ? () => setHoveredEdge(null) : undefined}
                onFocus={interactive ? () => setHoveredEdge(edgeId) : undefined}
                onBlur={interactive ? () => setHoveredEdge(null) : undefined}
                tabIndex={interactive ? 0 : -1}
                aria-label={`${edge.relation}，证据 ${edge.evidence_count} 条`}
              >
                <title>{`${edge.relation} · ${edge.evidence_count} 条证据`}</title>
                <path
                  d={edgePath(edge)}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  pointerEvents="stroke"
                />
                <path
                  d={edgePath(edge)}
                  fill="none"
                  stroke={derived ? colors.warn : colors.textMuted}
                  strokeOpacity={opacity * (active ? 0.9 : 0.48)}
                  strokeWidth={active ? 2.2 : edge.evidence_count > 50 ? 2 : 1}
                  strokeDasharray={derived ? "4 3" : undefined}
                  markerEnd={derived ? "url(#arrow-dashed)" : "url(#arrow-solid)"}
                  pointerEvents="none"
                />
                {active && (
                  <g className="graph-edge-label" pointerEvents="none">
                    <rect
                      x={midpoint.x - Math.min(105, edge.relation.length * 3.2 + 12)}
                      y={midpoint.y - 17}
                      width={Math.min(210, edge.relation.length * 6.4 + 24)}
                      height={22}
                      rx={4}
                      fill={colors.panel}
                      stroke={colors.border}
                    />
                    <text x={midpoint.x} y={midpoint.y - 2} textAnchor="middle" fontSize={10} fill={colors.text}>
                      {edge.relation.length > 28 ? `${edge.relation.slice(0, 27)}…` : edge.relation}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
        <g>
          {graphLayout.nodes.map((node) => {
            const opacity = levelOpacity[Math.min(node.level, 3)];
            const showLabel = graphLayout.showLabel(node) || hoveredNode === node.id;
            return (
              <g
                key={node.id}
                className="graph-node"
                opacity={opacity}
                onClick={interactive ? () => focusEntity(node.id) : undefined}
                onMouseEnter={interactive ? () => setHoveredNode(node.id) : undefined}
                onMouseLeave={interactive ? () => setHoveredNode(null) : undefined}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : -1}
                onKeyDown={interactive ? (event) => {
                  if (event.key === "Enter" || event.key === " ") focusEntity(node.id);
                } : undefined}
              >
                <title>{`${node.label}\n${TYPE_LABEL[node.entity_type] ?? node.entity_type} · ${node.level} 跳 · 度数 ${node.degree}`}</title>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={graphLayout.radius(node)}
                  fill={colors.categories[(TYPE_COLOR_INDEX[node.entity_type] ?? 8) - 1]}
                  fillOpacity={node.is_center ? 0.95 : 0.8}
                  stroke={node.is_center ? colors.accent : colors.panel}
                  strokeWidth={node.is_center ? 3 : 1.5}
                />
                {showLabel && (node.is_center ? (
                  <text
                    x={node.x}
                    y={(node.y ?? 0) - graphLayout.radius(node) - 8}
                    fontSize={11}
                    fontWeight={600}
                    fill={colors.text}
                    textAnchor="middle"
                    pointerEvents="none"
                  >
                    {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
                  </text>
                ) : (
                  <text
                    x={(node.x ?? 0) + ((node.x ?? 0) >= W / 2 ? 1 : -1) * (graphLayout.radius(node) + 5)}
                    y={(node.y ?? 0) + 3.5}
                    fontSize={10}
                    fill={colors.textMuted}
                    textAnchor={(node.x ?? 0) >= W / 2 ? "start" : "end"}
                    pointerEvents="none"
                  >
                    {node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}
                  </text>
                ))}
              </g>
            );
          })}
        </g>
      </g>
    );
  }

  if (!focusedEntityId) {
    return (
      <div className="empty-state">
        <h2>还没有聚焦实体</h2>
        <p>
          在证据侧栏的「关联」页点击任一参与者，或在时间线上选中一条事件——
          选中后会自动聚焦该事件的 actor。
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h2>关系图读取失败</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!payload || !layout) {
    return <div className="empty-state"><p className="muted">正在构建子图…</p></div>;
  }

  if (payload.nodes.length === 0 || layout.nodes.length === 0) {
    return (
      <div className="empty-state">
        <h2>这个实体没有可绘制的关系</h2>
        <p>聚焦实体 <code>{payload.center}</code> 没有返回关系节点。可以在证据侧栏选择其他参与者后继续调查。</p>
      </div>
    );
  }

  return (
    <div className="graph">
      <div className="graph-head">
        <div>
          <h2>聚焦关系图</h2>
          <p className="muted small">
            以 <code>{payload.center}</code> 为中心 · {payload.nodes.length} 个节点 ·{" "}
            {payload.edges.length} 条边
            {loading && " · 更新中…"}
          </p>
        </div>
        <div className="graph-tools">
          <div className="seg">
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                type="button"
                className={`seg-item${depth === d ? " seg-active" : ""}`}
                onClick={() => setDepth(d)}
                aria-pressed={depth === d}
              >
                {d} 跳
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-quiet" onClick={() => setViewTransform({ x: 0, y: 0, scale: 1 })} title="重置关系图缩放与位置">
            重置视图
          </button>
        </div>
      </div>

      {payload.truncated && (
        <div className="callout callout-warn">
          <strong>已裁剪</strong>
          <p>
            节点上限 {payload.node_limit}。当前子图只包含被保留的部分，
            不能据此断言「没有其它关联」。
          </p>
        </div>
      )}

      <div
        ref={graphStageRef}
        className={`graph-stage${panning ? " graph-panning" : ""}`}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="实体关系子图"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <marker
              id="arrow-solid"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.textMuted} />
            </marker>
            <marker
              id="arrow-dashed"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.warn} />
            </marker>
          </defs>

          <g transform={`translate(${viewTransform.x} ${viewTransform.y}) scale(${viewTransform.scale})`}>
          {[1, 2, 3].filter((level) => level <= payload.depth).map((level) => (
            <g key={`ring-${level}`}>
              <circle
                cx={W / 2}
                cy={H / 2}
                r={LAYER_RADIUS[level]}
                fill="none"
                stroke={colors.border}
                strokeOpacity={0.48}
                strokeDasharray="2 6"
              />
              <text
                x={W / 2 + 7}
                y={H / 2 - LAYER_RADIUS[level] + 14}
                fontSize={9}
                fill={colors.textFaint}
              >
                {level} 跳
              </text>
            </g>
          ))}

          {leavingLayout && renderLayer(leavingLayout, "graph-layout-leave", false)}
          {renderLayer(layout, "graph-layout-enter", true)}
          </g>
        </svg>
      </div>

      <div className="graph-legend">
        {[0, 1, 2, 3].filter((level) => level <= payload.depth).map((level) => (
          <span key={`level-${level}`} className="legend-item">
            <span className={`level-swatch level-${level}`} />
            {level === 0 ? "中心" : `${level} 跳`}
            {` ${payload.nodes.filter((node) => node.level === level).length}`}
          </span>
        ))}
        {typeCounts.map(([type, count]) => (
          <span key={type} className="legend-item">
            <span
              className="swatch"
              style={{ background: colors.categories[(TYPE_COLOR_INDEX[type] ?? 8) - 1] }}
            />
            {TYPE_LABEL[type] ?? type} {count}
          </span>
        ))}
        <span className="legend-item legend-off">虚线 = adapter 派生边</span>
      </div>

      {layout.unlinked > 0 && (
        <p className="muted small">
          {layout.unlinked} 条关系的源事件缺少 actor，无法定位起点，未绘制。
        </p>
      )}
      <p className="muted small">
        边表示同一事件记录中的参与关系，不代表因果。点击节点可把该实体设为新的中心。
      </p>
    </div>
  );
}
