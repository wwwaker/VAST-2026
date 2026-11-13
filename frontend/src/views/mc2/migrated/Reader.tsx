import { useEffect, useRef, useState } from "react";
import { fetchEvent, fetchFileTrack, type EventDetail, type FileTrackPayload, type TypeInfo } from "../../../data/api";
import type { Filters } from "../../../data/filterContext";
import { actor, categoryColors, displayId, EventMetadata, EventRow, number, PendingRegion, RequestStatus, time, typeLabel, useRequest, type ReaderTarget } from "./shared";

import { ReadingActions } from "../../mc1/reference/components/MessageMetadata";
import { useReaderScrollLock } from "../../shared/ReaderDialog";
import { query, relationName, type ProcessData } from "./workspaceApi";

type Entry = ReaderTarget & { scroll: number; cursors: (string | null)[] };
export function Reader({ initial, filters, types, close, filterActor }: { initial: ReaderTarget; filters: Filters; types: TypeInfo[]; close: () => void; filterActor: (id: string) => void }) {
  const [history, setHistory] = useState<Entry[]>([{ ...initial, scroll: 0, cursors: [null] }]);
  const current = history[history.length - 1];
  const modal = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const cursor = current.cursors[current.cursors.length - 1];
  const resource = useRequest<EventDetail | FileTrackPayload>(JSON.stringify([current.kind, current.id, filters, cursor]), signal => current.kind === "event"
    ? fetchEvent("MC2", current.id, signal)
    : fetchFileTrack({ fileId: current.id, filters, limit: 40, cursor }, signal));
  useReaderScrollLock(modal);
  useEffect(() => { if (body.current && !resource.loading) body.current.scrollTop = current.scroll; }, [current, resource.loading]);
  useEffect(() => { modal.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [current.kind, current.id, cursor]);
  const open = (target: ReaderTarget) => {
    setHistory(items => [...items.slice(0, -1), { ...current, scroll: body.current?.scrollTop ?? 0 }, { ...target, scroll: 0, cursors: [null] }]);
  };
  const page = (next?: string) => setHistory(items => [...items.slice(0, -1), { ...current, scroll: 0, cursors: next ? [...current.cursors, next] : current.cursors.slice(0, -1) }]);
  return <div className="flow-overlay w-reader-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="flow-modal mc2-reader w-reader" role="dialog" aria-modal="true" aria-labelledby="mc2-reader-title" ref={modal} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]')].filter(el => !el.closest("details:not([open])") || el.tagName === "SUMMARY");
        const first = controls[0], last = controls[controls.length - 1];
        const active = event.currentTarget.getRootNode() instanceof ShadowRoot ? (event.currentTarget.getRootNode() as ShadowRoot).activeElement : document.activeElement;
        if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="flow-modal-head"><div><h3 id="mc2-reader-title">{current.kind === "event" ? "阅读记录" : "阅读文件轨迹"}</h3><p className="mc2-note">{displayId(current.id)}</p></div><ReadingActions onBack={history.length > 1 ? () => setHistory(items => items.slice(0, -1)) : undefined} onClose={close} backLabel="返回上次阅读" closeLabel="关闭阅读记录"/></div>
      <div className="flow-list mc2-reader-body" ref={body} tabIndex={0}>
        {current.kind === "file" && <p className="mc2-note mc2-reader-scope">文件轨迹范围：{filters.startUs == null ? "数据起点" : time(filters.startUs)} → {filters.endUs == null ? "数据终点" : time(filters.endUs)}（不含终点）{filters.categories.length ? ` · 类别 ${filters.categories.join("、")}` : ""}{filters.actorId ? ` · ${actor(filters.actorId)}` : ""}{filters.eventTypes.length ? ` · ${filters.eventTypes.join("、")}` : ""}{filters.keyword ? ` · 关键词「${filters.keyword}」` : ""}</p>}
        <RequestStatus {...resource}/>
        <PendingRegion {...resource} minimum={340}>{!resource.loading && !resource.error && resource.data && (current.kind === "event" ? <EventContent event={resource.data as EventDetail} types={types} open={open} filterActor={filterActor}/> : <FileContent track={resource.data as FileTrackPayload} types={types} open={open} previous={current.cursors.length > 1} page={page}/>)}</PendingRegion>
      </div>
    </div>
  </div>;
}

function EventContent({ event, types, open, filterActor }: { event: EventDetail; types: TypeInfo[]; open: (target: ReaderTarget) => void; filterActor: (id: string) => void }) {
  const files = [...new Set(event.relations.filter(r => r.dst_id.startsWith("MC2:file_path:")).map(r => r.dst_id))];
  const details = event.details ?? {};
  const textFields = [["content", "正文"], ["subject", "邮件主题"], ["question", "问题"], ["response", "答复"], ["advice", "建议"], ["reason", "原因"], ["feedback", "反馈"], ["topic", "话题"], ["purpose", "目的"]].filter(([key]) => typeof details[key] === "string" && details[key]);
  const taskNames: Record<string, string> = { read_file: "读取文件", create_file: "创建文件", delete_file: "删除文件", access_email: "打开邮箱", check_email: "查收邮件", queue_subordinate_task: "排入下属任务" };
  const task = typeof details.task === "string" ? details.task : null;
  const target = typeof details.target === "string" ? details.target : null;
  const color = categoryColors[(event.category - 1) % categoryColors.length];
  return <>
    <article className="chat-bubble selected w-reading-message" style={{ borderLeftColor: color }}>
      <EventMetadata event={event} types={types} filterActor={filterActor}/>
      <div className="cb-body">{textFields.map(([key, label]) => <section className="w-message-text" key={key}>{key !== "content" && <b>{label}</b>}<p>{String(details[key])}</p></section>)}
        {task && <p><b>{event.event_type === "queue_subordinate_task" ? "排入的任务" : "任务类型"}：</b>{taskNames[task] ?? task}</p>}
        {target && <p><b>{event.event_type.includes("file") ? "文件路径" : "任务目标"}：</b>{displayId(target)}</p>}
        {typeof details.content_source === "string" && <p><b>发布内容来源：</b>{details.content_source}</p>}
        {event.event_type === "queue_subordinate_task" && <p className="mc2-note">这是任务排队记录；不能据此判断目标已执行成功。</p>}
        {!textFields.length && <p className="mc2-note">{details.content_source ? "此发布记录只提供来源引用，日志未包含帖子正文。" : "此条属于活动日志，未附带消息正文；可核对下面的明确对象与原始来源。"}</p>}
        {typeof details.granted === "boolean" && <p>准入检查：{details.granted ? "允许" : "拒绝"}</p>}
        {typeof details.room === "string" && <p>地点：{details.room}</p>}
        {Array.isArray(details.contacts) && <p>建议联系人：{details.contacts.map(v => actor(String(v))).join("、")}</p>}
        {typeof details.meeting === "object" && details.meeting !== null && <MeetingContent value={details.meeting as Record<string, unknown>}/>}
      </div><div className="provenance-note">原始记录：{displayId(event.event_id)} · 点击执行者姓名可筛选主页面</div>
    </article>
    {event.relations.length > 0 && <section className="mc2-reading-block"><h3>这条记录涉及谁、涉及什么</h3>{event.relations.map((r, i) => <div className="w-evidence-role" key={i}><span>{actor(r.src_id)}</span><span className="w-role-arrow">— {relationName[r.relation] ?? r.relation} →</span><button className="w-text-link" onClick={() => r.dst_id.startsWith("MC2:file_path:") ? open({ kind: "file", id: r.dst_id }) : r.target_kind === "event" ? open({ kind: "event", id: r.dst_id }) : undefined} disabled={!r.dst_id.startsWith("MC2:file_path:") && r.target_kind !== "event"}>{r.dst_id.startsWith("MC2:file_path:") ? r.dst_id.slice("MC2:file_path:".length) : actor(r.dst_id)}</button></div>)}</section>}
    {files.length > 0 && <section className="mc2-reading-block"><h3>关联文件与轨迹</h3>{files.map(id => <button className="mc2-link-row" key={id} onClick={() => open({ kind: "file", id })}>{id.slice("MC2:file_path:".length)} →</button>)}</section>}
    <NearbyActivity event={event} open={open} types={types}/>
    {event.deliberation && <details className="mc2-reading-block"><summary>内部审议</summary>{Object.entries(event.deliberation).map(([key, value]) => <p key={key}><b>{key}：</b>{typeof value === "string" ? value : JSON.stringify(value)}</p>)}</details>}
    <details className="mc2-reading-block"><summary>完整字段与角色依据</summary><dl className="mc2-fields">{Object.entries(details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{displayId(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</dd></div>)}</dl>{event.relations.map((r, i) => <p className="mc2-note" key={i}>{relationName[r.relation] ?? r.relation}：{r.derivation}</p>)}</details>
    <details className="mc2-reading-block"><summary>原始记录与来源定位</summary><p>{event.source_file ?? "来源文件未记录"} · 序号 {event.source_ordinal ?? "未知"} · {event.source_json_pointer}</p><pre>{JSON.stringify(event.raw, null, 2)}</pre></details>
  </>;
}
function MeetingContent({ value }: { value: Record<string, unknown> }) {
  return <section><p>会议时间：{String(value.time ?? "未记录")}</p>{Array.isArray(value.participants) && <p>参与者：{value.participants.map(v => actor(String(v))).join("、")}</p>}</section>;
}
function NearbyActivity({ event, types, open }: { event: EventDetail; types: TypeInfo[]; open: (target: ReaderTarget) => void }) {
  const params = { anchor: event.event_id, seconds: 60, context: "true" };
  const resource = useRequest(`reader-context:${event.event_id}`, signal => query<ProcessData>("process", params, signal));
  const items = resource.data?.items.filter(i => i.event_id !== event.event_id) ?? [];
  return <section className="mc2-reading-block"><h3>附近参与活动</h3><p className="mc2-note">前后60秒内，按执行者及明确来源／目标角色查询，含入向任务；时间接近不表示因果。此处独立于主页面筛选。</p><RequestStatus {...resource}/><PendingRegion {...resource} minimum={80}>{items.slice(0, 20).map(item => <EventRow key={item.event_id} event={item} types={types} open={target => open(target)}/>)}{!items.length && <p className="mc2-note">此窗口内未找到其他参与活动。</p>}{items.length > 20 && <p className="mc2-note">共{items.length}个附近活动标记，展示前20个；可回到局部过程调整窗口。</p>}</PendingRegion></section>;
}

function FileContent({ track, types, open, previous, page }: { track: FileTrackPayload; types: TypeInfo[]; open: (target: ReaderTarget) => void; previous: boolean; page: (next?: string) => void }) {
  const file = track.file;
  return <>
    <section className="mc2-reading-block"><h3>{file.path}</h3><p className={file.content_status === "available" ? "mc2-note" : "mc2-warning"}>{file.content_status === "available" ? "可定位到正文字段" : file.events_truncated ? "当前检查未发现文件正文" : "未提供文件正文"} · {file.reason}</p>
      {file.events_truncated && <p className="mc2-note">正文检查仅覆盖最早的 500 条关联记录；不能据此判断全部历史是否含正文。</p>}
      <p className="mc2-note">全历史：{number(file.event_count)} 条记录 · {time(file.first_us)} 至 {time(file.last_us)}{file.size_hint != null && ` · size_hint 原始值 ${file.size_hint}`}</p>
      <p className="mc2-note">文件阅读沿用打开时的时间、类型、执行者和关键词；展示此范围的文件轨迹，不叠加关系图中选中边的端点限制。</p>
      {file.content_sources.map(source => <button className="mc2-link-row" key={`${source.event_id}:${source.field}`} onClick={() => open({ kind: "event", id: source.event_id })}>查看文本依据：{source.field} · {number(source.length)} 字符 →</button>)}
    </section>
    <section className="mc2-reading-block"><h3>当前筛选内的文件轨迹 · {number(track.meta.matched_events)} 条</h3><div className="mc2-type-counts">{Object.entries(track.event_type_counts ?? {}).map(([type, count]) => <span key={type}>{typeLabel(type, types)} <b>{number(count)}</b></span>)}</div><p className="mc2-note">按时间正序排列。此处继承主页面筛选；全历史总数不随筛选变化。</p>
      {track.items.map(item => <div key={item.event_id}><EventRow event={item} types={types} open={target => open(target)}/><p className="mc2-relation-note">日志关系：{item.file_relations.join("、")}</p></div>)}
      {!track.items.length && <p className="mc2-empty">当前筛选内没有此文件的记录，可关闭阅读窗口并清空筛选。</p>}
      <div className="mc2-pagination"><button disabled={!previous} onClick={() => page()}>上一页</button><span>每页最多 40 条</span><button disabled={!track.next_cursor} onClick={() => page(track.next_cursor!)}>下一页</button></div>
    </section>
  </>;
}
