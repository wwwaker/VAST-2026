import type { TracePayload, TypeInfo } from "../../../data/api";
import { actor, number, time, typeLabel, type ReaderTarget } from "./shared";

export function SourceTrace({ trace, types, open }: { trace: TracePayload; types: TypeInfo[]; open: (target: ReaderTarget, trigger: HTMLButtonElement) => void }) {
  const root = trace.nodes.find(node => node.role === "root");
  const files = trace.nodes.filter(node => node.role === "file");
  const operations = trace.nodes.filter(node => node.role === "file_operation").sort((a, b) => (a.time_us ?? 0) - (b.time_us ?? 0));
  return <>
    <p className="mc2-note">发布记录作为固定锚点；文件操作按当前筛选展示。箭头表示日志中的引用关系，时间顺序见各条记录。</p>
    <div className="mc2-trace-lanes">
      <section className="mc2-trace-lane"><h3>① 发布锚点</h3>{root && <button className="mc2-node root" onClick={e => open({ kind: "event", id: root.id }, e.currentTarget)}>
        <b>{typeLabel(root.event_type ?? "", types)}</b><span>{root.actor_label ?? actor(root.actor_id)}</span><time>{time(root.time_us)}</time><small>{root.id}</small><span>阅读发布记录 →</span>
      </button>}</section>
      <div className="mc2-connector" aria-label="显式来源引用">→<small>来源引用</small></div>
      <section className="mc2-trace-lane"><h3>② 内容来源文件</h3>{files.map(file => <button className="mc2-node file" key={file.id} onClick={e => open({ kind: "file", id: file.id }, e.currentTarget)}>
        <b>{file.path ?? file.label}</b><span>{trace.files.find(info => info.file_id === file.id)?.content_status === "available" ? "有可定位的正文字段" : "仅元数据 · 未提供文件正文"}</span><small>post_content_source · 日志明确记录</small><span>阅读文件轨迹 →</span>
      </button>)}</section>
      <div className="mc2-connector" aria-label="文件关联操作">→<small>关联操作</small></div>
      <section className="mc2-trace-lane"><h3>③ 文件操作 <small>{operations.length} 条</small></h3><div className="mc2-operations" tabIndex={0} aria-label="按时间排列的文件操作">
        {operations.map(node => <button className="mc2-operation" key={node.id} onClick={e => open({ kind: "event", id: node.id }, e.currentTarget)}><b>{typeLabel(node.event_type ?? "", types)}</b><span>{node.actor_label ?? actor(node.actor_id)}</span><time>{time(node.time_us)}</time></button>)}
        {!operations.length && <p className="mc2-empty">当前筛选没有关联操作，发布锚点仍保留。</p>}
      </div></section>
    </div>
    {trace.budget.truncated && <p className="mc2-warning">来源图最多展示 {trace.budget.events} 条操作，当前已达上限；打开文件轨迹可继续翻页。</p>}
    <div className="mc2-candidates"><b>候选线索 · 仅同名前缀</b><p>以下文件尚无证据连到上面的内容文件。点击可独立核查其记录。</p>
      {trace.candidates.map(file => <button key={file.file_id} onClick={e => open({ kind: "file", id: file.file_id }, e.currentTarget)}>{file.path} <span>· 全历史接力记录 {number(file.relay_event_count)} 条 →</span></button>)}
      {!trace.candidates.length && <span>没有同名前缀候选文件。</span>}
    </div>
    <details className="mc2-edge-details"><summary>查看引用依据（{trace.recorded_edge_count} 条记录关系）</summary>{trace.edges.filter(edge => edge.provenanceKind === "recorded").map(edge => <div key={edge.id}><code>{edge.relation}</code><p>{edge.explanation}</p>{edge.evidenceEventIds.map(id => <button key={id} onClick={e => open({ kind: "event", id }, e.currentTarget)}>{id} →</button>)}</div>)}</details>
  </>;
}
