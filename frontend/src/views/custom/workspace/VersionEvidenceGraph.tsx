import { roleVisual } from "./customVisuals";
import { RoleLabel } from "./RoleLabel";
import { useId, useMemo } from "react";
import { offset, summary, type Detail, type EvidenceNode, type EvidenceEdge, type Attempt } from "./customApi";

export function evidencePath(detail: Detail, attempt?: Attempt) {
  const p = detail.projection;
  const ids = new Set<string>(attempt ? [attempt.attempt_event_id] : []);
  if (!attempt) return ids;
  for (const id of [...attempt.publish.result_event_ids ?? [], ...attempt.publish.write_event_ids ?? []]) ids.add(id);
  // Trace only evidence relationships into the selected attempt and its result.
  let changed = true;
  while (changed) { changed = false; for (const e of p.edges) if (ids.has(e.target) && !ids.has(e.source)) { ids.add(e.source); changed = true; } }
  return ids;
}

export function VersionEvidenceGraph({ detail, attempt, selected, select, compact = false }: { compact?: boolean; detail: Detail; attempt?: Attempt; selected: string | null; select: (id: string | null) => void }) {
  const marker = useId().replace(/:/g, "");
  const p = detail.projection;
  const layout = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    const versions = p.versions;
    const columns: Record<string, number> = compact ? { version: 0, review: 1, read: 2, attempt: 1, copy: 2, result: 2 } : { version: 0, review: 1, read: 2, attempt: 3, copy: 4, result: 4 };
    const step = compact ? 410 : 220;
    let maxY = 200;
    let baseY = 68;
    for (const v of versions) {
      const matches = p.nodes.filter(n => n.kind !== "version" && n.kind !== "route" && n.document_id === v.document_id && n.version === v.version && n.details.sha256 === v.hash);
      positions.set(v.id, { x: 14, y: baseY });
      const occupied: Record<string, number> = {};
      for (const n of matches) {
        const row = occupied[n.kind] ?? 0; occupied[n.kind] = row + 1;
        positions.set(n.id, { x: 14 + (columns[n.kind] ?? 4) * 178, y: baseY + (compact ? n.kind === "result" ? 274 : ["attempt", "copy"].includes(n.kind) ? 164 : 0 : n.kind === "result" ? 110 : 0) + row * step });
      }
      const extra = Math.max(1, ...Object.values(occupied));
      maxY = Math.max(maxY, baseY + step * extra);
      baseY = maxY + 25;
    }
    for (const n of p.nodes) if (n.kind !== "route" && !positions.has(n.id)) { positions.set(n.id, { x: 14 + (columns[n.kind] ?? 4) * 178, y: maxY }); maxY += 110; }
    return { positions, height: maxY + 20 };
  }, [p, compact]);
  const chosenEdge = p.edges.find(e => e.id === selected);
  const full = !selected || selected === attempt?.attempt_event_id;
  const path = full ? evidencePath(detail, attempt) : new Set([selected!, ...(chosenEdge ? [chosenEdge.source, chosenEdge.target] : []), ...p.edges.filter(e => e.source === selected || e.target === selected).flatMap(e => [e.source, e.target])]);
  const active = (e: EvidenceEdge) => full ? path.has(e.source) && path.has(e.target) : e.id === selected || e.source === selected || e.target === selected;
  const state = (n: EvidenceNode) => n.kind === "version" && n.version === attempt?.version_check.current_version_at_attempt ? "current" : n.kind === "review" ? n.details.approved === false ? "attention" : "good" : n.kind === "attempt" && attempt?.version_check.status === "stale" ? "attention" : n.kind === "result" && n.details.status === "success" ? "good" : "";
  function line(e: EvidenceEdge) {
    const a = layout.positions.get(e.source), b = layout.positions.get(e.target); if (!a || !b) return null;
    const x1 = a.x + 144, y1 = a.y + 37, x2 = b.x, y2 = b.y + 37;
    let d = `M${x1},${y1} C${x1 + 20},${y1} ${x2 - 20},${y2} ${x2},${y2}`;
    let lx = (x1 + x2) / 2, ly = Math.min(y1, y2) - 8;
    if (e.relation === "修订") { d = `M${a.x + 10},${a.y + 76} V${b.y - 10} H${b.x + 12} V${b.y}`; lx = a.x + 45; ly = (a.y + b.y) / 2 + 40; }
    else if (e.relation === "结果来源记录") { d = `M${a.x + 72},${a.y + 76} V${b.y}`; lx = a.x + 83; ly = a.y + 97; }
    else if (x2 - x1 > 60) { const lift = e.relation === "审核引用" ? -27 : e.relation === "读取此版" ? 96 : e.relation === "尝试此版" ? 118 : 177; const by = a.y + lift; d = `M${x1 - 12},${y1 + 30} V${by} H${x2 + 12} V${y2 + 30}`; lx = (x1 + x2) / 2; ly = by - 5; }
    else if (e.relation.includes("结果") || !e.recorded) { d = `M${x1 - 16},${y1 + 32} V${b.y + 95} H${x2 + 20} V${b.y + 76}`; lx = x1 + 70; ly = b.y + 91; }
    if (compact && e.relation !== "修订") {
      if (b.y > a.y && b.x <= a.x) { const mid = (a.y + 76 + b.y) / 2; d = `M${a.x + 72},${a.y + 76} C${a.x + 72},${mid} ${b.x + 72},${mid} ${b.x + 72},${b.y}`; lx = (a.x + b.x) / 2 + 72; ly = mid - 5; }
      else if (b.y > a.y) { const mid = a.y + 118; d = `M${a.x + 144},${a.y + 38} H${a.x + 157} V${mid} H${b.x - 10} V${b.y + 38} H${b.x}`; lx = (a.x + 144 + b.x) / 2; ly = mid - 5; }
      else if (x2 - x1 > 60) { const by = a.y + 110; d = `M${x1},${a.y + 60} H${x1 + 12} V${by} H${b.x + 72} V${b.y + 76}`; lx = (x1 + b.x + 72) / 2; ly = by - 5; }
      else { d = `M${x1},${y1} H${x2}`; lx = (x1 + x2) / 2; ly = y1 - 8; }
    }
    return <g key={e.id} className={`cu-edge ${active(e) ? "active" : ""} ${!e.recorded ? "derived" : ""}`} role="button" tabIndex={0} aria-label={`${e.relation}；${e.field}`} onClick={ev => { ev.stopPropagation(); select(e.id); }} onKeyDown={ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(e.id); } }}><title>{e.relation} · {e.field} · {e.recorded ? "明确字段" : "规则派生"}</title><path className="cu-edge-hit" d={d}/><path d={d} markerEnd={`url(#${marker})`}/><text x={lx} y={ly} textAnchor="middle">{e.relation}</text></g>;
  }
  return <div className={`cu-version-graph ${compact ? "compact" : ""}`} data-testid="version-graph">
    <div className="cu-route-row">{p.nodes.filter(n => n.kind === "route").map(n => <button key={n.id} aria-pressed={selected === n.id} className="cu-route" onClick={() => select(n.id)}><b><RoleLabel role="controller"/> · controller · 流程选择</b><span>选用 v{String(n.details.selected_version ?? "?")} · 记录期望 v{String(n.details.expected_version ?? "?")}</span><small>{offset(n.time_us, detail.run.start_us)} · 查看原记录</small></button>)}{!p.nodes.some(n => n.kind === "route") && <span className="cu-note">本运行没有单独的流程选择记录；实际使用版本沿读取和尝试核对。</span>}</div>
    <div className="cu-svg-scroll"><svg viewBox={`0 0 ${compact ? 548 : 890} ${layout.height}`} style={{ minWidth: compact ? 520 : 880 }} role="group" aria-label="版本与发布证据关系图" onClick={() => select(null)}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="#628bb0"/></marker></defs>
      {!compact && ["文档版本", "审核", "发布者读取", "发布尝试", "本地写入与结果"].map((t, i) => <text key={t} x={i * 178 + 85} y={24} textAnchor="middle" className="cu-col-heading">{t}</text>)}
      {p.edges.filter(e => e.relation !== "流程选用").map(line)}
      {p.nodes.filter(n => n.kind !== "route").map(n => { const xy = layout.positions.get(n.id)!, visual = roleVisual(n.role), Icon = visual.icon; return <g key={n.id} transform={`translate(${xy.x},${xy.y})`} role="button" tabIndex={0} aria-label={`${n.label} v${n.version ?? "?"}`} aria-pressed={selected === n.id} className={`cu-node ${state(n)} ${path.has(n.id) ? "on-path" : ""} ${selected === n.id ? "selected" : ""}`} onClick={ev => { ev.stopPropagation(); select(n.id); }} onKeyDown={ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(n.id); } }}>
        <title>{n.label} · {n.source_event_ids.join(", ")}</title><rect width={144} height={76} rx={n.kind === "version" ? 3 : 9}/><text x={11} y={22} className="cu-node-title">{n.kind === "version" ? `▤ ${n.label}` : n.label}</text>{n.kind !== "version" && <Icon x={11} y={31} width={13} height={13} color={visual.color} aria-hidden="true"/>}<text x={n.kind === "version" ? 11 : 29} y={43} style={{ fill: n.kind === "version" ? undefined : visual.color }}>{n.kind === "version" ? n.hash?.slice(0, 11) ?? "哈希缺失" : `v${n.version ?? "?"} · ${n.role}`}</text><text x={11} y={62} className="cu-node-small">{n.kind === "version" && n.version === attempt?.version_check.current_version_at_attempt ? "本次尝试时的当前版" : offset(n.time_us, detail.run.start_us)}</text>
      </g>; })}
      {attempt?.review.status === "invalid" && !p.nodes.some(n => n.kind === "review") && <text x={192} y={compact ? 170 : 177} className="cu-empty-label">明确无审核凭证</text>}
    </svg></div>
    <p className="cu-note">实线：明确字段关联 · 虚线：双向唯一的派生匹配。列位置不代表时间或必经阶段；写入与结果按原始记录方向连接。</p>
    <p className="cu-path-summary" data-testid="path-summary">{summary(attempt)}</p>
  </div>;
}
