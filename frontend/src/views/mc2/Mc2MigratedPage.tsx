import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchCapabilities, fetchDatasets, fetchMc2Actors, fetchTraceRoots, type EventItem, type TypeInfo } from "../../data/api";
import { EMPTY_FILTERS, describeFilters, type Filters } from "../../data/filterContext";
import type { DatasetId } from "../../state/workspace";
import referenceCss from "../mc1/reference/style.css?inline";
import themeCss from "../mc1/reference/theme.css?inline";
import css from "./migrated/style.css?inline";
import workspaceCss from "./migrated/workspace.css?inline";
import { ViewControls } from "../mc1/reference/components/ViewControls";
import { Reader } from "./migrated/Reader";
import { actor, displayId, number, PendingRegion, RequestStatus, time, typeLabel, useRequest, type ReaderTarget } from "./migrated/shared";
import { TimeRange } from "./migrated/TimeRange";
import { ActivityOverview } from "./migrated/ActivityOverview";
import { RelationCanvas, RelationMatrix } from "./migrated/RelationCanvas";
import { FilterPanel, ObjectFacets, EvidenceList, HistoricalComparison } from "./migrated/Panels";
import { LocalProcess, eventFromItem, type ProcessSelection } from "./migrated/LocalProcess";
import { narrowed, query, relationName, scopeParams, type ActivityData, type Edge, type Evidence, type RelationData, type Scope, type Selection } from "./migrated/workspaceApi";

export function Mc2MigratedPage({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    if (host.current) setShadow(host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" }));
    const previous = document.documentElement.style.scrollbarGutter;
    document.documentElement.style.scrollbarGutter = "stable";
    return () => { document.documentElement.style.scrollbarGutter = previous; };
  }, []);
  return <div ref={host} data-testid="mc2-reference" style={{ minHeight: "100vh", background: "#f5f7fa" }}>{shadow && createPortal(<><style>{referenceCss}{themeCss}{css}{workspaceCss}</style><Mc2Workspace onDatasetChange={onDatasetChange} /></>, shadow)}</div>;
}

type Mode = "types" | "system" | "relay" | "operations" | "compare";
type Investigation = { filters: Filters; selected: Selection | null; day: Selection | null; fileId?: string; noFile?: boolean; mode: Mode; relation?: string; edge?: Edge; process: ProcessSelection | null; collapsed: boolean; representation: "matrix" | "graph" };
const initial = (): Investigation => ({ filters: { ...EMPTY_FILTERS }, selected: null, day: null, mode: "types", process: null, collapsed: false, representation: "graph" });

function Mc2Workspace({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  const startup = useRequest("mc2-startup", async signal => {
    const [cap, roots, actors, datasets] = await Promise.all([fetchCapabilities("MC2", signal), fetchTraceRoots(signal), fetchMc2Actors(signal), fetchDatasets(signal)]);
    const target = datasets.find(d => d.dataset_id === "MC2")?.anchors.find(a => a.key === "target_post");
    return { cap, roots: roots.items, actors, root: roots.items.find(r => r.time_us === target?.time_us) };
  });
  const [state, setState] = useState<Investigation>(initial), [granularity, setGranularity] = useState("day"), [filtersOpen, setFiltersOpen] = useState(true);
  const [visible, setVisible] = useState({ activity: true, relations: true, process: true, evidence: true });
  const [sideBySide, setSideBySide] = useState(false);
  const history = useRef<{ state: Investigation; scroll: number; granularity: string }[]>([]);
  const [historySize, setHistorySize] = useState(0);
  const recordCache = useRef(new Map<string, { cursors: (string | null)[]; direction: string; scroll: number }>());
  const relationSection = useRef<HTMLElement>(null), processSection = useRef<HTMLElement>(null);
  const [reader, setReader] = useState<{ target: ReaderTarget; filters: Filters } | null>(null);
  const returnFocus = useRef<HTMLElement | SVGElement | null>(null);
  const [notice, setNotice] = useState("");
  const matrixCache = useRef(new Map<string, { sort: string; row: number; column: number }>());
  const overviewScroll = useRef(new Map<string, number>());
  const layoutCache = useRef(new Map<string, { positions: Map<string, { x: number; y: number }>; zoom?: number; pan?: { x: number; y: number } }>());
  const baseFilters = narrowed(narrowed(state.filters, state.selected), state.day);
  const relationScope: Scope = { filters: baseFilters, fileId: state.fileId, noFile: state.noFile };
  const scope: Scope = { ...relationScope, ...(state.edge ? { relation: state.edge.relation, source: state.edge.source, target: state.edge.target, action: state.edge.action } : {}) };
  const transition = (next: Investigation, message = "") => { history.current.push({ state, scroll: window.scrollY, granularity }); setHistorySize(history.current.length); setState(next); setNotice(message); };
  const back = () => { const prev = history.current.pop(); if (prev) { setState(prev.state); setGranularity(prev.granularity); setHistorySize(history.current.length); setNotice("已恢复上一步调查范围与选择"); requestAnimationFrame(() => window.scrollTo({ top: prev.scroll })); } };
  const chooseFile = (id: string) => { const tasks = state.selected?.type === "queue_subordinate_task" || state.filters.eventTypes.includes("queue_subordinate_task"); transition({ ...state, fileId: id, noFile: false, mode: tasks ? "relay" : "operations", relation: undefined, edge: undefined, representation: tasks ? "matrix" : "graph" }, "已按当前范围查看文件；任务与操作可在此切换。"); };
  const chooseCell = (selected: Selection | null) => {
    const type = selected?.type ?? "";
    const relation = type === "queue_subordinate_task" ? "queue_target_agent" : type === "sent" || type === "send_email" ? "mail_recipient" : type === "received" ? "mail_sender" : type.includes("file") ? "file_path" : type.includes("post") ? "post_content_source" : undefined;
    transition({ ...state, selected, fileId: undefined, noFile: false, edge: undefined, mode: selected ? "system" : "types", relation, representation: selected ? "matrix" : "graph" }, selected ? "关系调查已更新" : "已清除类型选择");
  };
  const chooseDay = (day: Selection | null) => transition({ ...state, day, fileId: undefined, noFile: false, edge: undefined }, day ? `已筛选 ${day.label}；顶部时间窗口保持不变` : "已清除单日选择");
  const apply = (filters: Filters) => { setGranularity("day"); transition({ ...state, filters, selected: null, day: null, fileId: undefined, noFile: false, edge: undefined, mode: "types", relation: undefined }, "已应用调查范围；未固定的局部过程将重新验证。"); };
  const showProcess = (item: EventItem) => { transition({ ...state, process: eventFromItem(item, scope) }); setVisible(v => ({ ...v, process: true })); requestAnimationFrame(() => processSection.current?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const shortcut = (id: string, us: number) => {
    setVisible(v => ({ ...v, process: true }));
    setGranularity("day");
    const filters = { ...EMPTY_FILTERS, startUs: us - 60e6, endUs: us + 60e6 + 1 };
    transition({ ...state, filters, selected: null, day: null, fileId: undefined, noFile: false, mode: "system", relation: "queue_target_agent", edge: undefined,
      collapsed: true, representation: "matrix", process: { anchor: id, anchorTime: us, scope: { filters, action: "saidit_post" }, seconds: 60, context: true, expand: false, pinned: false } }, "已定位发布并建立前后60秒参与上下文，包含入向任务；可返回撤销。");
    requestAnimationFrame(() => processSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const processScope = state.process && !state.edge && !state.selected && !state.fileId && !state.noFile && state.process.scope.action ? { ...scope, action: state.process.scope.action } : scope;
  const open = (target: ReaderTarget, trigger: HTMLElement | SVGElement) => { returnFocus.current = trigger; setReader({ target, filters: baseFilters }); };
  const close = () => { setReader(null); requestAnimationFrame(() => returnFocus.current?.isConnected ? returnFocus.current.focus() : relationSection.current?.focus()); };
  const activityParams = { ...scopeParams({ filters: state.filters }), granularity };
  const activity = useRequest(JSON.stringify(activityParams), signal => query<ActivityData>("activity", activityParams, signal));
  const relationParams = { ...scopeParams(relationScope), mode: state.mode === "compare" ? "system" : state.mode, relation: state.relation };
  const relations = useRequest(JSON.stringify(relationParams), signal => state.mode === "compare" ? Promise.resolve(null) : query<RelationData>("relations", relationParams, signal));
  const timeline = useRequest("mc2-timeline", signal => query<ActivityData>("activity", { granularity: "day" }, signal));
  const changeTime = (filters: Filters) => {
    if (granularity === "hour" && ((filters.endUs ?? timeline.data?.coverage.end ?? 0) - (filters.startUs ?? timeline.data?.coverage.start ?? 0)) > 240 * 3600e6) setGranularity("day");
    transition({ ...state, filters, day: null, edge: undefined }, "调查时间已更新");
  };
  const cap = startup.data?.cap;
  const parentCountParams = scopeParams({ filters: baseFilters });
  const counts = useRequest(JSON.stringify(["count", parentCountParams]), signal => query<Evidence>("evidence", parentCountParams, signal));
  const fileLabel = state.fileId?.replace("MC2:file_path:", "");
  const scopeLabel = state.edge ? `${relationName[state.edge.relation]} · ${actor(state.edge.source)} → ${actor(state.edge.target)}` : state.fileId ? `文件：${fileLabel}` : state.noFile ? "无明确文件关联" : state.selected ? `${state.selected.label} · 当前时间轴范围` : "当前全局筛选";
  return <div className="app mc2-app w-app" data-testid="mc2-page">
    <header className="compact-header"><div><h1>MC2 · 系统活动调查</h1><p>从活动与明确关系进入局部过程，逐条核对原始证据。</p></div><nav className="workspace-nav"><button onClick={() => onDatasetChange("MC1")}>MC1</button><span className="nav-current">MC2</span><button onClick={() => onDatasetChange("CUSTOM")}>CUSTOM</button><a href="?mc2=legacy">旧版 MC2 / 扩展工具</a></nav></header>
    <ViewControls views={([
      ["activity", "活动分布"], ["relations", "关系调查"], ["process", "局部过程"], ["evidence", "证据记录"],
    ] as const).map(([id, label]) => ({ id, label, checked: visible[id], change: (value: boolean) => setVisible(previous => ({ ...previous, [id]: value })) }))}>
      <button className={`fp-toggle gc-compare-toggle ${sideBySide ? "on" : ""}`} aria-pressed={sideBySide} onClick={() => setSideBySide(value => !value)}>◧ 并排对比{sideBySide ? "：已开启" : ""}</button>
      <button className="fp-toggle gc-filters-toggle" disabled={sideBySide} onClick={() => setFiltersOpen(value => !value)}>{filtersOpen && !sideBySide ? "隐藏筛选" : "显示筛选"}</button>
      <button className="fp-toggle" disabled={!historySize} onClick={back}>← 返回上一步</button>
      <button className="fp-toggle gc-clear-filters" onClick={() => { setGranularity("day"); transition(initial(), "已恢复全范围"); }}>恢复全范围</button>
      <div className="gc-counts">全库 <b>{cap ? number(cap.event_count) : "…"}</b> 条 · UTC</div>
    </ViewControls>
    <RequestStatus {...startup} />
    <RequestStatus {...timeline}/><PendingRegion {...timeline} minimum={90}>{timeline.data && <TimeRange data={timeline.data} filters={state.filters} change={changeTime} granularity={granularity} setGranularity={setGranularity}/>}</PendingRegion>
    <div className={`section mc2-layout w-layout ${!filtersOpen || sideBySide ? "filters-hidden" : ""}`}><aside hidden={!filtersOpen || sideBySide} className="filter-panel w-filters-open" aria-label="MC2 筛选区">{cap && <FilterPanel cap={cap} actors={startup.data!.actors} filters={state.filters} apply={apply} file={chooseFile} shortcut={shortcut} roots={startup.data!.roots} root={startup.data!.root} />}</aside>
      <main className={`mc2-main ${sideBySide ? "w-main-parallel" : ""}`}>
        <p className="mc2-note w-current-scope" title={displayId(describeFilters(state.filters))}>调查范围：{displayId(describeFilters(state.filters))}{state.day && ` → ${state.day.label}`}{state.selected && ` → ${state.selected.label}`}{state.fileId && ` → ${fileLabel}`}{state.noFile && " → 无明确文件关联"}</p>
        <section hidden={!visible.activity} className="mc2-card mc2-activity-card"><div className="mc2-card-head"><div><span className="w-kicker">01 / 活动分布</span><h2>活动概览</h2></div><div className="w-head-actions"><button aria-expanded={!state.collapsed} onClick={() => setState(s => ({ ...s, collapsed: !s.collapsed }))}>{state.collapsed ? "展开24类型" : "收起概览"}</button></div></div>
          <p className="mc2-note">当前筛选 {!activity.loading && !activity.error && activity.data ? number(activity.data.meta.matched_events) : "…"} 条记录 · 顶部时间轴设置全局窗口；点击数量柱临时筛选一天，类型名称或格子选择事件类型。</p><RequestStatus {...activity} />
          <PendingRegion {...activity} minimum={state.collapsed ? 110 : 660}>{activity.data && <ActivityOverview data={activity.data} selected={state.selected} choose={chooseCell} day={state.day} chooseDay={chooseDay} collapsed={state.collapsed} anchorTime={state.process?.anchorTime} scrollCache={overviewScroll.current} />}</PendingRegion>
          {(state.selected || state.day || notice) && <div className="w-selection-notice" role="status"><span>{notice || "当前选择"}{state.selected && ` · ${state.selected.label} · ${!counts.loading && !counts.error && counts.data ? number(counts.data.meta.matched_events) : "…"} 条`}</span><button onClick={() => { setVisible(v => ({ ...v, relations: true })); requestAnimationFrame(() => relationSection.current?.scrollIntoView({ behavior: "smooth", block: "start" })); }}>查看关系 ↓</button>{state.selected && <button onClick={() => chooseCell(null)}>清除类型选择</button>}{state.day && <button onClick={() => chooseDay(null)}>清除单日选择</button>}</div>}
        </section>
        <section hidden={!visible.relations} className="mc2-card w-relation-section" ref={relationSection} tabIndex={-1}><div className="mc2-card-head"><div><span className="w-kicker">02 / 明确对象关系</span><h2>关系调查</h2></div>{state.fileId && <button onClick={e => open({ kind: "file", id: state.fileId! }, e.currentTarget)}>阅读当前文件</button>}</div>
          <div className="w-tabs w-mode-tabs">{([["types", "交互类型概览"], ["system", "具体角色关系"], ["relay", "文件任务"], ["operations", "文件操作"], ["compare", "有明确来源的发布实例比较"]] as [Mode, string][]).map(([id, label]) => <button key={id} aria-pressed={state.mode === id} disabled={(id === "relay" || id === "operations") && !state.fileId} onClick={() => transition({ ...state, mode: id, edge: undefined, representation: id === "types" || id === "operations" ? "graph" : "matrix" })}>{label}</button>)}</div>
          {state.fileId && <p className="w-context-title">{fileLabel} <button onClick={() => transition({ ...state, fileId: undefined, noFile: false, edge: undefined, mode: "system" })}>清除文件选择</button></p>}
          {state.noFile && <p className="w-context-title">无明确文件关联的事件 <button onClick={() => transition({ ...state, noFile: false, edge: undefined })}>返回上级集合</button></p>}
          {state.mode === "compare" ? <HistoricalComparison anchorTime={state.process?.anchorTime} open={open} types={cap?.types ?? []} /> : <><RequestStatus {...relations} /><PendingRegion {...relations} minimum={520}>{relations.data && <>
            <div className="w-relation-summary" data-testid="relation-summary"><b>当前 {number(relations.data.meta.matched_events)} 条事件</b><span>可映射 {number(relations.data.mapped_events)} 条 · 当前关系未覆盖 {number(relations.data.unmapped_events)} 条 · 缺失发起者 {number(relations.data.missing_source_events)} 条</span></div>
            {state.mode === "system" && <label className="w-relation-picker">关系角色<select aria-label="关系角色" value={relations.data.selected_relations[0] ?? ""} onChange={e => transition({ ...state, relation: e.target.value, edge: undefined })}>{relations.data.relation_counts.map(r => <option key={r.relation} value={r.relation}>{r.label} · {number(r.count)} 条</option>)}</select></label>}
            <div className="w-relation-body"><div className="w-relation-main"><div className="w-tabs w-representation"><button aria-pressed={state.representation === "graph"} onClick={() => setState(s => ({ ...s, representation: "graph" }))}>关系图</button><button aria-pressed={state.representation === "matrix"} onClick={() => setState(s => ({ ...s, representation: "matrix" }))}>关系矩阵</button><span className="mc2-note">全部 {relations.data.edges.length} 个带类型组合</span></div>
              {relations.data.edges.length ? state.representation === "graph" ? <RelationCanvas data={relations.data} cache={layoutCache.current} viewKey={`${state.mode}:${state.fileId ?? ''}:${relations.data.selected_relations.join(',')}`} selected={state.edge} onEdge={edge => { if (state.mode === "types") transition({ ...state, mode: "system", relation: edge.relation, representation: "matrix", edge: undefined }); else transition({ ...state, edge }); }} onNode={id => setNotice(`已突出 ${actor(id)} 的一跳关系；点击边可查事件。`)} /> : <RelationMatrix cache={matrixCache.current} viewKey={JSON.stringify(relationParams)} data={relations.data} selected={state.edge} onEdge={edge => state.mode === "types" ? transition({ ...state, mode: "system", relation: edge.relation, edge: undefined }) : transition({ ...state, edge })} /> : <p className="mc2-empty">{relations.data.needs_file ? "此类活动涉及文件。请在对象分布中直接选文件，再查看文件任务或文件操作；不铺开所有文件节点。" : "当前范围没有此类明确关系。事件仍保留在证据列表，可换关系角色或调整范围。"}</p>}
              <p className="mc2-note">{state.mode === "types" ? "类型组用于理解交互类别；点边直接进入该关系的具体端点。文件保持聚合，不展开全量文件。" : state.mode === "relay" ? "只表示向目标排入涉及此文件的任务，不代表读取成功、完成或传播。" : state.mode === "operations" ? "箭头统一表示执行者对文件实施动作或引用；不同动作分别查证。" : "方向按关系角色解释；邮件发件角色不等于一次新的发送。不同角色边不可直接相加为总事件数。"}</p>
            </div><aside className="w-inspector">{state.edge ? <RelationInspector key={JSON.stringify(scope)} scope={scope} edge={state.edge} clear={() => transition({ ...state, edge: undefined })} process={showProcess} open={open} types={cap?.types ?? []} /> : <p className="mc2-note">点关系边或矩阵格，查看这一组事件的时间分布，再选一次进入局部过程。</p>}<ObjectFacets key={JSON.stringify(baseFilters)} scope={relationScope} chooseFile={chooseFile} noFile={() => transition({ ...state, noFile: true, fileId: undefined, mode: "system", edge: undefined, representation: "matrix" })} participant={id => apply({ ...state.filters, startUs: baseFilters.startUs, endUs: baseFilters.endUs, participantId: id })} /></aside></div>
          </>}</PendingRegion></>}
        </section>
        <section hidden={!visible.process} className={`mc2-card w-process-section ${state.process ? "has-process" : ""}`} ref={processSection}><div className="mc2-card-head"><div><span className="w-kicker">03 / 单次活动前后</span><h2>局部过程</h2></div>{state.process && <button onClick={() => transition({ ...state, process: null })}>关闭过程</button>}</div>{state.process ? <LocalProcess value={state.process} currentScope={processScope} update={process => transition({ ...state, process })} open={open} types={cap?.types ?? []} /> : <p className="mc2-note">从关系、记录的“查看过程”，或左侧异常快捷入口选择一次事件。这里按真实时间显示参与者活动与入向任务。</p>}</section>
        <section hidden={!visible.evidence} className="mc2-card w-evidence-section"><div className="mc2-card-head"><div><span className="w-kicker">04 / 原始证据</span><h2>证据记录</h2></div>{state.edge && <button onClick={() => transition({ ...state, edge: undefined })}>返回对象范围</button>}</div><p className="mc2-note" data-testid="mc2-list-scope">驱动选择：{scopeLabel}{state.day && ` · ${state.day.label}`}。局部过程的上下文记录在过程区查看，此列表跟随当前对象／关系。</p><EvidenceList key={JSON.stringify(scope)} scope={scope} cache={recordCache.current} types={cap?.types ?? []} open={open} process={showProcess} /></section>
      </main>
    </div>{reader && <Reader initial={reader.target} filters={reader.filters} types={cap?.types ?? []} close={close} filterActor={id => { close(); apply({ ...state.filters, actorId: id }); }} />}
  </div>;
}

function RelationInspector({ scope, edge, clear, process, open, types }: { scope: Scope; edge: Edge; clear: () => void; process: (e: EventItem) => void; open: (t: ReaderTarget, trigger: HTMLButtonElement) => void; types: TypeInfo[] }) {
  const [cursor, setCursor] = useState<(string | null)[]>([null]);
  const [bucket, setBucket] = useState<{ start: number; end: number } | null>(null);
  const params = { ...scopeParams(scope), distribution: "true" };
  const distribution = useRequest(JSON.stringify(params), s => query<Evidence>("evidence", params, s));
  const filteredScope = bucket ? { ...scope, filters: { ...scope.filters, startUs: Math.max(scope.filters.startUs ?? bucket.start, bucket.start), endUs: Math.min(scope.filters.endUs ?? bucket.end, bucket.end) } } : scope;
  const pageParams = { ...scopeParams(filteredScope), cursor: cursor.at(-1) ?? undefined };
  const page = useRequest(JSON.stringify(pageParams), s => cursor.length > 1 || bucket ? query<Evidence>("evidence", pageParams, s) : Promise.resolve(null));
  const data = cursor.length > 1 || bucket ? page : distribution;
  const items = data.data?.items ?? [];
  const timeline = distribution.data?.timeline ?? [];
  const first = timeline[0]?.start ?? edge.first_us, last = timeline.at(-1)?.end ?? edge.last_us + 1;
  const peak = Math.max(1, ...timeline.map(b => b.count));
  return <section className="w-edge-inspector"><h3>选中关系事件</h3><p>{relationName[edge.relation]} · {typeLabel(edge.action, types)}</p><p className="mc2-note">{actor(edge.source)} → {actor(edge.target)}</p><b>{edge.count} 条不同事件</b><p className="mc2-note">{time(edge.first_us)} 至 {time(edge.last_us)}</p><button onClick={clear}>清除关系选择</button><RequestStatus {...distribution} /><svg viewBox="0 0 260 65" role="img" aria-label="完整关系事件时间分布">{timeline.map(b => <g key={b.start} onClick={() => { setBucket(b); setCursor([null]); }} role="button" tabIndex={0} aria-label={`${time(b.start)} ${b.count} 条关系记录`} onKeyDown={k => { if (k.key === "Enter") { setBucket(b); setCursor([null]); } }} style={{ cursor: "pointer" }}><title>{time(b.start)} 至 {time(b.end)} · {b.count} 条</title><rect x={8 + (b.start - first) / (last - first) * 242} y={52 - b.count / peak * 42} width={Math.max(4, (b.end - b.start) / (last - first) * 242 - 1)} height={b.count / peak * 42} fill={bucket?.start === b.start ? "#d58c27" : "#377db8"} /></g>)}</svg><p className="mc2-note">时间图统计全部 {edge.count} 条，点击时间桶列出记录。</p>{bucket && <div className="w-notice">桶内 {data.data?.meta.matched_events ?? "…"} 条 <button onClick={() => { setBucket(null); setCursor([null]); }}>全部时间</button></div>}<RequestStatus {...data} /><PendingRegion {...data} minimum={185}><div className="w-edge-events">{items.map(e => <div key={e.event_id}><time>{time(e.time_us)}</time><button onClick={() => process(e)}>查看过程 · {e.event_id.split(":").at(-1)}</button><button onClick={b => open({ kind: "event", id: e.event_id }, b.currentTarget)}>阅读</button></div>)}</div></PendingRegion><div className="mc2-pagination"><button disabled={cursor.length < 2} onClick={() => setCursor(a => a.slice(0, -1))}>前页</button><span>第 {cursor.length} 页</span><button disabled={!data.data?.next_cursor} onClick={() => setCursor(a => [...a, data.data!.next_cursor!])}>后页</button></div></section>;
}
