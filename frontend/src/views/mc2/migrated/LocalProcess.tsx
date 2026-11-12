import { useEffect, useState } from "react";
import type { EventItem, TypeInfo } from "../../../data/api";
import { EMPTY_FILTERS } from "../../../data/filterContext";
import type { Evidence, ProcessData, ProcessItem, Scope } from "./workspaceApi";
import { query, scopeParams } from "./workspaceApi";
import { actor, categoryColors, displayId, number, PendingRegion, RequestStatus, time, typeLabel, useRequest, type ReaderTarget } from "./shared";

export type ProcessSelection = { anchor: string; anchorTime?: number; scope: Scope; context: boolean; expand: boolean; pinned: boolean; seconds: number };
type Open = (target: ReaderTarget, trigger: HTMLElement | SVGElement) => void;
export function LocalProcess({ value, currentScope, update, open, types }: { value: ProcessSelection; currentScope: Scope; update: (p: ProcessSelection) => void; open: Open; types: TypeInfo[] }) {
  const [expandedActors, setExpandedActors] = useState<string[]>([]);
  const [showAllLanes, setShowAllLanes] = useState(true);
  const [fitEvents, setFitEvents] = useState(true);
  const [detail, setDetail] = useState<ProcessItem | null>(null);
  useEffect(() => { setExpandedActors([]); setDetail(null); setShowAllLanes(true); }, [value.anchor]);
  const scope = value.pinned ? value.scope : currentScope;
  const params = { ...scopeParams(scope), anchor: value.anchor, seconds: value.seconds, context: String(value.context), expand: String(value.expand), actors: expandedActors.join(",") };
  const resource = useRequest(JSON.stringify(params), signal => query<ProcessData>("process", params, signal));
  const data = resource.data;
  const change = (extra: Partial<ProcessSelection>) => { setDetail(null); update({ ...value, ...extra }); };
  const lanes = data?.lanes ?? [];
  const visible = showAllLanes ? lanes : lanes.filter(n => data?.items.some(i => i.event_id === value.anchor && i.actor_id === n.id) || data?.links.some(l => l.source === n.id || l.target === n.id));
  const displayLanes = visible.length ? visible : lanes.slice(0, 1);
  const hidden = lanes.filter(n => !displayLanes.includes(n));
  const visibleItems = data?.items.filter(i => displayLanes.some(l => l.id === (i.actor_id ?? "__missing__"))) ?? [];
  const firstEvent = data?.items[0]?.time_us ?? 0, lastEvent = data?.items.at(-1)?.time_us ?? firstEvent;
  const padding = Math.max(1e6, (lastEvent - firstEvent) * .15);
  const plotStart = data ? fitEvents && data.items.length > 1 ? Math.max(data.start, firstEvent - padding) : data.start : 0;
  const plotEnd = data ? fitEvents && data.items.length > 1 ? Math.min(data.end, lastEvent + padding) : data.end : 1;
  return <>
    <div className="w-process-tools"><label>窗口<select aria-label="局部时间窗口" value={value.seconds} onChange={e => change({ seconds: Number(e.target.value) })}><option value="10">前后 10 秒</option><option value="60">前后 60 秒</option><option value="300">前后 5 分钟</option><option value="1500">前后 25 分钟</option><option value="3600">前后 1 小时</option></select></label>
      <label className="check"><input type="checkbox" checked={value.context} onChange={e => change({ context: e.target.checked })} />加入附近参与活动（含入向任务）</label>
      <label className="check"><input type="checkbox" checked={value.expand} onChange={e => change({ expand: e.target.checked })} />允许窗口超出父级范围</label>
      <label className="check"><input type="checkbox" checked={fitEvents} onChange={e => setFitEvents(e.target.checked)}/>图中聚焦实际活动</label>
      <button disabled={!data?.valid && !value.pinned} onClick={() => update({ ...value, pinned: !value.pinned, scope })}>{value.pinned ? "取消固定，跟随当前选择" : "固定此过程"}</button>
    </div>
    {value.pinned && <p className="w-notice">固定上下文，不随当前选择变化 · 锚点 {displayId(value.anchor)}</p>}
    <RequestStatus {...resource} />
    <PendingRegion {...resource} minimum={380}>{data && !data.valid && <div className="mc2-empty" data-testid="process-outside"><b>保留的锚点已超出当前选择</b><p>{displayId(value.anchor)} · {time(data.anchor_time)}</p><p>旧过程已停止作为当前结果展示。</p><button onClick={() => update({ ...value, scope: value.scope, pinned: true })}>查看原范围并固定</button></div>}
    {data?.valid && <>
      <p className="mc2-note" data-testid="process-summary">{time(data.start)} → {time(data.end)} · 主选 {data.main_count} 条 / 邻近上下文 {data.context_count} 条 / 合计 {number(data.total)} 条 · 当前 {visibleItems.length} 个标记，聚合覆盖 {visibleItems.reduce((n, i) => n + (i.aggregate_count ?? 1), 0)} 条 · 父级窗口外 {number(data.outside_main)} 条</p>
      {value.context && <p className="w-notice">已在此窗口放宽类型、关键词、文件与执行者限制，按锚点参与实体的执行/来源/目标角色补入活动。{data.note} 实心是当前选择，空心是补入的附近活动；橙色边框定位锚点。</p>}
      <p className="mc2-note">图中显示 {time(plotStart)} → {time(plotEnd)}；上方统计仍使用完整查询窗口。</p>
      <div className="w-timeline-scroll" tabIndex={0} aria-label="局部过程时间泳道"><svg width="100%" style={{ minWidth: 820 }} height={70 + displayLanes.length * 78} viewBox={`0 0 1050 ${70 + displayLanes.length * 78}`} role="img" aria-label="真实时间执行者泳道">
        <defs><marker id="mc2-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#9aafc3" /></marker></defs>
        {[0, .25, .5, .75, 1].map(f => <g key={f}><line x1={205 + f * 810} x2={205 + f * 810} y1="30" y2={50 + displayLanes.length * 78} stroke="#e4ebf2" /><text x={205 + f * 810} y="18" textAnchor="middle" fontSize="11" fill="#617187">{time(plotStart + f * (plotEnd - plotStart)).slice(11, 19)}</text></g>)}
        <line x1={205 + (data.anchor_time - plotStart) / (plotEnd - plotStart) * 810} x2={205 + (data.anchor_time - plotStart) / (plotEnd - plotStart) * 810} y1="28" y2={50 + displayLanes.length * 78} stroke="#d58c27" strokeDasharray="4 3" />
        {displayLanes.map((lane, i) => <g key={lane.id}><text x="10" y={64 + i * 78} fontSize="12" fill="#34516e"><title>{lane.id}</title>{displayId(lane.label?.slice(0, 25) ?? actor(lane.id))}</text><text x="10" y={81 + i * 78} fontSize="10" fill="#7c8fa3">{lane.entity_type === "agent" ? "智能体" : lane.entity_type === "person" ? "人员" : "缺失角色"}</text><line x1="205" x2="1015" y1={65 + i * 78} y2={65 + i * 78} stroke="#ccd9e5" /></g>)}
        {data.links.map(link => {
          const a = displayLanes.findIndex(l => l.id === link.source), b = displayLanes.findIndex(l => l.id === link.target);
          if (a < 0 || b < 0) return null;
          const x = 205 + (link.time_us - plotStart) / (plotEnd - plotStart) * 810;
          return <g key={`${link.event_id}:${link.target}`}><title>{link.event_id} · 记录中的任务目标，两端属于同一事件</title><line x1={x} x2={x} y1={65 + a * 78} y2={65 + b * 78} stroke="#9aafc3" strokeWidth="1.5" markerEnd="url(#mc2-arrow)" /><circle cx={x} cy={65 + b * 78} r="3" fill="white" stroke="#7195b6" /></g>;
        })}
        {data.items.map((item, idx) => {
          const lane = displayLanes.findIndex(l => l.id === (item.actor_id ?? "__missing__"));
          if (lane < 0) return null;
          const same = data.items.slice(0, idx).filter(i => i.actor_id === item.actor_id && Math.abs(i.time_us - item.time_us) / (plotEnd - plotStart) * 810 < 18).length;
          const x = 205 + (item.time_us - plotStart) / (plotEnd - plotStart) * 810, y = 65 + lane * 78 - (same % 3) * 15;
          const color = categoryColors[(item.category - 1) % categoryColors.length];
          const fill = item.context ? "white" : color, stroke = item.event_id === value.anchor ? "#d58c27" : color;
          const task = item.event_type === "queue_subordinate_task", post = item.event_type.includes("post"), file = item.files.length > 0 && !task && !post;
          return <g key={item.event_id} role="button" tabIndex={0} aria-label={`${displayId(item.event_id)} ${item.event_type} ${item.context ? '邻近上下文' : '主选'}`} onClick={e => { setDetail(item); if (!item.aggregate_count) open({ kind: "event", id: item.event_id }, e.currentTarget); }} onKeyDown={e => { if (e.key === "Enter") { setDetail(item); if (!item.aggregate_count) open({ kind: "event", id: item.event_id }, e.currentTarget); } }} style={{ cursor: "pointer" }}><title>{time(item.time_us)} · {typeLabel(item.event_type, types)}\n{displayId(item.event_id)}\n{item.files.map(f => f.replace("MC2:file_path:", "")).join("、")}\n{item.context ? "邻近活动，时间顺序不等于因果" : "当前主选记录"}{item.aggregate_count ? `\n聚合 ${item.aggregate_count} 条` : ""}</title>
            {task ? <path d={`M${x} ${y - 7}l7 7l-7 7l-7 -7z`} fill={fill} stroke={stroke} strokeWidth="2" /> : post ? <path d={`M${x} ${y - 8}l8 14h-16z`} fill={fill} stroke={stroke} strokeWidth="2" /> : file ? <rect x={x - 6} y={y - 6} width="12" height="12" fill={fill} stroke={stroke} strokeWidth="2" /> : <circle cx={x} cy={y} r="6" fill={fill} stroke={stroke} strokeWidth="2" />}
            {data.items.length <= 16 && <text x={x + 10} y={y - 10 - (idx % 2) * 12} fontSize="11" fill={color}>{typeLabel(item.event_type, types)}</text>}
            {item.aggregate_count && <text x={x + 8} y={y - 8} fontSize="10" fill="#34516e">×{item.aggregate_count}</text>}
          </g>;
        })}
      </svg></div>
      {hidden.length > 0 && <button onClick={() => setShowAllLanes(true)}>展开其他 {hidden.length} 个执行者泳道</button>}
      {showAllLanes && lanes.length > 2 && <button onClick={() => setShowAllLanes(false)}>聚焦锚点与明确任务参与者</button>}
      <p className="mc2-note">◇ 排队任务　△ 发布/校验　□ 文件操作　○ 其他活动 · 竖线为同条任务的目标角色；时间相邻不表示因果。每条横线对应一位执行者；点带文字的事件查看内容与证据。</p>
      {detail && <div className="w-event-inspector"><b>{typeLabel(detail.event_type, types)} · {time(detail.time_us)}</b><p>{detail.preview}</p><p className="mc2-note">{displayId(detail.event_id)} · {detail.context ? "邻近上下文" : "主选"}</p>{detail.aggregate_count ? <p className="mc2-note">此标记聚合 {detail.aggregate_count} 条；缩小窗口展开，以下为其中一条证据。</p> : null}<button onClick={e => open({ kind: "event", id: detail.event_id }, e.currentTarget)}>阅读原始记录</button>{detail.roles.filter(r => r.relation.startsWith("queue_target")).map(r => <button key={r.dst_id} onClick={() => setExpandedActors(a => [...new Set([...a, r.dst_id])])}>加入目标的附近参与活动 · {actor(r.dst_id)}</button>)}</div>}
      {detail?.aggregate_count && <AggregateRecords key={`${detail.actor_id}:${detail.bucket_start}`} item={detail} scope={scope} open={open} types={types} />}
      <section className="w-process-records"><h3>按时间阅读过程</h3><p className="mc2-note">只按记录时间排序；任务箭头表示同一事件的目标，不自动推断后续动作由它引起。</p>{data.total <= 1 && <div className="w-notice">当前窗口只找到锚点记录。可扩大窗口查找附近活动；没有记录的步骤不会自动补出。<button onClick={() => change({ seconds: Math.min(3600, Math.max(300, value.seconds * 5)), context: true })}>扩大窗口并查看参与活动</button></div>}
      <ol className="w-process-story">{data.items.slice(0, 80).map(item => <li key={item.event_id} className={item.event_id === value.anchor ? "is-anchor" : ""} style={{ borderLeftColor: categoryColors[(item.category - 1) % categoryColors.length] }}><div className="w-story-meta"><time>{time(item.time_us)}</time><span>{item.event_id === value.anchor ? "锚点" : item.context ? "附近活动" : "当前选择"}</span></div><b>{actor(item.actor_id)} · {typeLabel(item.event_type, types)}</b>{item.roles.filter(r => r.relation.startsWith("queue_target")).map(r => <p key={r.dst_id}>任务目标：{actor(r.dst_id)}（排入任务，不代表执行成功）</p>)}<p>{displayId(item.preview || "此条日志没有消息正文，可核对记录类型、时间及角色。")}</p>{item.aggregate_count && <p>此时间桶共 {item.aggregate_count} 条；点击图中标记展开。</p>}<button className="w-text-link" onClick={e => open({ kind: "event", id: item.event_id }, e.currentTarget)}>阅读记录 →</button></li>)}</ol>{data.items.length > 80 && <p>当前展开前80个标记，共{data.items.length}个；缩小窗口可逐条查看。</p>}</section>
    </>}</PendingRegion>
  </>;
}
export function eventFromItem(item: EventItem, scope: Scope): ProcessSelection { return { anchor: item.event_id, anchorTime: item.time_us, scope, seconds: 60, context: true, expand: false, pinned: false }; }

function AggregateRecords({ item, scope, open, types }: { item: ProcessItem; scope: Scope; open: Open; types: TypeInfo[] }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const filters = { ...(item.context ? EMPTY_FILTERS : scope.filters), startUs: item.bucket_start!, endUs: item.bucket_end!, actorId: item.actor_id };
  const params = { ...scopeParams(item.context ? { filters } : { ...scope, filters }), actor_missing: item.actor_id ? undefined : "true", cursor: cursors.at(-1) ?? undefined };
  const records = useRequest(JSON.stringify(params), s => query<Evidence>("evidence", params, s));
  return <section className="w-aggregate-records"><h3>展开该执行者的时间桶记录</h3><p className="mc2-note">{time(item.bucket_start)} → {time(item.bucket_end)} · {item.context ? "包含此执行者在桶内的主选与上下文" : "父级主选范围"} · 共 {records.data?.meta.matched_events ?? "…"} 条</p><RequestStatus {...records} /><div className="w-edge-events">{records.data?.items.map(e => <div key={e.event_id}><span>{typeLabel(e.event_type, types)} · {time(e.time_us)}</span><button onClick={b => open({ kind: "event", id: e.event_id }, b.currentTarget)}>{displayId(e.event_id)} →</button></div>)}</div><div className="mc2-pagination"><button disabled={cursors.length < 2} onClick={() => setCursors(c => c.slice(0, -1))}>上一页桶内记录</button><button disabled={!records.data?.next_cursor} onClick={() => setCursors(c => [...c, records.data!.next_cursor!])}>下一页桶内记录</button></div></section>;
}
