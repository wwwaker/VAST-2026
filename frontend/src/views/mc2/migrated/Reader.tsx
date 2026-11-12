import { useEffect, useRef, useState } from "react";
import { fetchEvent, fetchFileTrack, type EventDetail, type FileTrackPayload, type TypeInfo } from "../../../data/api";
import type { Filters } from "../../../data/filterContext";
import { actor, EventRow, number, RequestStatus, time, typeLabel, useRequest, type ReaderTarget } from "./shared";

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
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modal.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { document.body.style.overflow = previous; };
  }, []);
  useEffect(() => { if (body.current && !resource.loading) body.current.scrollTop = current.scroll; }, [current, resource.loading]);
  useEffect(() => { modal.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [current.kind, current.id, cursor]);
  const open = (target: ReaderTarget) => {
    setHistory(items => [...items.slice(0, -1), { ...current, scroll: body.current?.scrollTop ?? 0 }, { ...target, scroll: 0, cursors: [null] }]);
  };
  const page = (next?: string) => setHistory(items => [...items.slice(0, -1), { ...current, scroll: 0, cursors: next ? [...current.cursors, next] : current.cursors.slice(0, -1) }]);
  return <div className="mc2-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="mc2-reader" role="dialog" aria-modal="true" aria-labelledby="mc2-reader-title" ref={modal} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]')].filter(el => !el.closest("details:not([open])") || el.tagName === "SUMMARY");
        const first = controls[0], last = controls[controls.length - 1];
        const active = event.currentTarget.getRootNode() instanceof ShadowRoot ? (event.currentTarget.getRootNode() as ShadowRoot).activeElement : document.activeElement;
        if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="mc2-reader-head"><div><h2 id="mc2-reader-title">{current.kind === "event" ? "阅读记录" : "阅读文件轨迹"}</h2><p className="mc2-note">{current.id}</p></div><div className="mc2-actions">{history.length > 1 && <button onClick={() => setHistory(items => items.slice(0, -1))}>← 返回上次阅读</button>}<button className="mc2-close" onClick={close}>关闭 · Esc</button></div></div>
      <div className="mc2-reader-body" ref={body} tabIndex={0}>
        <p className="mc2-note mc2-reader-scope">文件轨迹范围：{filters.startUs == null ? "数据起点" : time(filters.startUs)} → {filters.endUs == null ? "数据终点" : time(filters.endUs)}（不含终点）{filters.categories.length ? ` · 类别 ${filters.categories.join("、")}` : ""}{filters.actorId ? ` · ${actor(filters.actorId)}` : ""}{filters.eventTypes.length ? ` · ${filters.eventTypes.join("、")}` : ""}{filters.keyword ? ` · 关键词「${filters.keyword}」` : ""}</p>
        <RequestStatus {...resource}/>
        {resource.data && (current.kind === "event" ? <EventContent event={resource.data as EventDetail} types={types} open={open} filterActor={filterActor}/> : <FileContent track={resource.data as FileTrackPayload} types={types} open={open} previous={current.cursors.length > 1} page={page}/>)}
      </div>
    </div>
  </div>;
}

function EventContent({ event, types, open, filterActor }: { event: EventDetail; types: TypeInfo[]; open: (target: ReaderTarget) => void; filterActor: (id: string) => void }) {
  const files = [...new Set(event.relations.filter(relation => relation.dst_id.startsWith("MC2:file_path:")).map(relation => relation.dst_id))];
  return <>
    <div className="mc2-reader-summary"><b>{typeLabel(event.event_type, types)}</b><time>{time(event.time_us)}</time><span>{actor(event.actor_id)}</span>{event.actor_id && <button onClick={() => filterActor(event.actor_id!)}>以此执行者筛选主页面</button>}</div>
    <section className="mc2-reading-block"><h3>记录内容</h3>{event.outgoing_text ? <p className="mc2-long-text">{event.outgoing_text}</p> : <p className="mc2-note">这条记录未提供可直接阅读的正文。以下是日志实际记录的字段。</p>}
      <dl className="mc2-fields">{Object.entries(event.details ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</dd></div>)}</dl>
      {!Object.keys(event.details ?? {}).length && <p>没有 details 字段。</p>}
    </section>
    {files.length > 0 && <section className="mc2-reading-block"><h3>关联文件</h3>{files.map(id => <button className="mc2-link-row" key={id} onClick={() => open({ kind: "file", id })}>{id.slice("MC2:file_path:".length)} →</button>)}</section>}
    {event.deliberation && <section className="mc2-reading-block"><h3>内部审议</h3><pre>{JSON.stringify(event.deliberation, null, 2)}</pre></section>}
    <details className="mc2-reading-block"><summary>参与者与关系</summary><dl className="mc2-fields">{event.participants.map((participant, i) => <div key={i}><dt>{participant.role}</dt><dd>{participant.label ?? actor(participant.entity_id)}<small>{participant.entity_id} · {participant.derivation}</small></dd></div>)}</dl>{event.relations.map((relation, i) => <div className="mc2-relation" key={i}><code>{relation.relation}</code><span>{relation.dst_id}</span>{relation.target_kind === "event" && <button onClick={() => open({ kind: "event", id: relation.dst_id })}>阅读关联记录 →</button>}</div>)}</details>
    <details className="mc2-reading-block"><summary>原始记录与来源定位</summary><p>{event.source_file ?? "来源文件未记录"} · 序号 {event.source_ordinal ?? "未知"} · {event.source_json_pointer}</p><pre>{JSON.stringify(event.raw, null, 2)}</pre></details>
  </>;
}

function FileContent({ track, types, open, previous, page }: { track: FileTrackPayload; types: TypeInfo[]; open: (target: ReaderTarget) => void; previous: boolean; page: (next?: string) => void }) {
  const file = track.file;
  return <>
    <section className="mc2-reading-block"><h3>{file.path}</h3><p className={file.content_status === "available" ? "mc2-note" : "mc2-warning"}>{file.content_status === "available" ? "可定位到正文字段" : file.events_truncated ? "当前检查未发现文件正文" : "未提供文件正文"} · {file.reason}</p>
      {file.events_truncated && <p className="mc2-note">正文检查仅覆盖最早的 500 条关联记录；不能据此判断全部历史是否含正文。</p>}
      <p className="mc2-note">全历史：{number(file.event_count)} 条记录 · {time(file.first_us)} 至 {time(file.last_us)}{file.size_hint != null && ` · size_hint 原始值 ${file.size_hint}`}</p>
      {file.content_sources.map(source => <button className="mc2-link-row" key={`${source.event_id}:${source.field}`} onClick={() => open({ kind: "event", id: source.event_id })}>查看文本依据：{source.field} · {number(source.length)} 字符 →</button>)}
    </section>
    <section className="mc2-reading-block"><h3>当前筛选内的文件轨迹 · {number(track.meta.matched_events)} 条</h3><div className="mc2-type-counts">{Object.entries(track.event_type_counts ?? {}).map(([type, count]) => <span key={type}>{typeLabel(type, types)} <b>{number(count)}</b></span>)}</div><p className="mc2-note">按时间正序排列。此处继承主页面筛选；全历史总数不随筛选变化。</p>
      {track.items.map(item => <div key={item.event_id}><EventRow event={item} types={types} open={target => open(target)}/><p className="mc2-relation-note">日志关系：{item.file_relations.join("、")}</p></div>)}
      {!track.items.length && <p className="mc2-empty">当前筛选内没有此文件的记录，可关闭阅读窗口并清空筛选。</p>}
      <div className="mc2-pagination"><button disabled={!previous} onClick={() => page()}>上一页</button><span>每页最多 40 条</span><button disabled={!track.next_cursor} onClick={() => page(track.next_cursor!)}>下一页</button></div>
    </section>
  </>;
}
