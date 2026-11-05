/** 后端接口封装（contract v2）。前端唯一数据源是 FastAPI，时间统一为整数微秒。 */

import { toApiFilters, type Filters, type QueryValue } from "./filterContext";

export interface Anchor {
  key: string;
  label: string;
  time_raw: string;
  timezone: string;
  time_us: number;
  note: string;
  /** 演示主线从该锚点开始；改 manifest 即可切换 */
  primary: boolean;
}

export interface DatasetInfo {
  dataset_id: string;
  name: string;
  question: string;
  timezone_status: string;
  event_count: number;
  entity_count: number;
  /** 含内部审议文本的事件数 */
  deliberation_count: number;
  ts_min: string;
  ts_max: string;
  start_us: number | null;
  end_us: number | null;
  data_version: string;
  schema_version: number;
  anchors: Anchor[];
  /** 唯一干预点说明；null 表示该数据集不设 */
  intervention: string | null;
}

export interface Meta {
  contract_version: number;
  dataset_id: string;
  data_version: string;
  scope: string;
  applied_filters: Record<string, unknown>;
  effective_time: { start_us: number | null; end_us: number | null };
  matched_events: number;
  truncated: boolean;
  next_cursor: string | null;
}

export interface CategoryInfo {
  id: number;
  key: string;
  label: string;
}

export interface TypeInfo {
  type: string;
  display_label: string;
  category: number;
  is_action: boolean;
  is_receipt: boolean;
  count?: number;
}

export interface Capabilities {
  contract_version: number;
  dataset_id: string;
  name: string;
  timezone_status: string;
  data_version: string;
  schema_version: number;
  event_count: number;
  entity_count: number;
  start_us: number | null;
  end_us: number | null;
  categories: CategoryInfo[];
  types: TypeInfo[];
  unknown_type_count: number;
  unknown_types: string[];
  supports: {
    run_id: boolean;
    channel: boolean;
    participant: boolean;
    masking: boolean;
    compare: boolean;
    run_compare: boolean;
  };
  artifact_status: string;
}

export interface Annotation {
  scenario: string | null;
  anomaly_type: string | null;
  observed: boolean;
  reason: string | null;
  run_id?: string | null;
}

export interface EventItem {
  event_id: string;
  timestamp: string;
  timestamp_raw: string;
  time_us: number;
  timezone_status: string;
  event_type: string;
  /** 服务端字典决定的类别 id（1..8） */
  category: number;
  actor_id: string | null;
  actor_label: string | null;
  actor_rule: string | null;
  run_id: string | null;
  version: number | null;
  document_id: string | null;
  channel_id: string | null;
  preview: string;
  has_deliberation: boolean;
  source_missing_id: boolean;
  annotations: Annotation[];
}

export interface EventPage {
  meta: Meta;
  dataset_id: string;
  timezone_status: string;
  items: EventItem[];
  next_cursor: string | null;
}

export interface Participant {
  entity_id: string;
  role: string;
  derivation: string;
  label: string | null;
  entity_type: string | null;
}

export interface Relation {
  src_id: string | null;
  dst_id: string;
  relation: string;
  derivation: string;
  /** entity = 指向实体；event = 指向另一条事件（reply_to） */
  target_kind: "entity" | "event";
  direction: "in" | "out";
}

export interface EventDetail {
  meta: Meta;
  dataset_id: string;
  event_id: string;
  source_record_id: string | null;
  source_missing_id: boolean;
  timestamp: string;
  timestamp_raw: string;
  time_us: number;
  timezone_status: string;
  event_type: string;
  category: number;
  actor_id: string | null;
  actor_rule: string | null;
  task_id: string | null;
  run_id: string | null;
  document_id: string | null;
  target_id: string | null;
  version: number | null;
  channel_id: string | null;
  parent_event_id: string | null;
  details: Record<string, unknown> | null;
  has_deliberation: boolean;
  /** 外发文本（details.content），双声道左声道 */
  outgoing_text: string | null;
  /** 内部审议（raw.internal_state），双声道右声道 */
  deliberation: Record<string, string> | null;
  deliberation_source: string | null;
  source_file: string | null;
  source_ordinal: number | null;
  source_json_pointer: string | null;
  raw: Record<string, unknown> | null;
  participants: Participant[];
  relations: Relation[];
  annotations: Annotation[];
}

export interface SearchHit {
  event_id: string;
  timestamp: string;
  time_us: number;
  event_type: string;
  category: number;
  actor_id: string | null;
  excerpt: string;
}

export interface OverviewSeries {
  /** 桶起点的整数微秒 */
  buckets: number[];
  /** [桶下标, 类别下标 0..7, 计数] */
  points: [number, number, number][];
}

export interface WindowCoverage {
  requested_duration_us: number | null;
  in_range_duration_us: number | null;
  observed_bucket_count: number;
  coverage_status: "full" | "partial" | "before_data" | "unknown";
  coverage_ratio?: number;
}

export interface OverviewPayload {
  meta: Meta;
  dataset_id: string;
  name: string;
  timezone_status: string;
  granularity: "hour" | "day";
  total_events: number;
  entity_count: number;
  deliberation_count: number;
  time_range: { start_us: number | null; end_us: number | null; ts_min: string; ts_max: string };
  categories: (CategoryInfo & { count_global: number; count_filtered: number })[];
  types: TypeInfo[];
  filtered: { series: OverviewSeries; matched_events: number; coverage: WindowCoverage };
  global_context: { series: OverviewSeries; matched_events: number; scope: string; coverage: WindowCoverage };
  actors: { entity_id: string; label: string; count: number }[];
  actors_scope: string;
}

export interface GraphNode {
  id: string;
  label: string;
  entity_type: string;
  /** 当前子图内可见度数，不等于全局度数 */
  visible_degree: number;
  is_center: boolean;
  level: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  derivation: string;
  kind: "dynamic" | "static";
  provenance_kind: "recorded" | "derived" | "candidate" | "analyst";
  evidence_count: number;
  observation_count?: number;
  first_us?: number;
  first_event_id?: string;
}

export interface GraphPayload {
  meta: Meta;
  dataset_id: string;
  center: string;
  depth: number;
  truncated: boolean;
  truncation_reasons: string[];
  node_limit: number;
  edge_limit: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  static_edges: GraphEdge[];
}

export interface GraphEvidencePayload {
  meta: Meta;
  edge: { source: string; target: string; relation: string; derivation: string };
  items: EventItem[];
  next_cursor: string | null;
}

export interface CompareRow {
  key: string;
  label: string;
  window_count: number;
  baseline_count: number;
  window_share: number;
  baseline_share: number;
  window_rate: number | null;
  baseline_rate: number | null;
  delta: number | null;
  /** 基线为 0 时为 null，表示“本窗口新增”而非无限倍 */
  ratio: number | null;
  is_new: boolean;
  is_absent: boolean;
  small_sample: boolean;
  evidence_filter: {
    start_us: number | null;
    end_us: number | null;
    dimension: "actor" | "event_type";
    key: string;
  };
}

export interface CompareWindow extends WindowCoverage {
  start_us: number | null;
  end_us: number | null;
  events: number;
  auto?: boolean;
}

export interface ComparePayload {
  meta: Meta;
  dataset_id: string;
  dimension: "actor" | "event_type";
  window: CompareWindow;
  baseline: CompareWindow;
  dataset_range: { start_us: number | null; end_us: number | null; ts_min: string; ts_max: string };
  window_total_rate: number | null;
  baseline_total_rate: number | null;
  overlap_us: number;
  small_sample_threshold: number;
  rows: CompareRow[];
  metric_note: string;
}

export interface NoteItem {
  note_id: number;
  dataset_id: string;
  event_id: string | null;
  /** v2 起为新写入的微秒；旧笔记仍是秒，展示时按数量级归一化 */
  event_time: number | null;
  body: string;
  filter_summary: string | null;
  created_at: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, params?: Record<string, QueryValue>, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* 保留 statusText */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

function withFilters(filters: Filters, extra: Record<string, QueryValue> = {}): Record<string, QueryValue> {
  return { ...toApiFilters(filters), ...extra };
}

export function fetchDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
  return getJson<DatasetInfo[]>("/api/datasets", undefined, signal);
}

export function fetchCapabilities(dataset: string, signal?: AbortSignal): Promise<Capabilities> {
  return getJson<Capabilities>(`/api/datasets/${dataset}/capabilities`, undefined, signal);
}

export function fetchOverview(
  dataset: string,
  options: {
    filters: Filters;
    granularity?: "hour" | "day";
    cursorUs?: number | null;
    masking?: boolean;
  },
  signal?: AbortSignal,
): Promise<OverviewPayload> {
  return getJson<OverviewPayload>(
    `/api/datasets/${dataset}/overview`,
    withFilters(options.filters, {
      granularity: options.granularity,
      cursor_us: options.cursorUs ?? undefined,
      masking: options.masking ? "true" : undefined,
    }),
    signal,
  );
}

export function fetchEvents(
  params: {
    dataset: string;
    filters: Filters;
    limit?: number;
    cursor?: string | null;
    direction?: "asc" | "desc";
    cursorUs?: number | null;
    masking?: boolean;
    hasDeliberation?: boolean;
  },
  signal?: AbortSignal,
): Promise<EventPage> {
  return getJson<EventPage>(
    "/api/events",
    withFilters(params.filters, {
      dataset: params.dataset,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
      direction: params.direction,
      cursor_us: params.cursorUs ?? undefined,
      masking: params.masking ? "true" : undefined,
      has_deliberation: params.hasDeliberation === undefined ? undefined : String(params.hasDeliberation),
    }),
    signal,
  );
}

async function sendJson<T>(path: string, method: "POST" | "DELETE", body?: unknown): Promise<T | null> {
  const res = await fetch(new URL(path, window.location.origin), {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const payload = (await res.json()) as { detail?: string };
      if (payload.detail) detail = payload.detail;
    } catch {
      /* 保留 statusText */
    }
    throw new ApiError(detail, res.status);
  }
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

export function fetchNotes(dataset: string): Promise<{ items: NoteItem[] }> {
  return getJson<{ items: NoteItem[] }>("/api/notes", { dataset });
}

export function createNote(payload: {
  dataset_id: string;
  body: string;
  event_id?: string | null;
  event_time?: number | null;
  filter_summary?: string | null;
}): Promise<NoteItem> {
  return sendJson<NoteItem>("/api/notes", "POST", payload) as Promise<NoteItem>;
}

export function deleteNote(noteId: number): Promise<null> {
  return sendJson<null>(`/api/notes/${noteId}`, "DELETE");
}

export function fetchEvent(dataset: string, eventId: string, signal?: AbortSignal): Promise<EventDetail> {
  return getJson<EventDetail>(`/api/events/${encodeURIComponent(eventId)}`, { dataset }, signal);
}

export function searchEvents(dataset: string, q: string, limit = 50): Promise<{ items: SearchHit[] }> {
  return getJson<{ items: SearchHit[] }>("/api/search", { dataset, q, limit });
}

export function fetchGraph(
  dataset: string,
  center: string,
  options: {
    filters: Filters;
    depth?: number;
    cursorUs?: number | null;
    masking?: boolean;
    nodeLimit?: number;
  },
  signal?: AbortSignal,
): Promise<GraphPayload> {
  return getJson<GraphPayload>(
    "/api/graph",
    withFilters(options.filters, {
      dataset,
      center,
      depth: options.depth,
      cursor_us: options.cursorUs ?? undefined,
      masking: options.masking ? "true" : undefined,
      node_limit: options.nodeLimit,
    }),
    signal,
  );
}

export function fetchGraphEvidence(
  params: {
    dataset: string;
    filters: Filters;
    edge: { source: string; target: string; relation: string; derivation: string };
    limit?: number;
    cursor?: string | null;
    cursorUs?: number | null;
    masking?: boolean;
  },
  signal?: AbortSignal,
): Promise<GraphEvidencePayload> {
  return getJson<GraphEvidencePayload>(
    "/api/graph/evidence",
    withFilters(params.filters, {
      dataset: params.dataset,
      src: params.edge.source,
      dst: params.edge.target,
      relation: params.edge.relation,
      derivation: params.edge.derivation,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
      cursor_us: params.cursorUs ?? undefined,
      masking: params.masking ? "true" : undefined,
    }),
    signal,
  );
}

export function fetchCompare(
  params: {
    dataset: string;
    filters: Filters;
    dimension: "actor" | "event_type";
    baselineStartUs?: number | null;
    baselineEndUs?: number | null;
    cursorUs?: number | null;
    masking?: boolean;
  },
  signal?: AbortSignal,
): Promise<ComparePayload> {
  return getJson<ComparePayload>(
    "/api/compare",
    withFilters(params.filters, {
      dataset: params.dataset,
      dimension: params.dimension,
      baseline_start_us: params.baselineStartUs ?? undefined,
      baseline_end_us: params.baselineEndUs ?? undefined,
      cursor_us: params.cursorUs ?? undefined,
      masking: params.masking ? "true" : undefined,
    }),
    signal,
  );
}

export function formatUtc(timeUs: number): string {
  const iso = new Date(timeUs / 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function formatUtcDate(timeUs: number): string {
  return new Date(timeUs / 1000).toISOString().slice(0, 10);
}

export function formatDuration(us: number | null): string {
  if (us == null) return "—";
  const seconds = us / 1_000_000;
  if (seconds < 120) return `${seconds.toFixed(seconds < 10 ? 2 : 0)} 秒`;
  if (seconds < 7200) return `${(seconds / 60).toFixed(1)} 分钟`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
}

export const HOUR_US = 3_600_000_000;
export const SECOND_US = 1_000_000;
