import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchCapabilities, fetchEvents, fetchMc2Actors, fetchOverview, fetchTrace, fetchTraceRoots, searchFiles, type Capabilities, type EventPage } from "../../data/api";
import { EMPTY_FILTERS, type Filters } from "../../data/filterContext";
import type { DatasetId } from "../../state/workspace";
import referenceCss from "../mc1/reference/style.css?inline";
import themeCss from "../mc1/reference/theme.css?inline";
import css from "./migrated/style.css?inline";
import { Activity, type CellSelection } from "./migrated/Activity";
import { SourceTrace } from "./migrated/SourceTrace";
import { Reader } from "./migrated/Reader";
import { actor, EventRow, inputTime, number, RequestStatus, time, useRequest, type ReaderTarget } from "./migrated/shared";

export function Mc2MigratedPage({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    if (host.current) setShadow(host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" }));
    const previous = document.documentElement.style.scrollbarGutter;
    document.documentElement.style.scrollbarGutter = "stable";
    return () => { document.documentElement.style.scrollbarGutter = previous; };
  }, []);
  return <div ref={host} data-testid="mc2-reference" style={{ minHeight: "100vh", background: "#f5f7fa" }}>{shadow && createPortal(<><style>{referenceCss}{themeCss}{css}</style><Mc2Workspace onDatasetChange={onDatasetChange}/></>, shadow)}</div>;
}

function Mc2Workspace({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  const startup = useRequest("mc2-startup", async signal => {
    const [capabilities, roots, actors] = await Promise.all([fetchCapabilities("MC2", signal), fetchTraceRoots(signal), fetchMc2Actors(signal)]);
    return { capabilities, roots, actors };
  });
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS });
  const [selected, setSelected] = useState<CellSelection | null>(null);
  const [granularity, setGranularity] = useState<"day" | "hour">("day");
  const [rootId, setRootId] = useState("");
  const [reader, setReader] = useState<ReaderTarget | null>(null);
  const [readerFilters, setReaderFilters] = useState<Filters>(filters);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const roots = startup.data?.roots.items ?? [];
  const root = roots.find(item => item.event_id === rootId) ?? roots[0];
  const overview = useRequest(JSON.stringify(["mc2-overview", filters, granularity]), signal => fetchOverview("MC2", { filters, granularity }, signal));
  const trace = useRequest(JSON.stringify(["mc2-trace", root?.event_id, filters]), signal => root ? fetchTrace({ rootEventId: root.event_id, filters, maxEvents: 100 }, signal) : Promise.resolve(null));
  const open = (target: ReaderTarget, trigger: HTMLButtonElement) => {
    returnFocus.current = trigger;
    setReaderFilters(trigger.closest(".mc2-record-list") ? recordFilters : filters);
    setReader(target);
  };
  const close = () => { setReader(null); returnFocus.current?.focus(); };
  const apply = (next: Filters) => { setSelected(null); setFilters(next); };
  const recordFilters: Filters = selected ? { ...filters, categories: [selected.category], startUs: Math.max(selected.start, filters.startUs ?? selected.start), endUs: Math.min(selected.end, filters.endUs ?? selected.end) } : filters;
  const cap = startup.data?.capabilities;
  return <div className="app mc2-app" data-testid="mc2-page">
    <header className="compact-header"><div><h1>MC2 · 来源与活动调查</h1><p>从发布记录追踪来源文件，再沿时间查看相关活动。</p></div><nav className="workspace-nav" aria-label="数据集切换"><button onClick={() => onDatasetChange("MC1")}>MC1</button><span className="nav-current" aria-current="page">MC2</span><button onClick={() => onDatasetChange("CUSTOM")}>CUSTOM</button><a href="?mc2=legacy">旧版 MC2 / 扩展工具</a></nav></header>
    <div className="global-controls"><span className="gc-label">调查范围</span><span className="mc2-scope" data-testid="mc2-scope">{filters.startUs == null ? "数据起点" : time(filters.startUs)} → {filters.endUs == null ? "数据终点" : time(filters.endUs)}{filters.categories.length ? ` · 类别 ${cap?.categories.find(item => item.id === filters.categories[0])?.label ?? filters.categories[0]}` : ""}{filters.actorId ? ` · ${actor(filters.actorId)}` : ""}{filters.eventTypes.length ? ` · ${filters.eventTypes.join("、")}` : ""}{filters.keyword ? ` · 关键词「${filters.keyword}」` : ""}</span><span className="gc-counts">全库 <b>{cap ? number(cap.event_count) : "…"}</b> 条记录 · 时间统一 UTC</span></div>
    <RequestStatus {...startup}/>
    <div className="section mc2-layout">
      <aside className="filter-panel" aria-label="MC2 筛选区">
        <div className="fp-title">筛选活动与记录</div>
        {cap && <FilterForm capabilities={cap} actors={startup.data!.actors} filters={filters} apply={apply}/>}
        <FileSearch open={open}/>
        <p className="mc2-note">来源链中的发布锚点始终保留；文件操作、活动图与主列表使用同一筛选。高级比较等工具保留在旧版入口。</p>
      </aside>
      <main className="mc2-main">
        <section className="mc2-card mc2-source-card" aria-labelledby="mc2-source-title"><div className="mc2-card-head"><h2 id="mc2-source-title">来源链</h2><label className="mc2-root-label">发布锚点<select aria-label="发布锚点" value={root?.event_id ?? ""} onChange={e => setRootId(e.target.value)}>{roots.map(item => <option key={item.event_id} value={item.event_id}>{item.file_path} · {time(item.time_us)}</option>)}</select></label></div>
          <p className="mc2-note">{startup.data?.roots.note ?? "正在查找日志明确引用来源文件的发布记录…"}</p>
          <div className="mc2-source-body">
          <RequestStatus {...trace}/>
          {trace.error?.includes("root_outside_window") && root && <button className="mc2-primary" onClick={() => apply({ ...filters, startUs: filters.startUs == null ? null : Math.min(filters.startUs, root.time_us), endUs: filters.endUs == null ? null : Math.max(filters.endUs, root.time_us + 1e6) })}>扩展时间范围，包含此发布锚点</button>}
          {trace.data && <SourceTrace trace={trace.data} types={cap?.types ?? []} open={open}/>}
          {!startup.loading && !roots.length && <p className="mc2-empty">没有明确引用来源文件的发布记录，仍可在活动图和记录列表中调查。</p>}
          </div>
        </section>
        <section className="mc2-card mc2-activity-card" aria-labelledby="mc2-activity-title"><div className="mc2-card-head"><h2 id="mc2-activity-title">活动概览</h2><label className="mc2-inline-label">时间粒度<select aria-label="时间粒度" value={granularity} onChange={e => { setSelected(null); setGranularity(e.target.value as "day" | "hour"); }}><option value="day">按天</option><option value="hour">按小时</option></select></label></div><div className="mc2-activity-body"><RequestStatus {...overview}/>
          {overview.data && <Activity overview={overview.data} enabledCategories={filters.categories} selected={selected} onSelect={setSelected}/>}
          </div>
        </section>
        <section className="mc2-card" aria-labelledby="mc2-records-title"><div className="mc2-card-head"><h2 id="mc2-records-title">记录列表</h2>{selected && <button onClick={() => setSelected(null)}>清除格子选择</button>}</div>
          <p className="mc2-note" data-testid="mc2-list-scope">{selected ? `${selected.label} · ${time(recordFilters.startUs)} 至 ${time(recordFilters.endUs)}（不含终点）` : "当前筛选内的全部记录"} · 点击记录打开独立阅读窗口</p>
          <RecordList key={JSON.stringify(recordFilters)} filters={recordFilters} capabilities={cap} open={open}/>
        </section>
      </main>
    </div>
    {reader && <Reader initial={reader} filters={readerFilters} types={cap?.types ?? []} close={close} filterActor={id => { close(); apply({ ...filters, actorId: id }); }}/>}
  </div>;
}

function FilterForm({ capabilities: cap, actors, filters, apply }: { capabilities: Capabilities; actors: { entity_id: string; label: string | null }[]; filters: Filters; apply: (filters: Filters) => void }) {
  // Remount the form on applied-context changes (including actor drill-in and reset).
  return <FilterFields key={JSON.stringify(filters)} cap={cap} actors={actors} filters={filters} apply={apply}/>;
}
function FilterFields({ cap, actors, filters, apply }: { cap: Capabilities; actors: { entity_id: string; label: string | null }[]; filters: Filters; apply: (filters: Filters) => void }) {
  const [draft, setDraft] = useState(filters);
  const [start, setStart] = useState(inputTime(filters.startUs));
  const [end, setEnd] = useState(inputTime(filters.endUs));
  const [error, setError] = useState("");
  return <form className="mc2-filter-form" onSubmit={e => {
    e.preventDefault();
    const startUs = start ? Date.parse(`${start}Z`) * 1000 : null;
    const endUs = end ? Date.parse(`${end}Z`) * 1000 : null;
    if ((startUs != null && !Number.isFinite(startUs)) || (endUs != null && !Number.isFinite(endUs)) || (startUs != null && endUs != null && startUs >= endUs)) { setError("结束时间必须晚于开始时间。"); return; }
    apply({ ...draft, startUs, endUs });
  }}>
    <label>开始时间 · UTC<input type="datetime-local" step="1" aria-label="开始时间 UTC" value={start} onChange={e => setStart(e.target.value)}/></label>
    <label>结束时间 · UTC（不含）<input type="datetime-local" step="1" aria-label="结束时间 UTC" value={end} onChange={e => setEnd(e.target.value)}/></label>
    <p className="mc2-note">留空表示数据全范围。<br/>{time(cap.start_us)}<br/>至 {time(cap.end_us)}</p>
    <label>活动类别<select aria-label="活动类别" value={draft.categories[0] ?? ""} onChange={e => setDraft({ ...draft, categories: e.target.value ? [Number(e.target.value)] : [], eventTypes: [] })}><option value="">全部类别</option>{cap.categories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
    <label>具体事件类型<select aria-label="具体事件类型" value={draft.eventTypes[0] ?? ""} onChange={e => setDraft({ ...draft, eventTypes: e.target.value ? [e.target.value] : [] })}><option value="">全部类型</option>{cap.types.filter(type => !draft.categories.length || draft.categories.includes(type.category)).map(type => <option key={type.type} value={type.type}>{type.display_label} · {type.type}</option>)}</select></label>
    <label>执行者 · {actors.length} 位<select aria-label="执行者" value={draft.actorId ?? ""} onChange={e => setDraft({ ...draft, actorId: e.target.value || null })}><option value="">全部执行者</option>{actors.map(item => <option key={item.entity_id} value={item.entity_id}>{item.label ?? actor(item.entity_id)}</option>)}</select></label>
    <label>记录关键词<input type="text" aria-label="记录关键词" placeholder="检索记录中的文本" value={draft.keyword} onChange={e => setDraft({ ...draft, keyword: e.target.value })}/></label>
    {error && <p role="alert" className="mc2-warning">{error}</p>}
    <button className="mc2-primary" type="submit">应用筛选</button><button type="button" onClick={() => apply({ ...EMPTY_FILTERS })}>清空全部筛选</button>
  </form>;
}

function FileSearch({ open }: { open: (target: ReaderTarget, trigger: HTMLButtonElement) => void }) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const files = useRequest(JSON.stringify(["mc2-files", query]), signal => query ? searchFiles(query, signal) : Promise.resolve(null));
  return <section className="mc2-file-search"><h3>查找文件</h3><form onSubmit={e => { e.preventDefault(); setQuery(draft.trim()); }}><label>文件名或路径<input type="text" aria-label="文件名或路径" placeholder="例如 SwiftWren" value={draft} onChange={e => setDraft(e.target.value)}/></label><button type="submit" disabled={!draft.trim()}>查找文件</button></form>{query && <><RequestStatus {...files}/><p className="mc2-note">全历史检索，最多列出 20 个文件；打开后轨迹沿用主页面筛选。</p><div className="mc2-file-results">{files.data?.items.map(file => <button key={file.file_id} onClick={e => open({ kind: "file", id: file.file_id }, e.currentTarget)}>{file.path}{file.exact ? " · 精确匹配" : ""}</button>)}{files.data && !files.data.items.length && <p className="mc2-empty">未找到匹配文件。</p>}</div></>}</section>;
}

function RecordList({ filters, capabilities, open }: { filters: Filters; capabilities?: Capabilities; open: (target: ReaderTarget, trigger: HTMLButtonElement) => void }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const list = useRef<HTMLDivElement>(null);
  const cursor = cursors[cursors.length - 1];
  const events = useRequest<EventPage>(JSON.stringify([filters, cursor, direction]), signal => fetchEvents({ dataset: "MC2", filters, limit: 40, cursor, direction }, signal));
  const move = (next?: string) => { if (list.current) list.current.scrollTop = 0; setCursors(items => next ? [...items, next] : items.slice(0, -1)); };
  return <>
    <div className="mc2-list-toolbar"><span role="status">{events.data ? `匹配 ${number(events.data.meta.matched_events)} 条 · 第 ${cursors.length} 页` : "正在统计匹配记录…"}</span><label className="mc2-inline-label">排序<select aria-label="记录排序" value={direction} onChange={e => { setDirection(e.target.value as "asc" | "desc"); setCursors([null]); if (list.current) list.current.scrollTop = 0; }}><option value="asc">时间正序</option><option value="desc">时间倒序</option></select></label></div>
    <div className="mc2-record-list" ref={list} tabIndex={0} aria-label="调查记录列表"><RequestStatus {...events}/>{events.data?.items.map(event => <EventRow key={event.event_id} event={event} types={capabilities?.types ?? []} open={open}/>)}{events.data && !events.data.items.length && <p className="mc2-empty">没有符合条件的记录。请清除格子选择或调整左侧筛选。</p>}</div>
    <div className="mc2-pagination"><button disabled={events.loading || cursors.length === 1} onClick={() => move()}>上一页</button><span>每页最多 40 条</span><button disabled={events.loading || !events.data?.next_cursor} onClick={() => move(events.data!.next_cursor!)}>下一页</button></div>
  </>;
}
