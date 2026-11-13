import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DatasetId } from "../../../state/workspace";
import { WorkspaceHeader } from "../../shared/WorkspaceHeader";
import { ViewControls } from "../../mc1/reference/components/ViewControls";
import { useRequest, PendingRegion, RequestStatus } from "../../shared/request";
import { get, loadRun, fixture, scenarioNames, short, seconds, type Run, type Case, type Detail } from "./customApi";
import { initialState, emptyTrajectory, type Investigation } from "./customState";
import { emptyFilters, matching, FilterSidebar, CoverageIndex, RunGroupTable, type CollectionView } from "./Collection";
import { VersionEvidenceGraph } from "./VersionEvidenceGraph";
import { EvidenceInspector, RecordCards, Status } from "./EvidenceInspector";
import { RunTrajectory, useContainerWidth } from "./RunTrajectory";
import { CustomEvidenceReader } from "./CustomEvidenceReader";
import { RunPairComparison } from "./RunPairComparison";

export function CustomWorkspace({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  const [state, setState] = useState(initialState), [filters, setFilters] = useState(emptyFilters), [search, setSearch] = useState("");
  const [collectionView, setCollectionView] = useState<CollectionView>({ metric: "duration", selected: null });
  const [filtersOpen, setFiltersOpen] = useState(true), [coverageVisible, setCoverageVisible] = useState(true), [recordsVisible, setRecordsVisible] = useState(false);
  const [notice, setNotice] = useState(""); const [historyCount, setHistoryCount] = useState(0);
  const history = useRef<Investigation[]>([]); const restoreScroll = useRef<number | null>(null); const trigger = useRef<HTMLElement | null>(null); const heading = useRef<HTMLHeadingElement>(null);
  const [reader, setReader] = useState<{ detail: Detail; id: string } | null>(null);
  const catalog = useRequest("custom-catalog", async signal => { const [runs, cases] = await Promise.all([get<{ meta: { data_version: string; truncated: boolean; matched_runs_total: number }; items: Run[] }>("/api/runs?dataset=CUSTOM&limit=500", signal), get<{ items: Case[] }>("/api/cases?dataset=CUSTOM", signal)]); return { ...runs, cases: cases.items }; });
  const detail = useRequest(state.run ?? "no-run", signal => state.run ? loadRun(state.run, signal) : Promise.resolve(null));
  const runs = catalog.data?.items ?? [], cases = catalog.data?.cases ?? [];
  const data = !detail.loading && !detail.error && detail.data?.run.run_id === state.run ? detail.data : null;
  const activeRun = runs.find(r => r.run_id === state.run);
  const filtered = runs.filter(r => matching(r, { ...filters, search }));
  const { host: mainHost, width: mainWidth } = useContainerWidth();
  const attempt = data?.projection.audit.attempts.find(a => a.attempt_event_id === state.attempt) ?? data?.projection.audit.attempts.at(-1);
  const update = (patch: Partial<Investigation>) => setState(s => ({ ...s, ...patch }));
  const transition = (next: Investigation) => { history.current.push({ ...state, scroll: window.scrollY }); setHistoryCount(history.current.length); restoreScroll.current = next.scroll; setState(next); };
  const back = () => { const previous = history.current.pop(); setHistoryCount(history.current.length); restoreScroll.current = previous?.scroll ?? 0; setState(previous ?? { ...initialState(), run: null, view: "collection", baseline: null }); };
  const openRun = (run: string, trajectory = false) => { setNotice("通过运行或案例入口打开；集合筛选已保留。"); transition({ ...state, run, view: "run", baseline: null, attempt: null, selected: null, tab: trajectory ? "trajectory" : "version", trajectory: { ...emptyTrajectory(), mode: trajectory ? "handoff" : "time" }, scroll: 0 }); };
  const compare = (r: Run) => { if (!r.normal_run_id) return; transition({ ...state, run: r.run_id, view: "compare", baseline: r.normal_run_id, comparisonTab: "version", comparisonWindow: null, scroll: 0 }); };
  const locate = (id: string) => { if (!data) return; const e = data.projection.events.find(e => e.event_id === id); if (!e) return; const sec = (e.time_us - (data.run.start_us ?? e.time_us)) / 1e6, end = (data.run.duration_us ?? 0) / 1e6; update({ tab: "trajectory", trajectory: { ...state.trajectory, mode: "time", all: true, types: null, roles: null, anchor: id, members: [id], window: [Math.max(0, sec - 2), Math.min(end, sec + 2)] } }); };
  const read = (d: Detail, id: string, element: HTMLElement) => { trigger.current = element; setReader({ detail: d, id }); };
  const closeReader = () => { setReader(null); requestAnimationFrame(() => trigger.current?.isConnected ? trigger.current.focus() : heading.current?.focus()); };
  useEffect(() => { const timer = setTimeout(() => setSearch(filters.search), 300); return () => clearTimeout(timer); }, [filters.search]);
  useEffect(() => { const url = new URL(window.location.href); url.searchParams.set("custom", "reference"); for (const key of ["run", "baseline", "tab"]) url.searchParams.delete(key); if (state.run) { url.searchParams.set("run", state.run); url.searchParams.set("tab", state.tab); if (state.view === "compare" && state.baseline) url.searchParams.set("baseline", state.baseline); } window.history.replaceState(null, "", url); }, [state.run, state.view, state.tab, state.baseline]);
  useEffect(() => { if (restoreScroll.current == null || detail.loading) return; const value = restoreScroll.current; restoreScroll.current = null; requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: value }))); }, [state.view, state.run, detail.loading]);
  const ready = catalog.data && !catalog.loading && !catalog.error;
  return <div className="app cu-app workspace-shell" data-testid="custom-page"><WorkspaceHeader title="CUSTOM · 工作流运行调查" description="比较同条件运行，核对版本、审核和本地复制证据。" dataset="CUSTOM" change={onDatasetChange}/>
    <ViewControls views={state.view === "collection" ? [{ id: "coverage", label: "采集概览", checked: coverageVisible, change: setCoverageVisible }] : state.view === "run" ? [{ id: "records", label: "相关原始记录", checked: recordsVisible, change: setRecordsVisible }] : []}>
      <button className="fp-toggle gc-filters-toggle" disabled={state.view === "compare"} onClick={() => setFiltersOpen(v => !v)}>{filtersOpen ? "隐藏筛选" : "显示筛选"}</button><button className="fp-toggle" disabled={!historyCount && state.view === "collection"} onClick={back}><ArrowLeft size={15} aria-hidden="true"/>返回上一步</button><button className="fp-toggle gc-clear-filters" onClick={() => { setFilters(emptyFilters()); setSearch(""); setNotice("已恢复集合筛选；单运行与轨迹审计不变。"); }}>恢复集合筛选</button><span className="gc-counts">{ready ? `${runs.length} 次运行 · ${runs.reduce((n, r) => n + r.event_count, 0).toLocaleString()} 条事件` : "载入运行…"}</span>
    </ViewControls>
    <RequestStatus {...catalog}/>{notice && <div className="cu-notice" role="status">{notice}<button aria-label="关闭提示" className="cu-text-button" onClick={() => setNotice("")}>×</button></div>}
    <PendingRegion {...catalog} minimum={600}>{ready && <div className={`cu-layout ${!filtersOpen || state.view === "compare" ? "filters-hidden" : ""}`}><aside className="filter-panel cu-filters" hidden={!filtersOpen || state.view === "compare"} aria-label="运行筛选与案例"><div className="fp-title">运行筛选</div><div className="fp-body"><FilterSidebar runs={runs} filters={filters} change={setFilters} cases={cases} open={openRun} activeRun={activeRun} mode={state.view}/></div></aside>
      <main ref={mainHost} className="cu-main">
        {state.view === "collection" ? <>
          <p className="cu-scope" data-testid="collection-count">当前匹配 <b>{filtered.length}</b> / 批次 {runs.length} 次 · {new Set(runs.map(r => `${r.model}:${r.fixture}`)).size} 个已采集组合 · 各指标使用统一批次尺度</p>
          {catalog.data!.meta.truncated ? <div className="cu-empty">运行集合返回不完整，已停止本地筛选。请缩小服务端范围后重试。</div> : <>
            <section hidden={!coverageVisible} className="heatmap-card cu-panel cu-coverage-panel"><div className="cu-panel-head"><div><h2>采集概览</h2></div><span className="cu-note">同模型、同任务的四条件耗时概览</span></div><CoverageIndex runs={runs} filters={filters} change={setFilters} notice={setNotice}/></section>
            <section className="heatmap-card cu-panel"><div className="cu-panel-head"><div><h2>四条件运行对照</h2></div></div><RunGroupTable runs={runs} filtered={filtered} filters={filters} change={setFilters} open={openRun} compare={compare} view={collectionView} setView={setCollectionView}/></section>
          </>}
        </> : <>
          <div className="cu-run-nav"><button onClick={back}><ArrowLeft size={15} aria-hidden="true"/>{state.view === "compare" ? "返回原调查" : "返回运行集合 / 上次调查"}</button><span className="cu-note">{state.run ? short(state.run) : ""}</span>{activeRun?.normal_run_id && state.view === "run" && <button onClick={() => compare(activeRun)}>与同组 normal 比较</button>}{activeRun?.scenario === "normal" && state.view === "run" && <label>选择同组条件比较<select aria-label="normal选择条件比较" value="" onChange={e => { const r = runs.find(r => r.run_id === e.target.value); if (r) compare(r); }}><option value="">选择另一条件</option>{runs.filter(r => r.model === activeRun.model && r.fixture === activeRun.fixture && r.scenario !== "normal").map(r => <option key={r.run_id} value={r.run_id}>{scenarioNames[r.scenario ?? ""]}</option>)}</select></label>}</div>
          <RequestStatus {...detail}/><PendingRegion {...detail} minimum={680}>{data && <>
            <section className="heatmap-card cu-panel cu-run-summary"><h2>{data.run.model} <span>· {fixture(data.run.fixture)} · {scenarioNames[data.run.scenario ?? ""]}</span></h2><div className="cu-summary-metrics"><span>运行 <b>{seconds(data.run.duration_us)}</b></span><span>调用 <b>{data.projection.calls.length}</b></span><span>版本 <b>{data.projection.versions.length}</b></span><span>交接 <b>{data.projection.audit.handoff.total}</b></span><span className={data.projection.coverage.complete ? "" : "cu-danger-text"}>事件/引用：{data.projection.coverage.complete ? "完整" : "不足"} {data.projection.coverage.returned_events}/{data.projection.coverage.expected_events}</span><span>版本正文：{data.projection.content_availability.version_bodies}/{data.projection.content_availability.versions} · 调用附件：{data.projection.content_availability.call_attachments}/{data.projection.content_availability.referenced_call_attachments}</span></div><p className="cu-note">{filtered.some(r => r.run_id === state.run) ? "当前运行属于保留的集合筛选范围。" : "当前运行不在保留的集合筛选范围内；完整运行调查不受集合筛选影响。"}</p><div className="cu-status-strip">{attempt && <><Status value={attempt.review.status} label="审核"/><Status value={attempt.version_check.status} label="尝试版本"/><Status value={attempt.version_check.read_status ?? "unknown"} label="读取"/><Status value={attempt.publish.status} label="本地结果"/></>}<details><summary>来源标签</summary><p>实验条件：{data.run.scenario}；observed={String(data.run.observed)}。来源标签与独立字段核对并列，不能覆盖所有风险判断。</p></details></div></section>
            {state.view === "compare" && state.baseline ? <section className="heatmap-card cu-panel"><RunPairComparison key={`${data.run.run_id}:${state.baseline}`} detail={data} baselineId={state.baseline} state={state} update={update} read={read}/></section> : <section className="heatmap-card cu-panel"><div className="cu-investigation-toolbar"><div className="cu-tabs"><button aria-pressed={state.tab === "version"} onClick={() => update({ tab: "version" })}>版本与发布证据</button><button aria-pressed={state.tab === "trajectory"} onClick={() => update({ tab: "trajectory" })}>运行轨迹</button></div><label>发布尝试<select aria-label="发布尝试" value={attempt?.attempt_event_id ?? ""} onChange={e => update({ attempt: e.target.value, selected: e.target.value })}>{data.projection.audit.attempts.map((a, i) => <option key={a.attempt_event_id} value={a.attempt_event_id}>第 {i + 1}/{data.projection.audit.attempts.length} 次 · v{a.version}</option>)}</select></label></div>
              <div className={`cu-investigation-body ${mainWidth >= 1240 ? "with-inspector" : "inspector-below"}`}><div className="cu-plot"><div hidden={state.tab !== "version"}><VersionEvidenceGraph detail={data} attempt={attempt} selected={state.selected} select={selected => update({ selected })}/></div><div hidden={state.tab !== "trajectory"}><RunTrajectory key={data.run.run_id} detail={data} value={state.trajectory} change={trajectory => update({ trajectory })} select={ids => update({ trajectory: { ...state.trajectory, members: ids, anchor: ids.length === 1 ? ids[0] : state.trajectory.anchor } })}/></div></div><EvidenceInspector detail={data} attempt={attempt} selected={state.tab === "version" ? state.selected : null} ids={state.tab === "trajectory" ? state.trajectory.members : undefined} read={(id, el) => read(data, id, el)} locate={locate}/></div>
              <div hidden={!recordsVisible}><RelatedRecords key={data.run.run_id} detail={data} selected={state.selected} read={(id, el) => read(data, id, el)} locate={locate}/></div>
            </section>}
          </>}</PendingRegion>
        </>}
        <footer className="cu-footer">版本证据可核对不等于正文内容正确。所有结论来自记录与规则，缺失内容保持未知。</footer>
      </main>
    </div>}</PendingRegion>
    {reader && <CustomEvidenceReader detail={reader.detail} initial={reader.id} close={closeReader} filterRole={(role, id) => { const d = reader.detail; closeReader(); if (state.run !== d.run.run_id) openRun(d.run.run_id, true); setState(s => ({ ...s, view: "run", baseline: null, run: d.run.run_id, tab: "trajectory", trajectory: { ...emptyTrajectory(), all: true, roles: [role], anchor: id, members: [id] } })); }}/>}
  </div>;
}

function RelatedRecords({ detail, selected, read, locate }: { detail: Detail; selected: string | null; read: (id: string, el: HTMLElement) => void; locate: (id: string) => void }) {
  const [all, setAll] = useState(false), [page, setPage] = useState(0);
  const node = detail.projection.nodes.find(n => n.id === selected), edge = detail.projection.edges.find(e => e.id === selected);
  const related = node?.source_event_ids ?? edge?.source_event_ids ?? detail.projection.audit.attempts.flatMap(a => a.publish.evidence_event_ids);
  const ids = all ? detail.projection.events.map(e => e.event_id) : [...new Set(related)];
  return <section className="cu-related"><div className="cu-panel-head"><h3>原始记录</h3><label className="check"><input type="checkbox" checked={all} onChange={e => { setAll(e.target.checked); setPage(0); }}/>完整运行记录</label></div><p className="cu-note">{all ? "完整运行" : "当前图选择关联"} {ids.length} 条 · 本页 {page * 50 + 1}–{Math.min(ids.length, (page + 1) * 50)}</p><RecordCards detail={detail} ids={ids.slice(page * 50, page * 50 + 50)} read={read} locate={locate}/>{ids.length > 50 && <div className="cu-actions"><button disabled={!page} onClick={() => setPage(p => p - 1)}><ChevronLeft size={15} aria-hidden="true"/>前页</button><button disabled={(page + 1) * 50 >= ids.length} onClick={() => setPage(p => p + 1)}>后页<ChevronRight size={15} aria-hidden="true"/></button></div>}</section>;
}
