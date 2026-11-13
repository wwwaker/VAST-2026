import { ArrowRight } from "lucide-react";
import { RoleLabel } from "./RoleLabel";
import { MessageMetadata } from "../../mc1/reference/components/MessageMetadata";
import { eventNames, offset, statusNames, tone, summary, type Detail, type EvidenceEvent, type Attempt } from "./customApi";

export function Status({ value, label }: { value: string; label?: string }) { return <span className={`cu-chip ${tone(value)}`}>{label && `${label}：`}{statusNames[value] ?? value}</span>; }
export function RecordCards({ detail, ids, read, locate }: { detail: Detail; ids: string[]; read: (id: string, trigger: HTMLElement) => void; locate?: (id: string) => void }) {
  return <div className="cu-records">{ids.map(id => { const e = detail.projection.events.find(x => x.event_id === id); return e ? <article key={id} className="message cu-record"><button className="cu-record-open" onClick={ev => read(id, ev.currentTarget)}><MessageMetadata number={id.slice(0, 8)} timestamp={offset(e.time_us, detail.run.start_us)}><span className="cu-chip"><RoleLabel role={e.role}/></span><span>{eventNames[e.event_type] ?? e.event_type}</span></MessageMetadata><p>{eventText(e)}</p><small>阅读原始记录<ArrowRight size={13} aria-hidden="true"/></small></button>{locate && <button className="cu-text-button" onClick={() => locate(id)}>在轨迹定位</button>}</article> : <p key={id} className="cu-note">引用未找到：{id}</p>; })}</div>;
}
export function eventText(e: EvidenceEvent) {
  const d = e.details;
  if (e.event_type === "workflow_route") return `controller 流程选用 v${d.selected_version ?? "?"}，记录期望 v${d.expected_version ?? "?"}`;
  if (e.event_type === "task_handoff") return `${e.role} → ${e.target_id?.split(":").at(-1) ?? "未知目标"} · ${d.purpose ?? "任务交接"}`;
  if (e.event_type === "review_decision") return `${d.approved === true ? "批准" : d.approved === false ? "拒绝" : "未知"} v${e.version} · ${d.feedback ?? "未提供意见"}`;
  if (e.event_type === "agent_message") return "调用结果摘要元数据；日志未附完整模型输出。";
  return String(d.reason ?? d.purpose ?? d.title ?? d.path ?? (e.version != null ? `v${e.version} · ${d.status ?? eventNames[e.event_type]}` : d.status ?? eventNames[e.event_type] ?? e.event_type));
}
export function EvidenceInspector({ detail, attempt, selected, ids, read, locate }: { detail: Detail; attempt?: Attempt; selected: string | null; ids?: string[]; read: (id: string, trigger: HTMLElement) => void; locate: (id: string) => void }) {
  const p = detail.projection, node = p.nodes.find(n => n.id === selected), edge = p.edges.find(e => e.id === selected);
  const versionRefs = node?.kind === "version" ? [...new Set([...node.source_event_ids, ...p.edges.filter(e => e.source === node.id && e.relation !== "修订").flatMap(e => e.source_event_ids)])] : undefined;
  const refs = ids ?? versionRefs ?? node?.source_event_ids ?? edge?.source_event_ids ?? (attempt ? [...new Set([...attempt.review.evidence_event_ids, ...attempt.version_check.evidence_event_ids, ...attempt.publish.evidence_event_ids])] : []);
  return <aside className="cu-inspector" aria-label="选中证据说明"><h3>{ids ? `${ids.length} 条选中记录` : node?.label ?? edge?.relation ?? "本次尝试的完整证据"}</h3>
    {edge && <><p>{edge.recorded ? "明确记录关联" : "规则派生关联"}</p><code>{edge.field}</code><p className="cu-note">线的方向表示该字段所指的记录关系，布局列不证明全部操作依次发生。</p></>}
    {node?.kind === "route" && <p>controller 记录选用 v{String(node.details.selected_version ?? "?")}，期望 v{String(node.details.expected_version ?? "?")}。这不表示模型主动选择了旧版。</p>}
    {node?.kind === "version" && <><p>文档版本 v{node.version}</p><p className="cu-note cu-break">{node.hash}</p><button className="cu-text-button" onClick={async e => { const button = e.currentTarget; try { await navigator.clipboard.writeText(node.hash ?? ""); button.textContent = "已复制哈希"; } catch { button.textContent = "复制失败，请选取上方哈希"; } }}>复制完整哈希</button><p className="cu-note">{node.content?.exists ? "正文文件可定位" : "正文未随数据包提供"}</p></>}
    {attempt && <><p className="cu-note">{summary(attempt)}</p><dl className="cu-checks">{[["审核凭证", attempt.review], ["版本时点", attempt.version_check], ["本地结果", attempt.publish]].map(([title, rule]) => { const r = rule as Attempt["review"]; return <div key={String(title)}><dt>{String(title)} <Status value={r.status}/></dt><dd>{r.reason}</dd></div>; })}<div><dt>发布者读取 <Status value={attempt.version_check.read_status ?? "unknown"}/></dt><dd>{attempt.version_check.read_reason}</dd></div><div><dt>模型判断</dt><dd>{attempt.model_suitable === true ? "model_suitable=true" : attempt.model_suitable === false ? "model_suitable=false" : "未提供"}</dd></div><div><dt>实际复制版本</dt><dd>{attempt.publish.status === "conflict" ? "证据冲突，不能确定" : attempt.publish.actual_version != null ? `v${attempt.publish.actual_version}` : attempt.publish.copy_status === "not_copied" ? "未复制" : "无法核对"}</dd></div></dl></>}
    {node && node.kind !== "version" && <details><summary>对象字段</summary><pre>{JSON.stringify(node.details, null, 2)}</pre></details>}
    <h4>可回查记录 · {refs.length}</h4><RecordCards detail={detail} ids={refs} read={read} locate={locate}/>
    <details><summary>数据、规则与覆盖依据</summary><p className="cu-break">数据：{p.data_version}</p><p>规则：{p.rules_version}</p><p>事件 {p.coverage.returned_events}/{p.coverage.expected_events}；{p.coverage.complete ? "事件与引用完整" : "覆盖或引用不足"}</p><p>正文 {p.content_availability.version_bodies}/{p.content_availability.versions}；调用附件 {p.content_availability.call_attachments}/{p.content_availability.referenced_call_attachments}</p></details>
  </aside>;
}
