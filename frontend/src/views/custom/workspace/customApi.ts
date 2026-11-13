import type { RunSummary } from "../../../data/api";

export const scenarios = ["normal", "bypass_review", "stale_version", "repeated_handoff"];
export const scenarioNames: Record<string, string> = { normal: "正常条件", bypass_review: "绕过审核条件", stale_version: "旧版条件", repeated_handoff: "重复交接条件" };
export const roles = ["controller", "coordinator", "researcher", "writer", "reviewer", "publisher"];
export const roleNames: Record<string, string> = { controller: "流程控制", coordinator: "协调", researcher: "研究", writer: "写作", reviewer: "审核", publisher: "发布" };
export const eventNames: Record<string, string> = { run_started: "运行开始", run_finished: "运行结束", task_created: "任务创建", task_handoff: "任务交接", agent_call_started: "调用开始", agent_call_finished: "调用结束", agent_message: "调用结果元数据", file_read: "文件读取", file_write: "文件写入", version_updated: "版本更新", submit_review: "提交审核", review_decision: "审核决定", workflow_route: "流程选择", publish_attempt: "发布尝试", publish_result: "发布结果" };
export const statusNames: Record<string, string> = { valid: "有效", invalid: "无效", unknown: "无法核对", current: "当前版", stale: "旧版", conflict: "证据冲突", published_current: "复制成功 · 当前版", published_stale: "复制成功 · 旧版", denied: "拒绝", failed: "失败", verified: "已核验", not_copied: "未复制" };
export type Fields = Record<string, unknown>;
export interface Rule { status: string; reason: string; evidence_event_ids: string[]; read_status?: string; read_reason?: string; read_version?: number | null; current_version_at_attempt?: number | null; expected_version?: number | null; actual_version?: number | null; pairing?: string; result_event_ids?: string[]; write_event_ids?: string[]; copy_status?: string; candidate_result_ids?: string[] }
export interface Attempt { attempt_event_id: string; version: number | null; expected_version: number | null; review: Rule; version_check: Rule; publish: Rule; model_suitable: boolean | null; reason: string | null }
export interface Coverage { complete: boolean; expected_events: number; returned_events: number; truncated: boolean; boundaries_present: boolean; missing_references: { event_id: string; field: string; reference: string }[] }
export interface Run extends RunSummary { normal_run_id: string | null; has_pair: boolean; attempts: Attempt[]; coverage: Coverage; call_count: number; version_count: number; version_path: { version: number; previous_version: number | null }[]; audit: Record<string, number> }
export interface Attachment { location: string; exists: boolean; readable: boolean; sha256: string | null; event_ids?: string[] }
export interface EvidenceEvent { event_id: string; event_type: string; time_us: number; role: string; actor_id: string | null; target_id: string | null; task_id: string | null; run_id: string; document_id: string | null; version: number | null; parent_event_id: string | null; details: Fields; ordinal: number; raw_source: { path: string; line: number }; original: Fields | null; attachment: Attachment | null }
export interface EvidenceNode { id: string; kind: string; label: string; version: number | null; time_us: number; role: string; details: Fields; source_event_ids: string[]; hash?: string; previous_version?: number | null; document_id?: string; path?: string; content?: Attachment }
export interface EvidenceEdge { id: string; source: string; target: string; relation: string; field: string; recorded: boolean; source_event_ids: string[] }
export interface Call { role: string; start_us: number | null; end_us: number | null; duration_ms: number | null; status: string; unpaired: boolean; started_event_id: string | null; finished_event_id: string | null; source_event_ids: string[] }
export interface Handoff { event_id: string; task_id: string | null; source_role: string; target_role: string; time_us: number; direction_ordinal: number }
export interface Projection { data_version: string; rules_version: string; projection_version: string; coverage: Coverage; content_availability: { version_bodies: number; versions: number; call_attachments: number; referenced_call_attachments: number }; attachments: Attachment[]; versions: EvidenceNode[]; nodes: EvidenceNode[]; edges: EvidenceEdge[]; events: EvidenceEvent[]; calls: Call[]; audit: { summary: Record<string, number>; attempts: Attempt[]; handoff: { total: number; repeated_pair_count: number; sequence: Handoff[]; loops: { path: string[]; event_ids: string[] }[]; missing_task_event_ids: string[] } } }
export interface Detail { meta: { data_version: string }; run: RunSummary; pair: { normal_run_id: string } | null; projection: Projection }
export interface Case { case_id: string; title: string; run_id: string; status: string; note: string }
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> { const res = await fetch(path, { signal }); if (!res.ok) throw new Error(`读取失败（${res.status}）`); return res.json(); }
export const loadRun = (id: string, signal?: AbortSignal) => get<Detail>(`/api/runs/${encodeURIComponent(id)}?dataset=CUSTOM`, signal);
export const short = (id: string) => id.replace(/^run-/, "").slice(0, 8);
export const fixture = (name: string | null) => (name ?? "未记录任务").split("/").at(-1)!.replace(/\.md$/, "");
export const seconds = (us: number | null) => us == null ? "未知" : `${(us / 1e6).toFixed(2)} s`;
export const offset = (us: number, start: number | null) => `+${((us - (start ?? us)) / 1e6).toFixed(3)}s`;
export const utc = (us: number) => new Date(us / 1000).toISOString().replace("T", " ").replace("Z", " UTC");
export const tone = (s: string) => ["valid", "verified", "published_current"].includes(s) ? "good" : ["stale", "published_stale"].includes(s) ? "attention" : ["invalid", "conflict", "failed"].includes(s) ? "danger" : "neutral";
export function summary(a?: Attempt) { return a ? `尝试 v${a.version ?? "?"}；当时当前 v${a.version_check.current_version_at_attempt ?? "?"}；审核${statusNames[a.review.status]}；读取${a.version_check.read_status === "valid" ? "匹配" : a.version_check.read_status === "invalid" ? "不匹配" : "无法核对"}；${statusNames[a.publish.status] ?? a.publish.status}。` : "没有可核对的发布尝试。"; }
