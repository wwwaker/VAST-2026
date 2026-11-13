import { ArrowRight } from "lucide-react";
import { RoleLabel } from "./RoleLabel";
import { useEffect, useRef, useState } from "react";
import { ReaderDialog } from "../../shared/ReaderDialog";
import { MessageMetadata } from "../../mc1/reference/components/MessageMetadata";
import { eventNames, utc, offset, short, type Detail } from "./customApi";
import { eventText } from "./EvidenceInspector";

export function CustomEvidenceReader({ detail, initial, close, filterRole }: { detail: Detail; initial: string; close: () => void; filterRole: (role: string, event: string) => void }) {
  const [history, setHistory] = useState([{ id: initial, scroll: 0 }]); const body = useRef<HTMLDivElement>(null);
  const current = history.at(-1)!;
  const event = detail.projection.events.find(e => e.event_id === current.id);
  const open = (id: string) => setHistory(previous => [...previous.slice(0, -1), { ...current, scroll: body.current?.scrollTop ?? 0 }, { id, scroll: 0 }]);
  useEffect(() => { if (body.current) { body.current.scrollTop = current.scroll; body.current.focus(); } }, [current]);
  const refs = event ? [...new Set([event.parent_event_id, ...["review_event_id", "read_event_id", "attempt_event_id"].map(k => event.details[k])].filter((x): x is string => typeof x === "string" && !!x))] : [];
  return <ReaderDialog title="阅读原始记录" subtitle={`${short(detail.run.run_id)} · ${current.id}`} close={close} back={history.length > 1 ? () => setHistory(h => h.slice(0, -1)) : undefined} bodyRef={body}>
    {event ? <><article className="chat-bubble selected"><MessageMetadata number={event.event_id.slice(0, 8)} timestamp={utc(event.time_us)}><span className="cu-chip">{eventNames[event.event_type]}</span><button className="cu-text-button" onClick={() => filterRole(event.role, event.event_id)} title="筛选本运行轨迹"><RoleLabel role={event.role}/> · {event.role}</button></MessageMetadata><p>{offset(event.time_us, detail.run.start_us)} · {event.version != null ? `v${event.version}` : "无版本字段"}</p><p>{eventText(event)}</p>{["feedback", "reason", "purpose", "assignment"].filter(k => typeof event.details[k] === "string").map(k => <section key={k}><h4>{{ feedback: "审核反馈", reason: "发布理由", purpose: "交接目的", assignment: "任务说明" }[k]}</h4><p>{String(event.details[k])}</p></section>)}{event.event_type === "agent_message" && <p className="cu-notice">这条记录未附完整模型输出；哈希与字段名列表不等于对话正文。</p>}</article>
      <section><h3>明确记录引用</h3>{refs.length ? refs.map(ref => <button key={ref} className="cu-reader-reference" onClick={() => open(ref)}>{eventNames[detail.projection.events.find(e => e.event_id === ref)?.event_type ?? ""] ?? "未找到的引用"} · {ref}<ArrowRight size={14} aria-hidden="true"/></button>) : <p className="cu-note">本条没有审核、读取、尝试或父事件引用。</p>}</section>
      <section><h3>正文与调用附件</h3>{event.attachment ? <><p>{event.attachment.location}</p><p>{event.attachment.exists ? "文件存在，可定位" : "原日志保留附件定位，但当前数据包未找到附件。"}</p></> : <p className="cu-note">本条未提供调用附件定位。文档正文未随当前数据包提供，不能进行真实内容比较。</p>}</section>
      <details><summary>完整字段与身份</summary><pre>{JSON.stringify({ run_id: event.run_id, actor_id: event.actor_id, target_id: event.target_id, task_id: event.task_id, document_id: event.document_id, version: event.version, ...event.details }, null, 2)}</pre></details>
      <details><summary>原始记录与来源定位</summary><p className="cu-break">{event.raw_source.path} · 第 {event.raw_source.line} 行</p><pre>{JSON.stringify(event.original ?? event, null, 2)}</pre></details>
    </> : <p className="cu-notice">引用 {current.id} 未在本运行中找到；未自动跳转到其他运行。</p>}
  </ReaderDialog>;
}
