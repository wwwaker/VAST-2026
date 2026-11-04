import { useEffect, useMemo, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
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
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  relation: string;
  derivation: string;
  evidence_count: number;
}

interface DrawnLink {
  source: SimNode;
  target: SimNode;
  relation: string;
  derivation: string;
  evidence_count: number;
}

export function RelationGraph() {
  const { dataset, focusedEntityId, focusEntity } = useWorkspace();
  const { colors } = useTheme();

  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [depth, setDepth] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!focusedEntityId) {
      setPayload(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
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

  const layout = useMemo(() => {
    if (!payload) return null;
    const nodes: SimNode[] = payload.nodes.map((n) => ({
      ...n,
      x: W / 2 + (Math.random() - 0.5) * 120,
      y: H / 2 + (Math.random() - 0.5) * 120,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = payload.edges
      .filter((e) => e.source && byId.has(e.source) && byId.has(e.target))
      .map((e) => ({
        source: byId.get(e.source)!,
        target: byId.get(e.target)!,
        relation: e.relation,
        derivation: e.derivation,
        evidence_count: e.evidence_count,
      }));

    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(130)
          .strength(0.7),
      )
      .force("charge", forceManyBody().strength(-420))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide<SimNode>().radius(30))
      .stop();

    // 同步跑完布局：结果确定、无动画，减少动效设置下行为一致
    for (let i = 0; i < 350; i++) sim.tick();

    // 力学布局的绝对尺寸与节点数不成比例，统一缩放铺满画布，避免挤在中间
    const PAD = 70;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const scaleX = (W - 2 * PAD) / Math.max(1, maxX - minX);
    const scaleY = (H - 2 * PAD) / Math.max(1, maxY - minY);
    const fit = Math.min(scaleX, scaleY, 3);
    const offX = (W - (maxX - minX) * fit) / 2;
    const offY = (H - (maxY - minY) * fit) / 2;
    for (const n of nodes) {
      n.x = offX + ((n.x ?? 0) - minX) * fit;
      n.y = offY + ((n.y ?? 0) - minY) * fit;
    }

    const maxDegree = Math.max(1, ...nodes.map((n) => n.degree));
    const radius = scaleSqrt().domain([0, maxDegree]).range([7, 20]);

    // 标签策略：小图全标（径向放置避免压线），大图只标中心和度数前 12 的节点
    const ranked = [...nodes].sort((a, b) => b.degree - a.degree);
    const topIds = new Set(ranked.slice(0, 12).map((n) => n.id));
    const showLabel = (n: SimNode) => nodes.length <= 30 || n.is_center || topIds.has(n.id);

    return {
      nodes,
      links: links as unknown as DrawnLink[],
      radius: (n: SimNode) => (n.is_center ? Math.max(14, radius(n.degree)) : radius(n.degree)),
      showLabel,
      unlinked: payload.edges.length - links.length,
    };
  }, [payload]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of payload?.nodes ?? []) {
      counts.set(n.entity_type, (counts.get(n.entity_type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [payload]);

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
            {[1, 2].map((d) => (
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

      <div className="graph-stage">
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

          <g>
            {layout.links.map((e, i) => {
              const derived = e.derivation.startsWith("adapter:");
              return (
                <line
                  key={`e${i}`}
                  x1={e.source.x}
                  y1={e.source.y}
                  x2={e.target.x}
                  y2={e.target.y}
                  stroke={derived ? colors.warn : colors.textMuted}
                  strokeOpacity={0.5}
                  strokeWidth={e.evidence_count > 50 ? 2 : 1}
                  strokeDasharray={derived ? "4 3" : undefined}
                  markerEnd={derived ? "url(#arrow-dashed)" : "url(#arrow-solid)"}
                />
              );
            })}
          </g>

          {layout.links.length <= 26 && (
            <g>
              {layout.links.map((e, i) => (
                <text
                  key={`l${i}`}
                  x={((e.source.x ?? 0) + (e.target.x ?? 0)) / 2}
                  y={((e.source.y ?? 0) + (e.target.y ?? 0)) / 2 - 3}
                  fontSize={9}
                  fill={colors.textFaint}
                  textAnchor="middle"
                >
                  {e.relation}
                </text>
              ))}
            </g>
          )}

          <g>
            {layout.nodes.map((n) => (
              <g
                key={n.id}
                className="graph-node"
                onClick={() => focusEntity(n.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") focusEntity(n.id);
                }}
              >
                <title>
                  {`${n.label}\n${TYPE_LABEL[n.entity_type] ?? n.entity_type} · 度数 ${n.degree}`}
                </title>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={layout.radius(n)}
                  fill={colors.categories[(TYPE_COLOR_INDEX[n.entity_type] ?? 8) - 1]}
                  fillOpacity={n.is_center ? 0.95 : 0.8}
                  stroke={n.is_center ? colors.accent : colors.panel}
                  strokeWidth={n.is_center ? 3 : 1.5}
                />
                {layout.showLabel(n) &&
                  (n.is_center ? (
                    <text
                      x={n.x}
                      y={(n.y ?? 0) - layout.radius(n) - 8}
                      fontSize={11}
                      fontWeight={600}
                      fill={colors.text}
                      textAnchor="middle"
                    >
                      {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                    </text>
                  ) : (
                    // 外圈标签朝背离中心的一侧排，减少与连线、彼此的重叠
                    <text
                      x={(n.x ?? 0) + ((n.x ?? 0) >= W / 2 ? 1 : -1) * (layout.radius(n) + 5)}
                      y={(n.y ?? 0) + 3.5}
                      fontSize={10}
                      fill={colors.textMuted}
                      textAnchor={(n.x ?? 0) >= W / 2 ? "start" : "end"}
                    >
                      {n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label}
                    </text>
                  ))}
              </g>
            ))}
          </g>
        </svg>
      </div>

      <div className="graph-legend">
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
