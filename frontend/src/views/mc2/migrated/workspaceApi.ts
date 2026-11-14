import { toApiFilters, type Filters } from "../../../data/filterContext";
import type { EventItem, TypeInfo } from "../../../data/api";
import { recordTiming, setDiagnosticVersion } from "./performance";

export type Scope = { filters: Filters; fileId?: string; noFile?: boolean; relation?: string; source?: string; target?: string; action?: string };
export type Selection = { start: number; end: number; type?: string; label: string; cellBucket?: number };
export type Meta = { matched_events: number; selection_hash: string; data_version: string };
export type Evidence = { meta: Meta; items: EventItem[]; next_cursor: string | null; timeline?: { start: number; end: number; count: number }[] };
export type ActivityData = { meta: Meta; buckets: number[]; step: number; types: TypeInfo[]; cells: { bucket: number; type: string; count: number }[]; categories: { id: number; label: string }[]; coverage: { start: number; end: number } };
export type FacetData = { meta: Meta; items: { id: string; label: string; entity_type: string; count: number }[]; total: number; missing: number; offset: number; kind: string; scale_max: number };
export type RelationNode = { id: string; label: string; entity_type: string };
export type Edge = { source: string; target: string; relation: string; action: string; count: number; first_us: number; last_us: number };
export type RelationSemantic = { source_role: string; target_role: string; event_types: string[]; fields: string[]; note: string; evidence_level: string; missing_source: string };
export type RelationData = { meta: Meta; nodes: RelationNode[]; edges: Edge[]; mapped_events: number; unmapped_events: number; missing_source_events: number; relation_counts: { relation: string; label: string; count: number }[]; selected_relations: string[]; mode: string; needs_file: boolean; semantics: Record<string, RelationSemantic> };
export type ProcessItem = EventItem & { kind: "event"; context: boolean; context_sources: string[]; roles: { relation: string; src_id: string | null; dst_id: string; derivation: string }[]; files: string[] };
export type ProcessAggregate = { kind: "aggregate"; aggregate_id: string; lane_id: string; bucket_start: number; bucket_end: number; count: number; context: boolean; types: Record<string, number>; file_count: number; task_count: number; task_targets: number };
type ProcessBase = { anchor: string; anchor_time: number | null; selection_key: string; data_version: string; invalid_reasons: {code: string; label: string}[]; note: string };
export type ProcessData = ProcessBase & ({ valid: false; items: []; aggregates: []; lanes: []; links: [] } | { valid: true; anchor_time: number; start: number; end: number; items: ProcessItem[]; aggregates: ProcessAggregate[]; lanes: (RelationNode & {role_only?: boolean})[]; links: { event_id: string; source: string; target: string; relation: string; time_us: number }[]; total: number; main_count: number; context_count: number; outside_main: number; anchor_outside_time: boolean; bins: number });
export type ProcessMembers = { items: ProcessItem[]; total: number; next_cursor: string | null; data_version: string; selection_key: string };
export type Comparison = { items: { event_id: string; time_sort_us: number; actor_id: string; file_id: string; path: string; content_status: string; content_note: string; operations: { event_id: string; event_type: string; time_sort_us: number }[]; create_lag_us: number | null; delete_lag_us: number | null }[]; total: number; offset: number; note: string };

export function scopeParams(scope: Scope) {
  return { ...toApiFilters(scope.filters), file_id: scope.fileId, no_file: scope.noFile ? "true" : undefined,
    relation: scope.relation, source: scope.source, target: scope.target, action: scope.action };
}
const responses = new Map<string, { at: number; data: unknown }>();
const requests = new Map<string, Promise<unknown>>();
const CACHE_TTL = 120_000;
export function clearWorkspaceCache() { responses.clear(); }
export async function query<T>(path: string, params: Record<string, string | number | undefined>, signal: AbortSignal): Promise<T> {
  const url = new URL(`/api/mc2/${path}`, window.location.origin);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== "") url.searchParams.set(k, String(v)); });
  url.searchParams.sort();
  const key = url.toString(), cached = responses.get(key);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    recordTiming('cache-hit',0,path);
    responses.delete(key); responses.set(key, cached);
    return cached.data as T;
  }
  let pending = requests.get(key);
  if (!pending) {
    const started=performance.now();
    // Shared transport survives an individual panel unmount. Each subscriber still
    // aborts independently; errors and aborted transports never enter the cache.
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    pending = fetch(url, { signal: controller.signal }).then(async res => {
      recordTiming('request',performance.now()-started,key);
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.detail ?? res.statusText); }
      const parsing=performance.now();
      const data = await res.json();
      const version=data?.meta?.data_version??data?.data_version;
      if(version)setDiagnosticVersion(version);
      recordTiming('json',performance.now()-parsing,path);
      recordTiming('server-timing',0,res.headers.get('Server-Timing')??undefined);
      responses.delete(key); responses.set(key, { at: Date.now(), data });
      while (responses.size > 80) responses.delete(responses.keys().next().value!);
      return data;
    }).finally(() => { window.clearTimeout(timeout); requests.delete(key); });
    requests.set(key, pending);
  } else {
    recordTiming('shared-request',0,path);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    pending!.then(value => { cleanup(); if (!signal.aborted) resolve(value as T); }, error => { cleanup(); if (!signal.aborted) reject(error); });
  });
}
export function narrowed(filters: Filters, selected: Selection | null): Filters {
  return selected ? { ...filters, startUs: Math.max(filters.startUs ?? selected.start, selected.start),
    endUs: Math.min(filters.endUs ?? selected.end, selected.end), eventTypes: selected.type ? (!filters.eventTypes.length || filters.eventTypes.includes(selected.type) ? [selected.type] : ["__no_type_intersection__"]) : filters.eventTypes } : filters;
}
export const relationName: Record<string, string> = {
  queue_target_agent: "任务目标 · 智能体", queue_target_person: "任务目标 · 人员", mail_recipient: "邮件收件角色",
  mail_sender: "邮件发件角色", a2a_destination: "智能体通信目标", meeting_invitee: "会议邀请对象", system_party: "系统参与角色",
  room: "场所角色", file_path: "文件操作", queued_file_path: "任务文件参数", post_content_source: "发布来源引用",
};
