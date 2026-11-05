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
import {
  fetchGraph,
  fetchGraphEvidence,
  formatUtc,
  type EventItem,
  type GraphEdge,
  type GraphPayload,
  type GraphNode,
} from "../data/api";

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

const REASON_LABEL: Record<string, string> = {
  seed_per_hop: "每跳只扩展有限个种子",
  edges_per_seed: "每个种子只保留有限条边",
  node_limit: "节点达到上限",
  edge_limit: "边达到上限",
};

interface SimNode extends SimulationNodeDatum, GraphNode {}

interface SimLink extends SimulationLinkDatum<SimNode> {
  relation: string;
  derivation: string;
  evidence_count: number;
  kind: "dynamic" | "static";
  provenance_kind: string;
  edgeKey: string;
  curveOffset: number;
}

interface DrawnLink extends SimLink {
  source: SimNode;
  target: SimNode;
}

interface GraphLayout {
  id: number;
  nodes: SimNode[];
  links: DrawnLink[];
  radius: (n: SimNode) => number;
  showLabel: (n: SimNode) => boolean;
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

function pairKey(edge: { source: string; target: string }): string {
  const a = edge.source;
  const b = edge.target;
  return `${a < b ? a : b}\u0000${a < b ? b : a}`;
}

function edgeKeyOf(edge: GraphEdge): string {
  return [edge.source, edge.target, edge.relation, edge.derivation].join("\u0001");
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
  const {
    dataset,
    filters,
    focusedEntityId,
    focusEntity,
    setFilters,
    cursor,
    masking,
  } = useWorkspace();
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
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [evidence, setEvidence] = useState<EventItem[]>([]);
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [evidenceMatched, setEvidenceMatched] = useState<number | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const graphStageRef = useRef<HTMLDivElement>(null);
  const previousLayout = useRef<GraphLayout | null>(null);
  const layoutSequence = useRef(0);
  const panStart = useRef<{ pointerId: number; clientX: number; clientY: number; transform: GraphTransform } | null>(null);

  useEffect(() => {
    if (!focusedEntityId) {
      setPayload(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPayload(null);
    setSelectedEdge(null);
    fetchGraph(
      dataset,
      focusedEntityId,
      { filters, depth, cursorUs: cursor, masking },
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setPayload(data);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [dataset, focusedEntityId, filters, depth, cursor, masking]);

  useEffect(() => {
    setViewTransform({ x: 0, y: 0, scale: 1 });
    setSelectedEdge(null);
  }, [dataset, focusedEntityId]);

  useEffect(() => {
    if (!selectedEdge) {
      setEvidence([]);
      setEvidenceCursor(null);
      setEvidenceMatched(null);
      setEvidenceError(null);
      return;
    }
    const controller = new AbortController();
    setEvidenceLoading(true);
    setEvidenceError(null);
    setEvidence([]);
    fetchGraphEvidence(
      {
        dataset,
        filters,
        edge: selectedEdge,
        limit: 50,
        cursorUs: cursor,
        masking,
      },
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setEvidence(data.items);
        setEvidenceCursor(data.next_cursor);
        setEvidenceMatched(data.meta.matched_events);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setEvidenceError(err instanceof Error ? err.message : "证据读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setEvidenceLoading(false);
      });
    return () => controller.abort();
  }, [selectedEdge, dataset, filters, cursor, masking]);

  const loadMoreEvidence = () => {
    if (!selectedEdge || !evidenceCursor) return;
    fetchGraphEvidence({
      dataset,
      filters,
      edge: selectedEdge,
      limit: 50,
      cursor: evidenceCursor,
      cursorUs: cursor,
      masking,
    })
      .then((data) => {
        setEvidence((prev) => [...prev, ...data.items]);
        setEvidenceCursor(data.next_cursor);
        setEvidenceMatched(data.meta.matched_events);
      })
      .catch((err: unknown) => setEvidenceError(err instanceof Error ? err.message : "证据读取失败"));
  };

  function buildLayout(data: GraphPayload | null): GraphLayout | null {
    if (!data) return null;
    const nodes: SimNode[] = data.nodes.map((node) => ({
      ...node,
      x: node.is_center
        ? W / 2
        : W / 2 + Math.cos(stableAngle(node.id)) * LAYER_RADIUS[Math.min(node.level, LAYER_RADIUS.length - 1)],
      y: node.is_center
        ? H / 2
        : H / 2 + Math.sin(stableAngle(node.id)) * LAYER_RADIUS[Math.min(node.level, LAYER_RADIUS.length - 1)],
    }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const allEdges = [...data.edges, ...data.static_edges];
    const links: SimLink[] = allEdges
      .filter((edge) => edge.source && byId.has(edge.source) && byId.has(edge.target))
      .map((edge) => ({
        source: byId.get(edge.source)!,
        target: byId.get(edge.target)!,
        relation: edge.relation,
        derivation: edge.derivation,
        evidence_count: edge.evidence_count,
        kind: edge.kind,
        provenance_kind: edge.provenance_kind,
        edgeKey: edgeKeyOf(edge),
        curveOffset: 0,
      }));

    const parallelEdges = new Map<string, SimLink[]>();
    for (const edge of links) {
      const key = `${pairKey(edge as unknown as { source: string; target: string })}\u0000${edge.kind}`;
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
          .id((node) => node.id)
          .distance((edge) => (Math.max((edge.source as SimNode).level, (edge.target as SimNode).level) > 1 ? 105 : 130))
          .strength(0.7),
      )
      .force("charge", forceManyBody().strength(-320))
      .force("center", forceCenter(W / 2, H / 2))
      .force(
        "radial",
        forceRadial<SimNode>((node) => LAYER_RADIUS[Math.min(node.level, LAYER_RADIUS.length - 1)], W / 2, H / 2)
          .strength(0.8),
      )
      .force("collide", forceCollide<SimNode>().radius((node) => (node.is_center ? 34 : 25)))
      .stop();

    sim.randomSource(() => 0.5);
    for (let i = 0; i < 300; i++) sim.tick();

    const maxDegree = Math.max(1, ...nodes.map((node) => node.visible_degree));
    const radius = scaleSqrt().domain([0, maxDegree]).range([7, 20]);
    const ranked = [...nodes].sort((a, b) => b.visible_degree - a.visible_degree);
    const topIds = new Set(ranked.slice(0, 12).map((node) => node.id));
    const firstLayerCount = nodes.filter((node) => node.level === 1).length;
    return {
      id: ++layoutSequence.current,
      nodes,
      links: links as unknown as DrawnLink[],
      radius: (node: SimNode) => (node.is_center ? Math.max(14, radius(node.visible_degree)) : radius(node.visible_degree)),
      showLabel: (node: SimNode) =>
        node.is_center || (node.level === 1 && firstLayerCount <= 20) || topIds.has(node.id),
    };
  }

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
    const dx = ((event.clientX - start.clientX) * W) / Math.max(1, rect.width) / start.transform.scale;
    const dy = ((event.clientY - start.clientY) * H) / Math.max(1, rect.height) / start.transform.scale;
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
    for (const node of payload?.nodes ?? []) {
      counts.set(node.entity_type, (counts.get(node.entity_type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [payload]);

  const staticEdgeKeys = useMemo(
    () => new Set((payload?.static_edges ?? []).map((edge) => edgeKeyOf(edge))),
    [payload],
  );

  function renderLayer(graphLayout: GraphLayout, className: string, interactive: boolean) {
    const levelOpacity = [1, 0.94, 0.66, 0.42];
    return (
      <g key={`layout-${graphLayout.id}`} className={className} pointerEvents={interactive ? "auto" : "none"}>
        <g>
          {graphLayout.links.map((edge, index) => {
            const isStatic = edge.kind === "static";
            const isDerived = edge.provenance_kind === "derived";
            const midpoint = edgeMidpoint(edge);
            const activeEdge = interactive && hoveredEdge === edge.edgeKey;
            const opacity = levelOpacity[Math.min(Math.max(edge.source.level, edge.target.level), 3)];
            const stroke = isStatic ? colors.textFaint : isDerived ? colors.warn : colors.textMuted;
            return (
              <g
                key={`edge-${index}`}
                className="graph-edge"
                onMouseEnter={interactive ? () => setHoveredEdge(edge.edgeKey) : undefined}
                onMouseLeave={interactive ? () => setHoveredEdge(null) : undefined}
                onFocus={interactive ? () => setHoveredEdge(edge.edgeKey) : undefined}
                onBlur={interactive ? () => setHoveredEdge(null) : undefined}
                onClick={
                  interactive && !isStatic
                    ? () => {
                        const source = payload?.edges.find((item) => edgeKeyOf(item) === edge.edgeKey);
                        if (source) setSelectedEdge(source);
                      }
                    : undefined
                }
                tabIndex={interactive ? 0 : -1}
                role={interactive && !isStatic ? "button" : undefined}
                aria-label={
                  isStatic
                    ? `${edge.relation}，静态组织边`
                    : `${edge.relation}，证据 ${edge.evidence_count} 条，点击查看证据`
                }
              >
                <title>
                  {isStatic
                    ? `${edge.relation} · 静态背景（无事件时间戳）`
                    : `${edge.relation} · ${edge.evidence_count} 条去重证据 · 点击打开证据列表`}
                </title>
                <path d={edgePath(edge)} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke" />
                <path
                  d={edgePath(edge)}
                  fill="none"
                  stroke={stroke}
                  strokeOpacity={opacity * (activeEdge ? 0.95 : isStatic ? 0.3 : 0.48)}
                  strokeWidth={activeEdge ? 2.2 : !isStatic && edge.evidence_count > 50 ? 2 : 1}
                  strokeDasharray={isStatic ? "2 5" : isDerived ? "4 3" : undefined}
                  markerEnd={isStatic ? undefined : isDerived ? "url(#arrow-dashed)" : "url(#arrow-solid)"}
                  pointerEvents="none"
                />
                {activeEdge && (
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
                      {isStatic ? " · 静态" : ` · ${edge.evidence_count}`}
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
                onKeyDown={
                  interactive
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") focusEntity(node.id);
                      }
                    : undefined
                }
              >
                <title>{`${node.label}\n${TYPE_LABEL[node.entity_type] ?? node.entity_type} · ${node.level} 跳 · 可见度数 ${node.visible_degree}`}</title>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={graphLayout.radius(node)}
                  fill={colors.categories[(TYPE_COLOR_INDEX[node.entity_type] ?? 8) - 1]}
                  fillOpacity={node.is_center ? 0.95 : 0.8}
                  stroke={node.is_center ? colors.accent : colors.panel}
                  strokeWidth={node.is_center ? 3 : 1.5}
                />
                {showLabel &&
                  (node.is_center ? (
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
        <p className="muted small">
          图焦点只是探索中心；要按参与者过滤统计，请在图内点击「筛选该参与者」。
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
        <h2>这个实体在筛选后没有可绘制的关系</h2>
        <p>
          聚焦实体 <code>{payload.center}</code> 在 {payload.meta.matched_events.toLocaleString()} 条匹配事件内没有关系节点。
          可以清除筛选或切换其他参与者。
        </p>
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
            {payload.edges.length} 条事件边 · {payload.static_edges.length} 条组织边 · 匹配{" "}
            {payload.meta.matched_events.toLocaleString()} 条事件
            {loading && " · 更新中…"}
          </p>
          {filters.participantId && (
            <p className="muted small">
              已按参与者筛选：<code>{filters.participantId}</code>
            </p>
          )}
        </div>
        <div className="graph-tools">
          <button
            type="button"
            className="btn"
            onClick={() => setFilters({ participantId: focusedEntityId })}
            title="用该实体作为参与者筛选条件，影响列表、概览与比较"
          >
            筛选该参与者
          </button>
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
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => setViewTransform({ x: 0, y: 0, scale: 1 })}
            title="重置关系图缩放与位置"
          >
            重置视图
          </button>
        </div>
      </div>

      {payload.truncated && (
        <div className="callout callout-warn">
          <strong>已裁剪</strong>
          <p>
            原因：{payload.truncation_reasons.map((reason) => REASON_LABEL[reason] ?? reason).join("；")}。
            当前子图只包含被保留的部分，不能据此断言「没有其它关联」。
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
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="实体关系子图" preserveAspectRatio="xMidYMid meet">
          <defs>
            <marker id="arrow-solid" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.textMuted} />
            </marker>
            <marker id="arrow-dashed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.warn} />
            </marker>
          </defs>

          <g transform={`translate(${viewTransform.x} ${viewTransform.y}) scale(${viewTransform.scale})`}>
            {[1, 2, 3]
              .filter((level) => level <= payload.depth)
              .map((level) => (
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
                  <text x={W / 2 + 7} y={H / 2 - LAYER_RADIUS[level] + 14} fontSize={9} fill={colors.textFaint}>
                    {level} 跳
                  </text>
                </g>
              ))}

            {leavingLayout && renderLayer(leavingLayout, "graph-layout-leave", false)}
            {renderLayer(layout, "graph-layout-enter", true)}
          </g>
        </svg>
      </div>

      {selectedEdge && (
        <div className="callout graph-evidence" aria-label="边的证据事件">
          <div className="graph-evidence-head">
            <strong>
              证据列表 · {selectedEdge.relation}
              <span className="muted small">
                {" "}
               （{evidenceMatched?.toLocaleString() ?? "…"} 条去重事件，已载入 {evidence.length}）
              </span>
            </strong>
            <button type="button" className="btn btn-quiet" onClick={() => setSelectedEdge(null)}>
              关闭
            </button>
          </div>
          <p className="muted small">
            {selectedEdge.source || "（源未知）"} → {selectedEdge.target} · 来源 {selectedEdge.derivation}
            {staticEdgeKeys.has(edgeKeyOf(selectedEdge)) ? " · 静态组织关系" : ""}
          </p>
          {evidenceError && <p className="stream-error">证据读取失败：{evidenceError}</p>}
          {evidenceLoading && evidence.length === 0 && <p className="muted small">正在读取证据…</p>}
          <ul className="graph-evidence-list">
            {evidence.map((item) => (
              <li key={item.event_id}>
                <button
                  type="button"
                  className="stream-row"
                  onClick={() => focusEntity(item.actor_id ?? focusedEntityId)}
                  title="点击把该事件的执行者设为图焦点；在事件流中可查看完整记录"
                >
                  <span className="stream-time mono">{formatUtc(item.time_us)}</span>
                  <span className="stream-type">{item.event_type}</span>
                  <span className="stream-actor mono">{item.actor_label ?? item.actor_id ?? "—"}</span>
                  <span className="stream-preview">{item.preview || "（无摘要）"}</span>
                </button>
              </li>
            ))}
          </ul>
          {evidenceCursor && (
            <button type="button" className="btn" onClick={loadMoreEvidence} disabled={evidenceLoading}>
              {evidenceLoading ? "加载中…" : "加载更多证据"}
            </button>
          )}
        </div>
      )}

      <div className="graph-legend">
        {[0, 1, 2, 3]
          .filter((level) => level <= payload.depth)
          .map((level) => (
            <span key={`level-${level}`} className="legend-item">
              <span className={`level-swatch level-${level}`} />
              {level === 0 ? "中心" : `${level} 跳`}
              {` ${payload.nodes.filter((node) => node.level === level).length}`}
            </span>
          ))}
        {typeCounts.map(([type, count]) => (
          <span key={type} className="legend-item">
            <span className="swatch" style={{ background: colors.categories[(TYPE_COLOR_INDEX[type] ?? 8) - 1] }} />
            {TYPE_LABEL[type] ?? type} {count}
          </span>
        ))}
        <span className="legend-item legend-off">实线 = 源字段直读</span>
        <span className="legend-item legend-off">虚线 = adapter 派生</span>
        <span className="legend-item legend-off">点线 = 静态组织背景</span>
      </div>
      <p className="muted small">
        边表示同一事件记录中的参与关系，不代表因果。点击节点可把该实体设为新的中心；点击事件边打开去重证据列表。
        节点度数只统计当前可见子图。
      </p>
    </div>
  );
}
