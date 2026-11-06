import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { useTheme } from "../../theme/theme";
import {
  fetchGroupMembers,
  fetchSystemOverview,
  type GroupMembers,
  type SystemEdge,
  type SystemGroup,
  type SystemOverviewPayload,
} from "../../data/api";

const W = 640;
const H = 380;
const CENTER = { x: 320, y: 180 };
const RING = 118;

const ORDER = [
  "file_path",
  "agent",
  "person",
  "system",
  "room",
  "team",
  "department",
  "company",
  "world",
  "unknown",
];

function radiusOf(members: number): number {
  return Math.min(46, 13 + 11 * Math.log10(members + 1));
}

function widthOf(count: number): number {
  return 1 + 2.2 * Math.log10(1 + count / 500);
}

/** 类型级系统背景：不画 15,538 个实体，展开后才给真实 ID。 */
export function SystemMap() {
  const { focusEntity, traceRootId, selectedEventId, openTrace } = useWorkspace();
  const { colors } = useTheme();
  const [payload, setPayload] = useState<SystemOverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SystemGroup | null>(null);
  const [members, setMembers] = useState<GroupMembers | null>(null);
  const [hovered, setHovered] = useState<SystemEdge | null>(null);

  const rootId = traceRootId ?? selectedEventId;

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetchSystemOverview(rootId, controller.signal)
      .then((data) => setPayload(data))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取失败");
      });
    return () => controller.abort();
  }, [rootId]);

  useEffect(() => {
    if (!selected) {
      setMembers(null);
      return;
    }
    const controller = new AbortController();
    fetchGroupMembers(selected.entity_type, 20, controller.signal)
      .then((data) => setMembers(data))
      .catch(() => setMembers(null));
    return () => controller.abort();
  }, [selected]);

  const layout = useMemo(() => {
    if (!payload) return null;
    const groups = [...payload.groups].sort(
      (a, b) => ORDER.indexOf(a.entity_type) - ORDER.indexOf(b.entity_type),
    );
    const positions = new Map<string, { x: number; y: number; r: number }>();
    groups.forEach((group, index) => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(groups.length, 1);
      positions.set(group.group_id, {
        x: CENTER.x + RING * Math.cos(angle) * 1.35,
        y: CENTER.y + RING * Math.sin(angle),
        r: radiusOf(group.member_count),
      });
    });
    return { groups, positions };
  }, [payload]);

  if (error) {
    return (
      <div className="empty-state">
        <h2>系统背景读取失败</h2>
        <p className="muted small">{error}</p>
      </div>
    );
  }
  if (!payload || !layout) return <p className="muted small">正在建立系统背景…</p>;

  const spotlight = new Set(payload.spotlight?.groups ?? []);

  return (
    <div className="system-map">
      <div className="trace-head">
        <strong>系统背景</strong>
        <span className="muted small">
          {payload.scale.events_total.toLocaleString()} 条事件 · {payload.scale.entities_total.toLocaleString()} 个实体聚合成{" "}
          {payload.scale.group_count} 组 · 文件 {payload.scale.files_aggregated.toLocaleString()} 个默认折叠
        </span>
        {payload.meta.cache_hit && <span className="tag">缓存命中</span>}
        {payload.scale.unresolved_event_count > 0 && (
          <span className="tag tag-warn">{payload.scale.unresolved_event_count} 条关系端点未解析</span>
        )}
      </div>

      {payload.spotlight && (
        <div className="callout">
          <strong>高亮当前事件的参与者：</strong>
          <code className="mono small">{payload.spotlight.root_event_id}</code>
          {payload.spotlight.entities.map((item) => (
            <span key={item.entity_id} className="role-chip">
              {item.label}（{item.role}）
            </span>
          ))}
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => openTrace({ rootEventId: payload.spotlight?.root_event_id ?? null })}
          >
            以它作为链根
          </button>
          <p className="muted small">
            高亮依据是事件的参与者列表，不是“已确认的异常链”；在来源链里选中目标帖可以看到完整内容来源。
          </p>
        </div>
      )}

      <div className="system-map-body">
        <svg className="system-canvas" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="系统背景地图">
          {payload.interaction_edges.map((edge) => {
            const from = layout.positions.get(edge.source);
            const to = layout.positions.get(edge.target);
            if (!from || !to) return null;
            const highlighted = spotlight.has(edge.source) && spotlight.has(edge.target);
            const midX = (from.x + to.x) / 2 + (CENTER.x - (from.x + to.x) / 2) * 0.18;
            const midY = (from.y + to.y) / 2 + (CENTER.y - (from.y + to.y) / 2) * 0.18;
            return (
              <g key={`${edge.source}-${edge.target}-${edge.relation}`}>
                <path
                  d={`M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`}
                  fill="none"
                  stroke={highlighted ? colors.accent : colors.textFaint}
                  strokeWidth={widthOf(edge.event_count)}
                  strokeLinecap="round"
                  opacity={highlighted ? 0.85 : 0.6}
                  strokeDasharray={edge.target === "group:unknown" ? "4 4" : undefined}
                  onMouseEnter={() => setHovered(edge)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <title>{`${edge.relation} · ${edge.event_count.toLocaleString()} 条事件`}</title>
                </path>
              </g>
            );
          })}

          {layout.groups.map((group) => {
            const pos = layout.positions.get(group.group_id);
            if (!pos) return null;
            const isSpot = spotlight.has(group.group_id);
            const active = selected?.group_id === group.group_id;
            return (
              <g
                key={group.group_id}
                className="system-node"
                onClick={() => setSelected(group)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setSelected(group);
                }}
              >
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={pos.r}
                  fill={isSpot ? colors.accent : colors.panel}
                  stroke={active || isSpot ? colors.accent : colors.border}
                  strokeWidth={active ? 3 : isSpot ? 2.2 : 1.2}
                  opacity={isSpot ? 0.85 : 0.9}
                />
                <text
                  x={pos.x}
                  y={pos.y + 4}
                  textAnchor="middle"
                  fontSize={pos.r >= 24 ? 12 : 10}
                  fill={isSpot ? "#fff" : colors.text}
                  pointerEvents="none"
                >
                  {group.label}
                </text>
                <text
                  x={pos.x}
                  y={pos.y + pos.r + 13}
                  textAnchor="middle"
                  fontSize={10}
                  fill={colors.textMuted}
                  pointerEvents="none"
                >
                  {group.unresolved
                    ? `${(group.event_count ?? 0).toLocaleString()} 条事件`
                    : `${group.member_count.toLocaleString()} 个`}
                </text>
              </g>
            );
          })}
        </svg>

        <aside className="system-side">
          {hovered ? (
            <div className="callout">
              <strong>{hovered.relation}</strong>
              <p className="muted small">
                {hovered.event_count.toLocaleString()} 条去重事件
                {hovered.sample_event_id && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="btn btn-quiet pattern-event"
                      onClick={() => openTrace({ rootEventId: hovered.sample_event_id })}
                    >
                      以样本事件为链根
                    </button>
                  </>
                )}
              </p>
            </div>
          ) : (
            <p className="muted small">悬停连线查看关系类型与事件数；点击节点展开成员。</p>
          )}

          {selected && (
            <>
              <h3>
                {selected.label} <span className="muted small">（{selected.member_count.toLocaleString()} 个）
                </span>
              </h3>
              {members ? (
                <ul className="trace-list">
                  {members.members.map((member) => (
                    <li key={member.entity_id}>
                      <button
                        type="button"
                        className="trace-item"
                        onClick={() => focusEntity(member.entity_id)}
                        title={member.entity_id}
                      >
                        <span className="mono small">{member.label}</span>
                        <span className="muted small">{member.event_count.toLocaleString()} 条事件</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">正在展开…</p>
              )}
              {members?.truncated && (
                <p className="muted small">
                  只列出参与事件最多的 20 个；其余 {selected.member_count.toLocaleString()} 个未展开。
                </p>
              )}
            </>
          )}

          <h3>静态组织关系</h3>
          <p className="muted small">
            共 {payload.scale.org_edges_returned} 条（`contains` / `led_by`），来自 org_chart，没有时间戳。
          </p>
          <ul className="org-list">
            {payload.org_edges.slice(0, 6).map((edge) => (
              <li key={`${edge.source}-${edge.target}-${edge.relation}`} className="muted small mono">
                {edge.source_label} → {edge.target_label}（{edge.relation}）
              </li>
            ))}
          </ul>

          {payload.notes.map((note) => (
            <p key={note} className="muted small">
              {note}
            </p>
          ))}
        </aside>
      </div>
    </div>
  );
}
