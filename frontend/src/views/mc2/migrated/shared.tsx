import { MessageMetadata } from "../../mc1/reference/components/MessageMetadata";
import type { EventItem, TypeInfo } from "../../../data/api";

export const number = (value: number) => value.toLocaleString("zh-CN");
export const displayId = (value: string) => value.replaceAll("MC2:", "");
export const categoryColors = ["#417bb4", "#b17a29", "#8862b4", "#429583", "#bf6965", "#638a98", "#9c6b91", "#748092"];
export const time = (us: number | null | undefined) => us == null ? "未记录时间" : new Date(us / 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
export const inputTime = (us: number | null) => us == null ? "" : new Date(us / 1000).toISOString().slice(0, 19);
export const actor = (id: string | null | undefined) => {
  if (!id) return "未记录执行者";
  if (id === "__missing__") return "缺失来源分组";
  const name = id.split(":").pop()!.replaceAll("_", " ");
  return `${name}${id.startsWith("MC2:agent:") ? " · Agent" : id.startsWith("MC2:person:") ? " · 人员" : ""}`;
};
export const typeLabel = (value: string, types: TypeInfo[]) => types.find(type => type.type === value)?.display_label ?? value;
export type ReaderTarget = { kind: "event" | "file"; id: string };

export { useRequest, PendingRegion, RequestStatus } from "../../shared/request";

export function EventMetadata({ event, types, filterActor }: { event: Pick<EventItem, "event_id" | "time_us" | "event_type" | "actor_id" | "category">; types: TypeInfo[]; filterActor?: (id: string) => void }) {
  const color = categoryColors[(event.category - 1) % categoryColors.length];
  return <MessageMetadata number={event.event_id.split(":").at(-1)} timestamp={time(event.time_us)}>
    <span>{filterActor && event.actor_id ? <button className="cb-agent w-text-link" title="点击以此执行者筛选主页面" onClick={() => filterActor(event.actor_id!)}>{actor(event.actor_id)}</button> : actor(event.actor_id)}</span>
    <span className="w-event-type-chip" style={{ color, borderColor: `${color}60`, background: `${color}0c` }}>{typeLabel(event.event_type, types)}</span>
  </MessageMetadata>;
}
export function EventRow({ event, types, open }: { event: EventItem; types: TypeInfo[]; open: (target: ReaderTarget, trigger: HTMLElement) => void }) {
  return <article className="message clickable mc2-record" role="button" tabIndex={0} onClick={e => open({ kind: "event", id: event.event_id }, e.currentTarget)} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open({ kind: "event", id: event.event_id }, e.currentTarget); } }} title="点击查看记录内容与附近参与活动">
    <EventMetadata event={event} types={types}/>
    <p className="mc2-preview">{event.preview || "日志未附带消息正文，可查看记录内容与来源。"}</p>
    <div className="provenance-note mc2-record-id">阅读记录 →</div>
  </article>;
}
