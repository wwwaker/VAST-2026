import { useEffect, useState } from "react";
import type { EventItem, TypeInfo } from "../../../data/api";

export const number = (value: number) => value.toLocaleString("zh-CN");
export const time = (us: number | null | undefined) => us == null ? "未记录时间" : new Date(us / 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
export const inputTime = (us: number | null) => us == null ? "" : new Date(us / 1000).toISOString().slice(0, 19);
export const actor = (id: string | null | undefined) => {
  if (!id) return "未记录执行者";
  const name = id.split(":").pop()!.replaceAll("_", " ");
  return `${name}${id.startsWith("MC2:agent:") ? " · Agent" : id.startsWith("MC2:person:") ? " · 人员" : ""}`;
};
export const typeLabel = (value: string, types: TypeInfo[]) => types.find(type => type.type === value)?.display_label ?? value;
export type ReaderTarget = { kind: "event" | "file"; id: string };

/** Clearing old data and guarding completion both matter when filters change quickly. */
export function useRequest<T>(key: string, request: (signal: AbortSignal) => Promise<T>): { data?: T; error?: string; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key, loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ key, loading: true });
    request(controller.signal).then(data => {
      if (active) setState({ key, data, loading: false });
    }).catch(error => {
      if (active && error.name !== "AbortError") setState({ key, error: String(error.message ?? error), loading: false });
    });
    return () => { active = false; controller.abort(); };
    // The caller supplies the complete request identity, independent of closure identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  return { data: state.key === key ? state.data : undefined, error: state.key === key ? state.error : undefined, loading: state.key !== key || state.loading, reload: () => setRetry(value => value + 1) };
}

export function RequestStatus({ loading, error, reload }: { loading: boolean; error?: string; reload: () => void }) {
  return <div className="mc2-status" role={error ? "alert" : "status"}>{loading ? "正在载入…" : error ? <>{error} <button onClick={reload}>重试</button></> : null}</div>;
}

export function EventRow({ event, types, open }: { event: EventItem; types: TypeInfo[]; open: (target: ReaderTarget, trigger: HTMLButtonElement) => void }) {
  return <button className="mc2-record" onClick={e => open({ kind: "event", id: event.event_id }, e.currentTarget)}>
    <span className="mc2-record-meta"><time>{time(event.time_us)}</time><b>{typeLabel(event.event_type, types)}</b><span>{event.actor_label ?? actor(event.actor_id)}</span></span>
    <span className="mc2-preview">{event.preview || "此记录未提供文本摘要，点击查看字段"}</span>
    <span className="mc2-record-id">{event.event_id} · 阅读记录 →</span>
  </button>;
}
