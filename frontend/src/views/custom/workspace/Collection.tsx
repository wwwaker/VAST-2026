import { ArrowRight } from "lucide-react";
import type { CSSProperties } from "react";
import { conditionVisuals, metricVisuals, taskVisual } from "./customVisuals";
import { MetricBars, barShade } from "../../shared/MetricBars";
import { Collapsible } from "../../mc1/reference/components/Collapsible";
import { scenarios, scenarioNames, fixture, short, seconds, statusNames, tone, type Run, type Case } from "./customApi";
import { Status } from "./EvidenceInspector";

export interface CollectionFilters { model: string; fixture: string; scenarios: string[]; review: string[]; version: string[]; result: string[]; handoff: boolean; coverage: string; search: string }
export const emptyFilters = (): CollectionFilters => ({ model: "", fixture: "", scenarios: [], review: [], version: [], result: [], handoff: false, coverage: "", search: "" });
export function matching(r: Run, f: CollectionFilters) {
  return (!f.model || r.model === f.model) && (!f.fixture || r.fixture === f.fixture) && (!f.scenarios.length || f.scenarios.includes(r.scenario ?? "")) && (!f.handoff || r.audit.repeated_handoff > 0) && (!f.coverage || (f.coverage === "complete") === r.coverage.complete) && (!f.search || `${r.run_id} ${r.model} ${r.fixture}`.toLowerCase().includes(f.search.toLowerCase())) && ((!f.review.length && !f.version.length && !f.result.length) || r.attempts.some(a => (!f.review.length || f.review.includes(a.review.status)) && (!f.version.length || f.version.includes(a.version_check.status)) && (!f.result.length || f.result.includes(a.publish.status))));
}
const recommended = ["custom-stale-published", "custom-bypass-review", "custom-normal-rework", "custom-valid-review-denied", "custom-repeated-handoff"];
const caseNames: Record<string, string> = { "custom-stale-published": "旧版复制成功", "custom-bypass-review": "无审核仍复制", "custom-normal-rework": "正常审核修订", "custom-valid-review-denied": "审核有效但拒绝", "custom-repeated-handoff": "重复交接" };

export function FilterSidebar({ runs, filters, change, cases, open, activeRun, mode }: { runs: Run[]; filters: CollectionFilters; change: (f: CollectionFilters) => void; cases: Case[]; open: (r: string, trajectory?: boolean) => void; activeRun?: Run; mode: string }) {
  const set = (p: Partial<CollectionFilters>) => change({ ...filters, ...p });
  const multi = (key: "scenarios" | "review" | "version" | "result", values: [string, string][]) => values.map(([value, name]) => <label className="check" key={value}><input type="checkbox" checked={filters[key].includes(value)} onChange={e => set({ [key]: e.target.checked ? [...filters[key], value] : filters[key].filter(v => v !== value) })}/>{name}</label>);
  return <>
    {mode !== "collection" && activeRun && <Collapsible title="同组四次运行">{scenarios.map(s => { const r = runs.find(r => r.model === activeRun.model && r.fixture === activeRun.fixture && r.scenario === s); return r ? <button className="cu-sidebar-run" key={s} aria-pressed={activeRun.run_id === r.run_id} onClick={() => open(r.run_id)}>{scenarioNames[s]}<small>{short(r.run_id)} · {seconds(r.duration_us)}</small></button> : <p key={s}>未采集：{scenarioNames[s]}</p>; })}</Collapsible>}
    <Collapsible title={mode === "collection" ? "运行集合筛选" : "保留的集合筛选"} defaultOpen={mode === "collection"}>
      <label>模型<select aria-label="集合模型" value={filters.model} onChange={e => set({ model: e.target.value })}><option value="">全部模型</option>{[...new Set(runs.map(r => r.model))].sort().map(m => <option key={m} value={m ?? ""}>{m}</option>)}</select></label>
      <label>输入任务<select aria-label="集合输入任务" value={filters.fixture} onChange={e => set({ fixture: e.target.value })}><option value="">全部任务</option>{[...new Set(runs.map(r => r.fixture))].sort().map(m => <option key={m} value={m ?? ""}>{taskVisual(m).label} ({fixture(m)})</option>)}</select></label>
      <label>搜索运行<input type="text" role="searchbox" aria-label="搜索运行集合" placeholder="运行 ID / 模型 / 任务" value={filters.search} onChange={e => set({ search: e.target.value })}/></label>
      <h4>实验条件</h4>{multi("scenarios", scenarios.map(s => [s, scenarioNames[s]]))}
      <Collapsible title="字段核对状态" defaultOpen={false}><h4>审核凭证</h4>{multi("review", [["valid", "有效"], ["invalid", "无效"], ["unknown", "无法核对"]])}<h4>尝试版本</h4>{multi("version", [["current", "当前版"], ["stale", "旧版"], ["conflict", "冲突"], ["unknown", "未知"]])}<h4>本地结果</h4>{multi("result", [["published_current", "复制成功 · 当前版"], ["published_stale", "复制成功 · 旧版"], ["denied", "拒绝"], ["failed", "失败"], ["conflict", "冲突"], ["unknown", "未知"]])}</Collapsible>
      <label className="check"><input type="checkbox" checked={filters.handoff} onChange={e => set({ handoff: e.target.checked })}/>有同方向重复交接</label><label>事件与引用覆盖<select aria-label="事件覆盖筛选" value={filters.coverage} onChange={e => set({ coverage: e.target.value })}><option value="">全部</option><option value="complete">完整</option><option value="incomplete">不足</option></select></label>
      <button onClick={() => change(emptyFilters())}>清除集合筛选</button>
    </Collapsible>
    <Collapsible title="真实案例入口">{recommended.map(id => { const c = cases.find(c => c.case_id === id); return <button key={id} className="cu-case-button" data-case={id} disabled={!c || c.status !== "ok"} title={c?.status !== "ok" ? `案例${c?.status ?? "载入中"}，不能替换为其他运行` : c.note} onClick={() => c && open(c.run_id, id === "custom-repeated-handoff")}>{caseNames[id]} <ArrowRight size={15} aria-hidden="true"/>{c && c.status !== "ok" && <small>{c.status}</small>}</button>; })}</Collapsible>
    <p className="cu-note">本地发布指复制到 published/notice.md。实验条件与来源标签不代替字段核对结果。</p>
  </>;
}

export function CoverageIndex({ runs, filters, change, notice }: { runs: Run[]; filters: CollectionFilters; change: (f: CollectionFilters) => void; notice: (s: string) => void }) {
  const models = [...new Set(runs.map(r => r.model))].sort(), fixtures = [...new Set(runs.map(r => r.fixture))].sort();
  const maximum = Math.max(1, ...runs.map(r => (r.duration_us ?? 0) / 1e6));
  const groups = models.flatMap(model => fixtures.map(task => ({ model, task, runs: runs.filter(r => r.model === model && r.fixture === task) })));
  return <div className="cu-coverage">
    <div className="cu-coverage-key">{scenarios.map(s => { const Icon = conditionVisuals[s].icon; return <span key={s} style={{ color: conditionVisuals[s].color }}><Icon size={13} aria-hidden="true"/>{scenarioNames[s]}</span>; })}<small>柱高与深浅表示耗时 · 统一 0–{maximum.toFixed(1)} s</small></div>
    <div className="cu-coverage-scroll"><table className="cu-coverage-matrix" aria-label="模型与输入任务耗时矩阵"><thead><tr><th scope="col">模型 / 输入任务</th>{fixtures.map(f => { const task = taskVisual(f), Icon = task.icon; return <th scope="col" key={f}><button className="cu-coverage-task" aria-pressed={filters.fixture === f} onClick={() => change({ ...filters, fixture: filters.fixture === f ? "" : f ?? "" })} title={`筛选输入任务：${f}`}><span className="cu-task-name"><Icon size={14} aria-hidden="true"/>{task.label}</span><small>{fixture(f)}.md</small></button></th>; })}</tr></thead><tbody>{models.map(model => <tr key={model}><th scope="row"><button className="cu-coverage-model" aria-pressed={filters.model === model} onClick={() => change({ ...filters, model: filters.model === model ? "" : model ?? "" })} title={`筛选模型：${model}`}>{model}</button></th>{fixtures.map(task => {
      const group = groups.find(g => g.model === model && g.task === task)!;
      const active = filters.model === model && filters.fixture === task;
      return <td key={task}>{!group.runs.length ? <button className="uncollected" onClick={() => notice(`${model} × ${fixture(task)} 未采集；当前筛选保持不变。`)}>未采集</button> : <button className={`cu-coverage-group ${active ? "selected" : ""}`} aria-pressed={active} aria-label={`${model} ${fixture(task)} ${group.runs.length}次运行，点击筛选同组`} onClick={() => change({ ...filters, model: active ? "" : model ?? "", fixture: active ? "" : task ?? "" })}>
        <svg viewBox="0 0 160 44" preserveAspectRatio="none" role="img" aria-label={`${model} ${fixture(task)} 四条件耗时柱图`}><path d="M4 40H156" stroke="#dce4ec"/>{scenarios.map((s, i) => {
          const r = group.runs.find(r => r.scenario === s), seconds = r?.duration_us == null ? null : r.duration_us / 1e6, ratio = (seconds ?? 0) / maximum, height = ratio * 34;
          return <g key={s} className="cu-coverage-bar" data-duration={seconds ?? "unknown"} data-scenario={s}><title>{scenarioNames[s]}：{!r ? "未采集" : seconds == null ? "耗时未知" : `${seconds.toFixed(3)} s`}</title>{seconds == null ? <text x={21 + i * 39} y={36} textAnchor="middle" fill="#8793a0" fontSize={12}>{r ? "?" : "–"}</text> : <rect x={7 + i * 39} y={40 - height} width={28} height={height} rx={2} fill={barShade(conditionVisuals[s].color, ratio)}/>}</g>;
        })}</svg>
      </button>}</td>;
    })}</tr>)}</tbody></table></div>
    <div className="cu-coverage-foot"><span>{groups.filter(g => g.runs.length).length}/{groups.length} 组已采集 · {runs.length} 次运行 · 点击模型或任务表头筛选，点击柱图选择交叉组合；再次点击取消</span></div>
  </div>;
}

const collectionMetrics = [
  { id: "duration", label: "运行耗时", unit: "s", value: (r: Run) => r.duration_us == null ? null : r.duration_us / 1e6 },
  { id: "calls", label: "调用次数", unit: "次", value: (r: Run) => r.call_count },
  { id: "versions", label: "版本数量", unit: "版", value: (r: Run) => r.version_count },
  { id: "handoffs", label: "同方向重复", unit: "次", value: (r: Run) => r.audit.repeated_handoff },
];

export interface CollectionView { metric: string; selected: string | null }
export function RunGroupTable({ runs, filtered, filters, change, open, compare, view, setView }: { runs: Run[]; filtered: Run[]; filters: CollectionFilters; change: (f: CollectionFilters) => void; open: (id: string) => void; compare: (r: Run) => void; view: CollectionView; setView: (view: CollectionView) => void }) {
  const metricId = view.metric, selected = view.selected;
  const setMetricId = (metric: string) => setView({ ...view, metric });
  const setSelected = (selected: string) => setView({ ...view, selected });
  const metric = collectionMetrics.find(m => m.id === metricId)!;
  const maximum = Math.max(1, ...runs.map(r => metric.value(r) ?? 0));
  const models = [...new Set(runs.map(r => r.model))].sort(), fixtures = [...new Set(runs.map(r => r.fixture))].sort();
  const chosen = filtered.find(r => r.run_id === selected);
  const format = (n: number) => `${metricId === "duration" ? n.toFixed(1) : n} ${metric.unit}`;
  if (!filtered.length) return <div className="cu-empty"><h3>当前筛选无匹配运行</h3><p>已保留采集覆盖，可逐项调整左侧筛选。</p><button onClick={() => change(emptyFilters())}>清除集合筛选</button></div>;
  return <div data-testid="run-groups">
    <div className="cu-matrix-tools"><div className="cu-tabs" aria-label="集合对照指标">{collectionMetrics.map(m => { const visual = metricVisuals[m.id as keyof typeof metricVisuals], Icon = visual.icon; return <button key={m.id} style={{ "--cu-accent": visual.color } as CSSProperties} aria-pressed={metricId === m.id} onClick={() => setMetricId(m.id)}><Icon size={14} aria-hidden="true"/>{m.label}</button>; })}</div><span className="cu-note">同列同条件 · 条长共用批次尺度 · 点格子查看，再打开调查</span></div>
    <div className="cu-run-matrix-scroll"><table className="cu-run-matrix" aria-label="同模型同任务四条件运行对照"><thead><tr><th>模型 / 输入任务</th>{scenarios.map(s => { const Icon = conditionVisuals[s].icon; return <th key={s}><span className="cu-condition-heading" style={{ color: conditionVisuals[s].color }}><Icon size={14} aria-hidden="true"/>{scenarioNames[s]}</span></th>; })}</tr></thead><tbody>{models.flatMap(m => fixtures.map(f => {
      const group = filtered.filter(r => r.model === m && r.fixture === f); if (!group.length) return null;
      const full = runs.filter(r => r.model === m && r.fixture === f);
      return <tr className="cu-run-group" key={`${m}:${f}`}><th scope="row"><strong>{m}</strong><span>{taskVisual(f).label}</span><small>{fixture(f)}.md · </small><small>匹配 {group.length}/{full.length}</small>{group.length < full.length && <button className="cu-text-button" onClick={() => change({ ...filters, model: m ?? "", fixture: f ?? "", scenarios: [], review: [], version: [], result: [], handoff: false, coverage: "", search: "" })}>显示同组全部条件</button>}</th>{scenarios.map(s => {
        const r = group.find(r => r.scenario === s);
        if (!r) return <td key={s} className="cu-matrix-absent">{full.some(r => r.scenario === s) ? "已被筛选隐藏" : "未采集"}</td>;
        const a = r.attempts.length === 1 ? r.attempts[0] : null;
        const checks = a ? [["审核凭证", a.review.status], ["尝试版本", a.version_check.status], ["本地结果", a.publish.status]] : [];
        return <td key={s}><button className={`cu-run-cell ${selected === r.run_id ? "selected" : ""}`} data-run={r.run_id} aria-pressed={selected === r.run_id} aria-label={`${m} ${fixture(f)} ${scenarioNames[s]}，${metric.label} ${metric.value(r) == null ? "未知" : format(metric.value(r)!)}`} onClick={() => setSelected(r.run_id)}>
          <MetricBars values={[{ label: metric.label, value: metric.value(r), color: conditionVisuals[s].color }]} maximum={maximum} format={format}/>
          <span className="cu-cell-checks">{checks.map(([label, state]) => <span key={label} className={tone(state)}><i/>{label}：{statusNames[state] ?? state}</span>)}{!a && <span>{r.attempts.length} 次发布尝试</span>}</span>
          <span className="cu-cell-counts"><span title="模型调用数">调用 {r.call_count}</span><span title="文档版本数">版本 {r.version_count}</span><span title="同任务同方向重复交接数">重复 {r.audit.repeated_handoff}</span>{!r.coverage.complete && <span>覆盖不足</span>}</span>
        </button></td>;
      })}</tr>;
    }))}</tbody></table></div>
    <div className="cu-matrix-selection" aria-live="polite">{chosen ? <><div><b>{chosen.model} · {fixture(chosen.fixture)} · {scenarioNames[chosen.scenario ?? ""]}</b><span>{short(chosen.run_id)} · {seconds(chosen.duration_us)} · {chosen.version_path.map((v, i) => `${i && v.previous_version === chosen.version_path[i - 1].version ? " → " : i ? " · " : ""}v${v.version}`).join("")}</span></div><div className="cu-cell-detail-checks">{chosen.attempts.length === 1 && <><Status value={chosen.attempts[0].review.status} label="审核"/><Status value={chosen.attempts[0].version_check.status}/><Status value={chosen.attempts[0].publish.status}/></>}</div><button onClick={() => open(chosen.run_id)}>打开运行<ArrowRight size={15} aria-hidden="true"/></button>{chosen.normal_run_id && <button onClick={() => compare(chosen)}>与 normal 比较</button>}</> : <span>点击任一运行格子查看独立状态，或从左侧案例直接进入调查。</span>}</div>
  </div>;
}
