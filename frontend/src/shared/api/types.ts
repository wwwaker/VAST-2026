/** Contracts consumed by the current workspaces. */
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
  reading?: { summary: string; fields: { key: string; label: string; value: string }[] };
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

export type ContentStatus = "available" | "metadata_only" | "unresolved";

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

export interface FileTrackPayload {
  meta: Meta;
  file: FileStatus;
  relation_counts: Record<string, number>;
  event_type_counts?: Record<string, number>;
  items: (EventItem & { file_relations: string[] })[];
  next_cursor: string | null;
  naming_note: string;
}
