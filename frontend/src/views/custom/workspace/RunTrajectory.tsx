import type { CSSProperties } from "react";
import { ArrowLeft, ArrowRight, ZoomIn, ZoomOut } from "lucide-react";
import { roleVisual } from "./customVisuals";
import { RolePicker } from "./RolePicker";
import { TrajectoryRange } from "./TrajectoryRange";
import { useLayoutEffect, useRef, useState } from "react";
import { scaleLinear } from "d3-scale";
import { eventNames, roles, roleNames, offset, type Detail, type EvidenceEvent } from "./customApi";
import type { TrajectoryState } from "./customState";

export function useContainerWidth(fallback = 1000) { const host = useRef<HTMLDivElement>(null); const [width, setWidth] = useState(fallback); useLayoutEffect(() => { if (!host.current) return; const measure = () => { const w = host.current!.getBoundingClientRect().width; if (w) setWidth(w); }; measure(); const observer = new ResizeObserver(measure); observer.observe(host.current); return () => observer.disconnect(); }, []); return { host, width }; }

export function aggregateEvents(events: EvidenceEvent[], x: (e: EvidenceEvent) => number, anchor: string | null, distance = 16) {
  const groups: EvidenceEvent[][] = [];
  for (const e of events) { const last = groups.at(-1); if (e.event_id !== anchor && last && !last.some(m => m.event_id === anchor) && last[0].role === e.role && Math.abs(x(e) - x(last.at(-1)!)) < distance) last.push(e); else groups.push([e]); }
  return groups;
}

export function RunTrajectory({ detail, value, change, select, sharedWindow, setSharedWindow, sharedDuration, timeOnly = false, compact = false }: { compact?: boolean; detail: Detail; value: TrajectoryState; change: (s: TrajectoryState) => void; select: (ids: string[]) => void; sharedWindow?: [number, number] | null; setSharedWindow?: (w: [number, number] | null) => void; sharedDuration?: number; timeOnly?: boolean }) {
  const { host, width } = useContainerWidth();
  const p = detail.projection, start = detail.run.start_us ?? Math.min(...p.events.map(e => e.time_us));
  const duration = Math.max(.001, sharedDuration ?? ((detail.run.end_us ?? Math.max(...p.events.map(e => e.time_us))) - start) / 1e6);
  const window = (setSharedWindow ? sharedWindow : value.window) ?? [0, duration];
  const updateWindow = (w: [number, number] | null) => setSharedWindow ? setSharedWindow(w) : change({ ...value, window: w });
  const search = value.search;
  const setSearch = (search: string) => change({ ...value, search });
  const allRoles = [...roles, ...new Set(p.events.map(e => e.role).filter(r => r && !roles.includes(r)))];
  const visibleRoles = allRoles.filter(role => value.roles === null || value.roles.includes(role));
  const timeMode = value.mode === "time";
  const sequenceCount = p.events.filter(e => value.mode === "handoff" ? e.event_type === "task_handoff" : value.all || (!e.event_type.startsWith("agent_") && !["run_started", "run_finished"].includes(e.event_type))).length;
  const plotWidth = Math.max(compact ? 520 : 880, width - 4, timeMode ? 0 : 170 + sequenceCount * 110), left = compact ? 95 : 135, right = plotWidth - 30;
  const relative = (e: EvidenceEvent) => (e.time_us - start) / 1e6;
  const isBusiness = (e: EvidenceEvent) => !e.event_type.startsWith("agent_") && !["run_started", "run_finished"].includes(e.event_type);
  const sequence = p.events.filter(e => value.mode === "handoff" ? e.event_type === "task_handoff" : value.all || isBusiness(e));
  const visible = sequence.filter(e => visibleRoles.includes(e.role) && (value.types === null || value.types.includes(e.event_type)) && (!search || `${eventNames[e.event_type]} ${e.role} ${e.event_id} ${JSON.stringify(e.details)}`.toLowerCase().includes(search.toLowerCase())) && (!timeMode || relative(e) >= window[0] && relative(e) <= window[1]));
  const scale = scaleLinear().domain(timeMode ? window : [0, Math.max(1, sequence.length - 1)]).range([left, right]);
  const x = (e: EvidenceEvent) => scale(timeMode ? relative(e) : sequence.findIndex(s => s.event_id === e.event_id));
  const y = (role: string) => 72 + visibleRoles.indexOf(role) * 58;
  const grouped = timeMode ? visibleRoles.flatMap(role => aggregateEvents(visible.filter(e => e.role === role), x, value.anchor)) : visible.map(e => [e]);
  const anchor = p.events.find(e => e.event_id === value.anchor);
  const ghost = anchor && !visible.some(e => e.event_id === anchor.event_id);
  const shownCalls = value.calls && timeMode ? p.calls.filter(c => visibleRoles.includes(c.role) && c.start_us != null && c.end_us != null && (c.end_us - start) / 1e6 >= window[0] && (c.start_us - start) / 1e6 <= window[1]) : [];
  const set = (patch: Partial<TrajectoryState>) => change({ ...value, ...patch });
  function zoom(factor: number) { const center = anchor ? Math.max(window[0], Math.min(window[1], relative(anchor))) : (window[0] + window[1]) / 2; const span = Math.max(Math.min(.2, duration), Math.min(duration, (window[1] - window[0]) * factor)); const a = Math.max(0, Math.min(duration - span, center - span / 2)); updateWindow([a, a + span]); }
  function pan(direction: number) { const span = window[1] - window[0], a = Math.max(0, Math.min(duration - span, window[0] + direction * span / 3)); updateWindow([a, a + span]); }
  return <div ref={host} className="cu-trajectory" data-testid="trajectory">
    <div className="cu-tabs" aria-label="轨迹坐标">{([["time", "真实时间"], ["order", "操作顺序"], ["handoff", "交接顺序"]] as const).filter(([id]) => !timeOnly || id === "time").map(([id, label]) => <button key={id} aria-pressed={value.mode === id} onClick={() => set({ mode: id })}>{label}</button>)}</div>
    <div className="cu-trajectory-tools"><label><input type="checkbox" checked={value.all} disabled={value.mode === "handoff"} onChange={e => set({ all: e.target.checked })}/>显示全部原始事件</label><label><input type="checkbox" checked={value.calls} disabled={!timeMode} onChange={e => set({ calls: e.target.checked })}/>调用区间</label><RolePicker roles={allRoles} value={value.roles} change={roles => set({ roles })}/><input type="text" role="searchbox" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索本运行记录" aria-label="搜索本运行记录"/>
      <details className="cu-types cu-event-types"><summary>可见事件类型 {value.types === null ? "（全部）" : `(${value.types.length})`}</summary><div>{[...new Set(p.events.map(e => e.event_type))].map(t => <label key={t}><input type="checkbox" checked={value.types === null || value.types.includes(t)} onChange={e => { const types = value.types ?? [...new Set(p.events.map(e => e.event_type))]; set({ types: e.target.checked ? [...new Set([...types, t])] : types.filter(v => v !== t) }); }}/>{eventNames[t] ?? t}</label>)}<button onClick={() => set({ types: null })}>显示全部类型</button></div></details>
    </div>
    {timeMode ? <div className="cu-time-nav" aria-label="本次运行时间窗口"><div><b>{window[0].toFixed(2)}–{window[1].toFixed(2)} s</b><button aria-label="放大时间" onClick={() => zoom(.5)}><ZoomIn size={14} aria-hidden="true"/></button><button aria-label="缩小时间" onClick={() => zoom(2)}><ZoomOut size={14} aria-hidden="true"/></button><button aria-label="时间向左" onClick={() => pan(-1)}><ArrowLeft size={14} aria-hidden="true"/></button><button aria-label="时间向右" onClick={() => pan(1)}><ArrowRight size={14} aria-hidden="true"/></button><button onClick={() => updateWindow(null)}>恢复整次运行</button></div><TrajectoryRange events={p.events} start={start} duration={duration} window={window} change={updateWindow}/></div> : <p className="cu-notice">操作按记录顺序展开，间距不代表时间。调用时长请切换真实时间查看；同时间戳用原始序号排序。</p>}
    {value.roles !== null && <p className="cu-note">已选角色：{visibleRoles.map(role => roleNames[role] ?? role).join("、") || "无"} · 已隐藏 {allRoles.length - visibleRoles.length} 个角色 <button className="cu-text-button" onClick={() => set({ roles: null })}>显示全部角色</button></p>}
    {!visibleRoles.length && <p className="cu-notice">尚未选择角色。请从角色下拉框勾选，可同时查看多个角色。</p>}
    {ghost && <p className="cu-notice">选中记录不在当前窗口或可见类型中。<button onClick={() => { set({ search: "", all: true, types: null, roles: null, window: null }); setSharedWindow?.(null); }}>显示选中记录</button></p>}
    <div className="cu-svg-scroll"><svg viewBox={`0 0 ${plotWidth} ${visibleRoles.length * 58 + 115}`} style={{ minWidth: timeMode ? compact ? 520 : 880 : plotWidth }} role="group" aria-label={timeMode ? "六角色真实时间轨迹" : "六角色操作顺序轨迹"}>
      <defs><marker id={`handoff-${detail.run.run_id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#b17a29"/></marker></defs>
      {visibleRoles.map(role => { const { color, icon: Icon } = roleVisual(role); return <g key={role} data-role={role}><line x1={left} x2={right} y1={y(role)} y2={y(role)} stroke={color} strokeOpacity={.2}/><Icon x={8} y={y(role) - 17} width={14} height={14} color={color} aria-hidden="true"/><text x={28} y={y(role) - 5} className="cu-lane-title" style={{ fill: color }}>{roleNames[role] ?? role}</text><text x={8} y={y(role) + 13} className="cu-axis-text">{role}</text>{!p.events.some(e => e.role === role) && <text x={left + 10} y={y(role) - 8} className="cu-axis-text">{p.coverage.complete ? "本运行无动作记录" : "当前资料未见动作"}</text>}</g>; })}
      {timeMode && scale.ticks(7).map(t => <g key={t}><line x1={scale(t)} x2={scale(t)} y1={34} y2={visibleRoles.length * 58 + 45} stroke="#edf1f5"/><text x={scale(t)} y={visibleRoles.length * 58 + 75} textAnchor="middle" className="cu-axis-text">{t.toFixed(t < 1 ? 2 : 1)} s</text></g>)}
      {shownCalls.map((c, index) => { const a = Math.max(window[0], (c.start_us! - start) / 1e6), b = Math.min(window[1], (c.end_us! - start) / 1e6); return <g key={c.finished_event_id ?? c.started_event_id} role="button" tabIndex={0} aria-label={`${c.role} 调用 ${index + 1}`} className="cu-call" style={{ "--cu-role-color": roleVisual(c.role).color } as CSSProperties} onClick={() => select(c.source_event_ids)} onKeyDown={e => { if (e.key === "Enter") select(c.source_event_ids); }}><title>{c.role} · {((c.end_us! - c.start_us!) / 1e6).toFixed(3)}s · {c.status}</title><rect x={scale(a)} y={y(c.role) - 14} width={Math.max(3, scale(b) - scale(a))} height={25} rx={5}/>{scale(b) - scale(a) > 65 && <text x={scale(a) + 6} y={y(c.role) + 3}>{((c.end_us! - c.start_us!) / 1e6).toFixed(1)}s</text>}</g>; })}
      {grouped.map((members, index) => { const e = members[0], xx = x(e), yy = y(e.role), h = p.audit.handoff.sequence.find(h => h.event_id === e.event_id), isAnchor = members.some(m => m.event_id === value.anchor), repeat = h && h.direction_ordinal > 1, selected = members.some(m => value.members.includes(m.event_id)); return <g key={e.event_id} role="button" tabIndex={0} aria-label={`${eventNames[e.event_type]} ${members.length} 条 ${offset(e.time_us, start)}`} style={{ "--cu-role-color": roleVisual(e.role).color } as CSSProperties} className={`cu-event-dot ${selected || isAnchor ? "selected" : ""} ${repeat ? "attention" : ""}`} onClick={() => select(members.map(m => m.event_id))} onKeyDown={ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(members.map(m => m.event_id)); } }}>
        <title>{members.map(m => `${offset(m.time_us, start)} ${eventNames[m.event_type]} ${m.event_id}`).join("\n")}</title>
        {h && (value.mode === "handoff" || selected || isAnchor) && visibleRoles.includes(h.target_role) && <line x1={xx} x2={xx} y1={yy} y2={y(h.target_role)} stroke="#b17a29" strokeWidth={2} markerEnd={`url(#handoff-${detail.run.run_id})`}/>}
        <circle cx={xx} cy={yy} r={members.length > 1 ? 10 : 7}/>{isAnchor && <circle cx={xx} cy={yy} r={14} fill="none"/>}
        {members.length > 1 && <text x={xx} y={yy + 4} textAnchor="middle" className="cu-dot-count">{members.length}</text>}
        {!timeMode && <text x={xx} y={yy - 19 - index % 2 * 14} className="cu-event-label" textAnchor="middle">{value.mode === "handoff" ? `#${index + 1}${repeat ? ` 同方向第${h!.direction_ordinal}次` : ""}` : `${eventNames[e.event_type]}${e.version != null ? ` v${e.version}` : ""}`}</text>}
        {!timeMode && <text x={xx} y={visibleRoles.length * 58 + 75} className="cu-axis-text" textAnchor="middle">{offset(e.time_us, start)}</text>}
      </g>; })}
    </svg></div>
    <p className="cu-note" data-testid="trajectory-counts">完整运行 {p.events.length} 条 · 当前窗口与可见类型覆盖 {visible.length} 条 · {grouped.length} 个事件标记 · {shownCalls.length} 个调用区间。区间与事件计数分开；点击聚合标记可逐条阅读。</p>
    {value.members.length > 1 && <div className="cu-actions"><button onClick={() => { const es = p.events.filter(e => value.members.includes(e.event_id)), a = Math.min(...es.map(relative)), b = Math.max(...es.map(relative)); updateWindow([Math.max(0, a - .1), Math.min(duration, b + .1)]); }}>放大选中时段</button>{!timeOnly && <button onClick={() => set({ mode: "order", all: true })}>按操作顺序展开</button>}</div>}
    {value.mode === "handoff" && <div className="cu-handoff-notes"><b>交接 {p.audit.handoff.total} 次 · 同方向重复 {p.audit.handoff.repeated_pair_count} 次 · 回返线索 {p.audit.handoff.loops.length} 组</b><p className="cu-note">重复和回返是线索，正常审核修订也可能回返；箭头不表示目标已执行成功。</p>{p.audit.handoff.loops.map((l, i) => <button key={i} onClick={() => select(l.event_ids)}>回返：{l.path.join(" → ")}</button>)}</div>}
  </div>;
}
