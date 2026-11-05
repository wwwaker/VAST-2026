/** 后端接口封装。前端不再持有静态数据导出，唯一数据源是 FastAPI。 */

export interface Anchor {
  key: string;
  label: string;
  time_raw: string;
  timezone: string;
  sort_key: number;
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
  anchors: Anchor[];
  /** 唯一干预点说明；null 表示该数据集不设 */
  intervention: string | null;
}

export interface TypeCount {
  type: string;
  count: number;
}

export interface OverviewPayload {
  dataset_id: string;
  name: string;
  timezone_status: string;
  total_events: number;
  entity_count: number;
  deliberation_count: number;
  time_range: [string, string] | [null, null];
  granularity: "hour" | "day";
  types: TypeCount[];
  series: {
    types: string[];
    buckets: number[];
    points: [number, number, number][];
  };
  actors: { entity_id: string; label: string; count: number }[];
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
  time_sort_key: number;
  timezone_status: string;
  event_type: string;
  actor_id: string | null;
  actor_label: string | null;
  actor_rule: string | null;
  preview: string;
  has_deliberation: boolean;
  source_missing_id: boolean;
  annotations: Annotation[];
}

export interface EventPage {
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
  dataset_id: string;
  event_id: string;
  source_record_id: string | null;
  source_missing_id: boolean;
  timestamp: string;
  timestamp_raw: string;
  timezone_status: string;
  event_type: string;
  actor_id: string | null;
  actor_rule: string | null;
  task_id: string | null;
  document_id: string | null;
  parent_event_id: string | null;
  details: Record<string, unknown> | null;
  has_deliberation: boolean;
  /** 外发文本（details.content），双声道左声道 */
  outgoing_text: string | null;
  /** 内部审议（raw.internal_state），双声道右声道 */
  deliberation: Record<string, string> | null;
  deliberation_source: string | null;
  source_json_pointer: string | null;
  raw: Record<string, unknown> | null;
  participants: Participant[];
  relations: Relation[];
  annotations: Annotation[];
}

export interface SearchHit {
  event_id: string;
  timestamp: string;
  event_type: string;
  actor_id: string | null;
  excerpt: string;
}

export interface GraphNode {
  id: string;
  label: string;
  entity_type: string;
  degree: number;
  is_center: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  derivation: string;
  evidence_count: number;
  evidence_event_id: string | null;
}

export interface GraphPayload {
  dataset_id: string;
  center: string;
  depth: number;
  truncated: boolean;
  node_limit: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CompareRow {
  key: string;
  label: string;
  window_count: number;
  baseline_count: number;
  window_rate: number;
  baseline_rate: number;
  delta: number;
  /** 基线为 0 时为 null，表示"本窗口新增"而非无限倍 */
  ratio: number | null;
  is_new: boolean;
  is_absent: boolean;
}

export interface ComparePayload {
  dataset_id: string;
  dimension: "actor" | "event_type";
  window: { start: number; end: number; hours: number; events: number };
  baseline: { start: number; end: number; hours: number; events: number; auto: boolean };
  dataset_range: { ts_min: string; ts_max: string };
  rows: CompareRow[];
  metric_note: string;
}

export interface NoteItem {
  note_id: number;
  dataset_id: string;
  event_id: string | null;
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

async function getJson<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url);
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

export function fetchDatasets(): Promise<DatasetInfo[]> {
  return getJson<DatasetInfo[]>("/api/datasets");
}

export function fetchOverview(
  dataset: string,
  options: { granularity?: "hour" | "day"; topTypes?: number; start?: number; end?: number } = {},
): Promise<OverviewPayload> {
  return getJson<OverviewPayload>(`/api/datasets/${dataset}/overview`, {
    granularity: options.granularity,
    top_types: options.topTypes,
    start: options.start,
    end: options.end,
  });
}

export function fetchEvents(params: {
  dataset: string;
  start?: number;
  end?: number;
  types?: string[];
  actor?: string;
  q?: string;
  hasDeliberation?: boolean;
  limit?: number;
  cursor?: string | null;
}): Promise<EventPage> {
  return getJson<EventPage>("/api/events", {
    dataset: params.dataset,
    start: params.start,
    end: params.end,
    types: params.types?.length ? params.types.join(",") : undefined,
    actor: params.actor,
    q: params.q,
    has_deliberation: params.hasDeliberation === undefined ? undefined : String(params.hasDeliberation),
    limit: params.limit,
    cursor: params.cursor ?? undefined,
  });
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

export function fetchEvent(dataset: string, eventId: string): Promise<EventDetail> {
  return getJson<EventDetail>(`/api/events/${encodeURIComponent(eventId)}`, { dataset });
}

export function searchEvents(dataset: string, q: string, limit = 50): Promise<{ items: SearchHit[] }> {
  return getJson<{ items: SearchHit[] }>("/api/search", { dataset, q, limit });
}

export function fetchGraph(dataset: string, center: string, depth = 1): Promise<GraphPayload> {
  return getJson<GraphPayload>("/api/graph", { dataset, center, depth });
}

export function fetchCompare(params: {
  dataset: string;
  start: number;
  end: number;
  dimension: "actor" | "event_type";
  baselineStart?: number;
  baselineEnd?: number;
}): Promise<ComparePayload> {
  return getJson<ComparePayload>("/api/compare", {
    dataset: params.dataset,
    start: params.start,
    end: params.end,
    dimension: params.dimension,
    baseline_start: params.baselineStart,
    baseline_end: params.baselineEnd,
  });
}

export function formatUtc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export function formatUtcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function toEpoch(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}
