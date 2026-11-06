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

export interface RunAuditSummary {
  attempt_count: number;
  review_valid: number;
  review_invalid: number;
  review_unknown: number;
  version_current: number;
  version_stale: number;
  version_unknown: number;
  published_current: number;
  published_stale: number;
  denied: number;
  failed: number;
  publish_unknown: number;
  published_without_valid_review: number;
  repeated_handoff: number;
}

export interface RunAuditRule {
  rule_id: string;
  scope: string | null;
  status: string;
  reason: string;
  evidence_event_ids: string[];
  pairing?: string;
}

export interface RunSummary {
  run_id: string;
  model: string | null;
  fixture: string | null;
  scenario: string | null;
  observed: boolean;
  anomaly_type: string | null;
  start_us: number | null;
  end_us: number | null;
  duration_us: number | null;
  event_count: number;
  metrics: Record<string, unknown>;
}

export interface RunItem extends RunSummary {
  normal_run_id: string | null;
  has_pair: boolean;
  audit: RunAuditSummary;
  audit_rules: RunAuditRule[];
}

export interface RunsPayload {
  meta: Record<string, unknown>;
  items: RunItem[];
}

export interface RunCall {
  role: string | null;
  started_event_id: string | null;
  finished_event_id: string;
  start_us: number | null;
  end_us: number;
  duration_ms: number | null;
  status: string | null;
  unpaired: boolean;
}

export interface RunLink {
  source_event_id: string;
  target_event_id: string;
  relation: string;
  derivation: string;
}

export interface RunDetailPayload {
  meta: Meta;
  run: RunSummary;
  pair: { normal_run_id: string; model: string | null; fixture: string | null } | null;
  events: EventItem[];
  links: RunLink[];
  calls: RunCall[];
  audit: {
    attempts: { attempt_event_id: string; review: RunAuditRule; version_check: RunAuditRule; publish: RunAuditRule }[];
    rules: RunAuditRule[];
    handoff: {
      total: number;
      repeated_pair_count: number;
      pairs: { source_role: string; target_role: string; count: number; evidence_event_ids: string[] }[];
      loops: { path: string[]; event_ids: string[] }[];
    };
    summary: RunAuditSummary;
  };
  truncated: boolean;
}

export interface RunStageSide {
  count: number;
  event_ids: string[];
  start_offset_us: number | null;
  duration_us: number | null;
  actors?: string[];
}

export interface RunComparisonPayload {
  meta: Record<string, unknown>;
  pair: {
    run_id: string;
    baseline_run_id: string;
    auto: boolean;
    valid: boolean;
    same_model: boolean;
    same_fixture: boolean;
    baseline_normal: boolean;
  };
  run: RunSummary;
  baseline: RunSummary;
  stages: { stage: string; label: string; run: RunStageSide; baseline: RunStageSide; missing: { run: boolean; baseline: boolean } }[];
  metrics: { key: string; label: string; run: unknown; baseline: unknown; different: boolean }[];
  audit: { run: RunAuditSummary; baseline: RunAuditSummary };
  note: string;
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

export function fetchRuns(
  params: { model?: string; fixture?: string; scenario?: string; observed?: boolean },
  signal?: AbortSignal,
): Promise<RunsPayload> {
  return getJson<RunsPayload>(
    "/api/runs",
    {
      dataset: "CUSTOM",
      model: params.model,
      fixture: params.fixture,
      scenario: params.scenario,
      observed: params.observed === undefined ? undefined : String(params.observed),
    },
    signal,
  );
}

export function fetchRun(
  runId: string,
  options: { cursorUs?: number | null; masking?: boolean } = {},
  signal?: AbortSignal,
): Promise<RunDetailPayload> {
  return getJson<RunDetailPayload>(
    `/api/runs/${encodeURIComponent(runId)}`,
    {
      dataset: "CUSTOM",
      cursor_us: options.cursorUs ?? undefined,
      masking: options.masking ? "true" : undefined,
    },
    signal,
  );
}

export function fetchRunComparison(
  runId: string,
  baselineRunId?: string | null,
  signal?: AbortSignal,
): Promise<RunComparisonPayload> {
  return getJson<RunComparisonPayload>(
    "/api/run-comparisons",
    { dataset: "CUSTOM", run_id: runId, baseline_run_id: baselineRunId ?? undefined },
    signal,
  );
}

// ---------------------------------------------------------------- CUSTOM 冻结案例

export type CaseStatus = "ok" | "stale" | "mismatch" | "missing_run";

export interface CaseRunSummary {
  run_id: string;
  model: string | null;
  fixture: string | null;
  scenario: string | null;
  observed: boolean;
  event_count: number;
  start_us: number | null;
  end_us: number | null;
}

export interface CaseDiff {
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface CaseEvidenceEvent {
  role: string;
  event_id: string;
  event_type?: string;
  time_us?: number;
  actor_id?: string | null;
  version?: number | null;
  missing: boolean;
}

export interface CaseItem {
  case_id: string;
  title: string;
  scenario: string | null;
  note: string | null;
  run_id: string;
  baseline_run_id: string | null;
  model: string | null;
  fixture: string | null;
  expected: Record<string, number>;
  evidence: Record<string, string>;
  run?: CaseRunSummary;
  baseline?: CaseRunSummary;
  audit?: Record<string, number>;
  loops?: { path: string[]; event_ids: string[] }[];
  status: CaseStatus;
  computed_status?: CaseStatus;
  status_label: string;
  diffs: CaseDiff[];
  evidence_events?: CaseEvidenceEvent[];
}

export interface CaseListPayload {
  meta: { scope: string; read_only: boolean };
  dataset_id: string;
  file_data_version: string | null;
  data_version: string;
  stale: boolean;
  schema_version: number | null;
  note: string | null;
  items: CaseItem[];
  total: number;
  status_counts: Record<string, number>;
  /** 用户保存的案例（来自 notes.db），与预置案例分开返回 */
  user_items: {
    case_id: string;
    dataset_id: string;
    title: string;
    data_version: string;
    created_at: string;
    updated_at: string;
    kind: "user";
    status: CaseStatus;
    status_label: string;
  }[];
}

export interface CaseRecord {
  case_id: string;
  dataset_id: string;
  title: string;
  data_version: string;
  snapshot: Record<string, unknown>;
  status: CaseStatus;
  status_label: string;
  stale?: boolean;
  kind: "user" | "preset";
  created_at?: string;
  updated_at?: string;
}

export interface EvidenceInput {
  reference_id: string;
  role: "support" | "counter" | "uncertain";
  reference_kind?: "event";
  excerpt?: string | null;
  field_pointer?: string | null;
}

export interface FindingRecord {
  finding_id: string;
  case_id: string;
  claim: string;
  status: "hypothesis" | "supported" | "inconclusive";
  explanation: string;
  limitations: string | null;
  created_at: string;
  updated_at: string;
  evidence: {
    dataset_id: string;
    reference_kind: string;
    reference_id: string;
    role: "support" | "counter" | "uncertain";
    field_pointer: string | null;
    excerpt: string | null;
    source_hash: string;
  }[];
}

export function createCase(payload: {
  dataset_id: string;
  title: string;
  snapshot: Record<string, unknown>;
}): Promise<CaseRecord> {
  return sendJson("/api/cases", "POST", payload) as Promise<CaseRecord>;
}

export function fetchCaseById(caseId: string, signal?: AbortSignal): Promise<CaseRecord> {
  return getJson(`/api/cases/${encodeURIComponent(caseId)}`, undefined, signal);
}

export function createFinding(payload: {
  case_id: string;
  claim: string;
  status: FindingRecord["status"];
  explanation: string;
  limitations?: string | null;
  evidence: EvidenceInput[];
}): Promise<FindingRecord> {
  return sendJson("/api/findings", "POST", payload) as Promise<FindingRecord>;
}

export function fetchFindings(caseId: string, signal?: AbortSignal): Promise<{
  case_id: string;
  items: FindingRecord[];
  total: number;
  status_counts: Record<string, number>;
}> {
  return getJson("/api/findings", { case_id: caseId }, signal);
}

export function deleteFinding(findingId: string): Promise<null> {
  return sendJson(`/api/findings/${encodeURIComponent(findingId)}`, "DELETE");
}

export function fetchCases(signal?: AbortSignal): Promise<CaseListPayload> {
  return getJson("/api/cases", { dataset: "CUSTOM" }, signal);
}

export function fetchCase(caseId: string, signal?: AbortSignal): Promise<CaseItem> {
  return getJson(`/api/cases/${encodeURIComponent(caseId)}`, { dataset: "CUSTOM" }, signal);
}

// ---------------------------------------------------------------- MC2 文件与来源链

export type ContentStatus = "available" | "metadata_only" | "unresolved";
export type ProvenanceKind = "recorded" | "derived" | "candidate" | "analyst";

export interface TraceRootItem {
  event_id: string;
  file_id: string;
  file_path: string | null;
  time_us: number;
  actor_id: string | null;
  actor_label: string | null;
}

export interface FileStatus {
  file_id: string;
  path: string;
  label: string | null;
  content_status: ContentStatus;
  reason: string;
  size_hint: number | null;
  event_count: number;
  event_type_counts: Record<string, number>;
  first_us: number | null;
  last_us: number | null;
  content_sources: { event_id: string; field: string; length: number }[];
  checked_sources?: string[];
  missing_fields: string[];
  supports: string[];
  cannot_support: string[];
  event_ids?: string[];
  events_truncated?: boolean;
}

export interface TraceNode {
  id: string;
  kind: "event" | "entity";
  role: "root" | "file" | "file_operation" | "candidate_file" | string;
  label: string;
  event_id?: string;
  event_type?: string;
  time_us?: number;
  actor_id?: string | null;
  actor_label?: string | null;
  preview?: string;
  path?: string;
  relay_event_count?: number;
}

export interface TraceEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  provenanceKind: ProvenanceKind;
  temporalStatus: string;
  evidenceEventIds: string[];
  ruleId: string | null;
  explanation: string;
}

export interface TracePayload {
  meta: Meta;
  dataset_id: string;
  root_event_id: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  recorded_edge_count: number;
  candidate_edge_count: number;
  files: FileStatus[];
  candidates: { file_id: string; path: string; relay_event_count: number }[];
  unresolved: { count: number; ids: string[] };
  budget: { events: number; used: number; truncated: boolean; reasons: string[] };
  legend: Record<string, string>;
}

export interface FileTrackPayload {
  meta: Meta;
  file: FileStatus;
  relation_counts: Record<string, number>;
  items: (EventItem & { file_relations: string[] })[];
  next_cursor: string | null;
  naming_note: string;
}

export function fetchTraceRoots(signal?: AbortSignal): Promise<{ dataset_id: string; items: TraceRootItem[]; note: string }> {
  return getJson("/api/traces/roots", { dataset: "MC2" }, signal);
}

export function fetchTrace(
  params: {
    rootEventId: string;
    filters: Filters;
    cursorUs?: number | null;
    masking?: boolean;
    maxEvents?: number;
  },
  signal?: AbortSignal,
): Promise<TracePayload> {
  return getJson<TracePayload>(
    "/api/traces",
    withFilters(params.filters, {
      dataset: "MC2",
      root_event_id: params.rootEventId,
      cursor_us: params.cursorUs ?? undefined,
      masking: params.masking ? "true" : undefined,
      max_events: params.maxEvents,
    }),
    signal,
  );
}

export interface PatternStage {
  stage: string;
  label: string;
  status: "present" | "missing" | "unknown";
  support_kind?: string;
  link_basis?: string;
  event_ids?: string[];
  sample_event_ids?: string[];
  nearest_event_id?: string | null;
  nearest_actor?: string | null;
  nearest_lag_us?: number | null;
  total?: number;
  first_us?: number | null;
  actor_labels?: string[];
  note?: string;
}

export interface PatternChain {
  post_event_id: string;
  post_time_us: number;
  post_actor_id: string | null;
  post_actor_label: string | null;
  content_file: { file_id: string; path: string; content_status: ContentStatus } | null;
  instruction_file: { file_id: string; path: string } | null;
  link_basis: string | null;
  stages: PatternStage[];
  matched_stages: number;
  missing_stages: string[];
  stage_total: number;
  actor_count: number;
  window_us: { start_us: number; end_us: number };
  duration_us: number;
}

export interface PatternPayload {
  dataset_id: string;
  scope: string;
  items: PatternChain[];
  total: number;
  stage_dictionary: { stage: string; label: string }[];
  ordering: string;
  link_basis_note: string;
  note: string;
}

export interface InterventionPayload {
  dataset_id: string;
  position: string;
  label: string;
  predicate: { event_type: string; fields: string[]; condition: string; checkable_from_log: boolean };
  coverage: {
    post_event_id: string;
    content_file: string | null;
    present: boolean;
    nearest_event_id: string | null;
    nearest_actor: string | null;
    nearest_lag_us: number | null;
    relay_total: number;
    partial_chain: boolean;
    missing_stages: string[];
  }[];
  coverage_summary: { covered: number; denominator: number; partial_chains: number };
  evidence_event_ids: string[];
  impact: {
    queue_events_total: number;
    queue_events_with_file_path: number;
    events_on_target_files: number;
    events_on_other_files: number;
    distinct_senders: number;
    samples: { event_id: string; time_us: number; actor_label: string | null; path: string | null }[];
    note: string;
  };
  cut_analysis: { deterministic_path_exists: boolean; explicit_parent_edges: number; statement: string };
  limitations: string[];
  extra_info_needed: string[];
  constraint: string;
}

export interface SystemGroup {
  group_id: string;
  entity_type: string;
  label: string;
  member_count: number;
  participation_count: number;
  event_count?: number;
  aggregated: boolean;
  unresolved?: boolean;
}

export interface SystemEdge {
  source: string;
  target: string;
  relation: string;
  event_count: number;
  sample_event_id: string | null;
}

export interface OrgEdge {
  source: string;
  target: string;
  relation: string;
  source_label: string;
  target_label: string;
  source_type: string | null;
  target_type: string | null;
  provenance_kind: string;
  temporal_status: string;
}

export interface SystemOverviewPayload {
  meta: Meta & { cache_hit: boolean; note: string };
  dataset_id: string;
  groups: SystemGroup[];
  interaction_edges: SystemEdge[];
  org_edges: OrgEdge[];
  spotlight: { root_event_id: string; entities: { entity_id: string; role: string; entity_type: string | null; label: string; group_id: string }[]; groups: string[] } | null;
  scale: {
    events_total: number;
    entities_total: number;
    group_count: number;
    unresolved_endpoints: number;
    unresolved_event_count: number;
    files_aggregated: number;
    interaction_edges_total: number;
    interaction_edges_returned: number;
    org_edges_returned: number;
    truncated: boolean;
    reasons: string[];
  };
  notes: string[];
}

export interface GroupMembers {
  dataset_id: string;
  group_id: string;
  entity_type: string;
  members: { entity_id: string; label: string; event_count: number; group_id: string }[];
  truncated: boolean;
}

export function fetchSystemOverview(traceRootId: string | null, signal?: AbortSignal): Promise<SystemOverviewPayload> {
  return getJson(
    "/api/system-overview",
    { dataset: "MC2", trace_root_id: traceRootId ?? undefined },
    signal,
  );
}

export function fetchGroupMembers(
  entityType: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<GroupMembers> {
  return getJson("/api/system-overview/members", { dataset: "MC2", entity_type: entityType, limit }, signal);
}

export function fetchFilePostPatterns(beforeUs?: number | null, signal?: AbortSignal): Promise<PatternPayload> {
  return getJson("/api/patterns/file-posts", { dataset: "MC2", before_us: beforeUs ?? undefined }, signal);
}

export function fetchIntervention(
  position = "relay_queue",
  signal?: AbortSignal,
): Promise<InterventionPayload> {
  return getJson("/api/interventions", { dataset: "MC2", position }, signal);
}

export function searchFiles(
  query: string,
  signal?: AbortSignal,
): Promise<{
  dataset_id: string;
  query: string;
  count: number;
  note: string;
  items: { file_id: string; path: string; event_count: number; first_us: number | null; last_us: number | null; exact: boolean }[];
}> {
  return getJson("/api/files", { dataset: "MC2", q: query, limit: 20 }, signal);
}

export function fetchFileTrack(
  params: {
    fileId: string;
    filters: Filters;
    limit?: number;
    cursor?: string | null;
    cursorUs?: number | null;
    masking?: boolean;
  },
  signal?: AbortSignal,
): Promise<FileTrackPayload> {
  return getJson<FileTrackPayload>(
    "/api/file-track",
    withFilters(params.filters, {
      dataset: "MC2",
      file_id: params.fileId,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
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
