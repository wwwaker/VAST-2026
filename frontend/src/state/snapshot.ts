import { EMPTY_FILTERS, type Filters } from "../data/filterContext";
import { baseFilters, CAPABILITIES, currentWindow, initialWorkspace, returnPoint, workspaceReducer } from "./workspaceReducer";
import type { DatasetId, Investigation, Mode, TaskId, WorkspaceState } from "./workspaceTypes";

export const UI_STATE_VERSION = 1;
export const SNAPSHOT_MAX_BYTES = 256 * 1024;
type JsonObject = Record<string, unknown>;
export interface SnapshotBody extends JsonObject {
  dataset_id: DatasetId; task: TaskId; mode: Mode;
  base_filters: Investigation["baseEventFilters"]; trace_object: Investigation["traceObject"];
  selection: Investigation["selection"]; comparison: Investigation["comparison"];
  task_modes: Investigation["taskModes"]; viewports: Investigation["viewports"];
  graph_context: Investigation["graphContext"]; collection_filters: Investigation["collectionFilters"];
  replay: Investigation["replay"]; intervention_position: string | null;
  pinned_evidence: Investigation["basket"];
}
export interface UiSnapshot extends SnapshotBody {
  contract_version: 2; ui_state_version: 1; return_point: SnapshotBody | null;
}
export type RestorePlan =
  | { status: "ready"; investigation: Investigation; returnPoint: Investigation | null; summary: string[]; stale: boolean; migrated: boolean }
  | { status: "unsupported" | "invalid"; summary: string[]; original: unknown };

function body(state: Investigation): SnapshotBody {
  return { dataset_id: state.dataset, task: state.task, mode: state.mode,
    base_filters: state.baseEventFilters, trace_object: state.traceObject,
    selection: state.selection, comparison: state.comparison, task_modes: state.taskModes,
    viewports: state.viewports, graph_context: state.graphContext,
    collection_filters: state.collectionFilters, replay: state.replay,
    intervention_position: state.interventionPosition, pinned_evidence: state.basket };
}
export function serializeSnapshot(state: WorkspaceState): UiSnapshot {
  const snapshot = JSON.parse(JSON.stringify({ contract_version: 2, ui_state_version: UI_STATE_VERSION,
    ...body(state), return_point: state.returnStack.length ? body(state.returnStack.at(-1)!) : null }));
  validateSnapshot(snapshot);
  return snapshot;
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("应为对象");
  return value as JsonObject;
}
function fields(value: JsonObject, allowed: readonly string[], required: readonly string[] = allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) throw new Error("快照字段缺失或不受支持");
}
function str(v: unknown) { if (typeof v !== "string") throw new Error("应为文本"); }
function nullableStr(v: unknown) { if (v !== null) str(v); }
function us(v: unknown) { if (v !== null && !Number.isSafeInteger(v)) throw new Error("时间必须为整数微秒"); }
function strings(v: unknown) { if (!Array.isArray(v)) throw new Error("应为文本数组"); v.forEach(str); }
function windowUs(v: unknown) {
  if (v === null) return;
  if (!Array.isArray(v) || v.length !== 2) throw new Error("窗口应有两个端点");
  v.forEach(us);
  if (v.some((x) => x === null) || v[0] >= v[1]) throw new Error("无效半开窗口");
}
function choice(v: unknown, allowed: readonly unknown[]) { if (!allowed.includes(v)) throw new Error(`不支持的枚举 ${String(v)}`); }
function bool(v: unknown) { if (typeof v !== "boolean") throw new Error("应为布尔值"); }
function validateDisplay(v: unknown, depth = 0) {
  if (depth > 10) throw new Error("显示配置嵌套过深");
  if (v === null || typeof v === "string" || typeof v === "boolean") return;
  if (typeof v === "number" && Number.isFinite(v)) return;
  if (Array.isArray(v)) { if (v.length > 800) throw new Error("显示配置超出预算"); v.forEach((x) => validateDisplay(x, depth + 1)); return; }
  const o = object(v);
  for (const [key, value] of Object.entries(o)) {
    if (["__proto__", "constructor", "prototype", "hover", "timer", "payload", "events", "nodes", "edges"].includes(key)) throw new Error("显示配置包含非持久字段");
    validateDisplay(value, depth + 1);
  }
}
function validateSelection(v: unknown) {
  if (v === null) return;
  const s = object(v);
  switch (s.kind) {
    case "event": fields(s, ["kind", "id", "timeUs"]); str(s.id); us(s.timeUs); break;
    case "entity": case "file": case "context": case "rule": fields(s, ["kind", "id"]); str(s.id); break;
    case "activityCell": fields(s, ["kind", "agentId", "bucketKey"]); str(s.agentId); str(s.bucketKey); break;
    case "graphEdge": fields(s, ["kind", "sourceId", "targetId", "relation", "derivation"]); [s.sourceId, s.targetId, s.relation, s.derivation].forEach(str); break;
    case "transitionCell": fields(s, ["kind", "fromType", "toType"]); str(s.fromType); str(s.toType); break;
    case "eventGroup": fields(s, ["kind", "viewId", "eventIds"]); str(s.viewId); strings(s.eventIds); if ((s.eventIds as string[]).length > 800) throw new Error("事件组超出预算"); break;
    case "gap": fields(s, ["kind", "scopeId", "key"]); str(s.scopeId); str(s.key); break;
    default: throw new Error("未知选中引用类型");
  }
}
function validateFilters(value: unknown) {
  const f = object(value);
  fields(f, Object.keys(baseFilters(EMPTY_FILTERS)));
  us(f.startUs); us(f.endUs);
  if (f.startUs !== null && f.endUs !== null) windowUs([f.startUs, f.endUs]);
  if (!Array.isArray(f.categories) || f.categories.some((x) => !Number.isInteger(x) || x < 1 || x > 8)) throw new Error("无效类别");
  strings(f.eventTypes); strings(f.channels); nullableStr(f.actorId); nullableStr(f.participantId); str(f.keyword);
  return f;
}
/** Only read compatibility aliases; new state and serializers use canonical modes. */
function normalizeModes(value: JsonObject, summary: string[]): JsonObject {
  const b = { ...value };
  const canonical = (task: unknown, mode: unknown) => {
    const mapped = task === "overview" ? (mode === "timeline" ? "time" : mode === "local" ? "relations" : mode) :
      task === "trace" ? (mode === "messages" && b.dataset_id === "MC1" ? "decision" : mode === "file" && b.dataset_id === "MC2" ? "source" : mode) : mode;
    if (mapped !== mode) summary.push(`旧模式 ${String(mode)} 已兼容转换为 ${String(mapped)}；原案例未修改。`);
    return mapped;
  };
  b.mode = canonical(b.task, b.mode);
  const modes = object(b.task_modes);
  b.task_modes = Object.fromEntries(Object.entries(modes).map(([task, mode]) => [task, canonical(task, mode)]));
  if (b.return_point !== undefined && b.return_point !== null) b.return_point = normalizeModes(object(b.return_point), summary);
  return b;
}
function validateBody(v: unknown, dataset?: DatasetId): SnapshotBody {
  const b = object(v);
  const keys = ["dataset_id", "task", "mode", "base_filters", "trace_object", "selection", "comparison", "task_modes", "viewports", "graph_context", "collection_filters", "replay", "intervention_position", "pinned_evidence"];
  fields(b, keys);
  choice(b.dataset_id, ["MC1", "MC2", "CUSTOM"]);
  if (dataset && b.dataset_id !== dataset) throw new Error("返回点属于另一数据集");
  const ds = b.dataset_id as DatasetId;
  choice(b.task, ["overview", "trace", "compare", "findings"]);
  const task = b.task as TaskId;
  choice(b.mode, CAPABILITIES[ds][task]);
  const modes = object(b.task_modes);
  fields(modes, ["overview", "trace", "compare", "findings"]);
  for (const key of Object.keys(modes) as TaskId[]) choice(modes[key], CAPABILITIES[ds][key]);
  if (modes[task] !== b.mode) throw new Error("任务与 mode 不同步");
  const f = validateFilters(b.base_filters);
  const t = object(b.trace_object);
  if (t.dataset !== ds) throw new Error("追踪对象属于另一数据集");
  if (ds === "MC1") { fields(t, ["dataset", "windowUs"]); windowUs(t.windowUs); }
  if (ds === "MC2") { fields(t, ["dataset", "rootEventId", "fileId"]); nullableStr(t.rootEventId); nullableStr(t.fileId); }
  if (ds === "CUSTOM") { fields(t, ["dataset", "runId"]); nullableStr(t.runId); }
  validateSelection(b.selection);
  if (b.comparison !== null) {
    const c = object(b.comparison);
    if (c.kind === "window") {
      fields(c, ["kind", "dimension", "currentUs", "baselineMode", "baselineUs"]);
      choice(c.dimension, ["actor", "event_type"]); choice(c.baselineMode, ["auto", "manual"]); windowUs(c.currentUs); windowUs(c.baselineUs);
      if (JSON.stringify(c.currentUs) !== JSON.stringify(currentWindow(f as unknown as Investigation["baseEventFilters"]))) throw new Error("当前比较窗与筛选不一致");
    } else if (c.kind === "runPair" && ds === "CUSTOM") {
      fields(c, ["kind", "runId", "baselineRunId"]); nullableStr(c.runId); nullableStr(c.baselineRunId);
    } else if (c.kind === "history" && ds === "MC2") {
      fields(c, ["kind", "targetRootId", "includedRootIds", "alignment", "beforeUs"]);
      nullableStr(c.targetRootId); strings(c.includedRootIds); choice(c.alignment, ["stage", "postTime"]); us(c.beforeUs);
    } else if (c.kind === "transitions" && ds === "MC2") {
      fields(c, ["kind", "selectedPair", "maxLagUs"]); us(c.maxLagUs);
      if (c.maxLagUs !== null && (c.maxLagUs as number) < 0) throw new Error("转移间隔不能为负");
      if (c.selectedPair !== null) { strings(c.selectedPair); if ((c.selectedPair as string[]).length !== 2) throw new Error("转移必须成对"); }
    } else throw new Error("比较对象与数据集不兼容");
  }
  if (task === "compare" && (b.comparison === null || object(b.comparison).kind !== b.mode)) throw new Error("对照 mode 与对象不一致");
  if (b.mode === "runPair" && t.runId !== object(b.comparison).runId) throw new Error("运行与配对不一致");
  const g = object(b.graph_context);
  fields(g, ["focusedEntityId", "depth", "transform"], ["focusedEntityId", "depth"]);
  nullableStr(g.focusedEntityId); choice(g.depth, [1, 2, 3]);
  if (g.transform !== undefined) { const x = object(g.transform); fields(x, ["x", "y", "k"]); if ([x.x, x.y, x.k].some((n) => typeof n !== "number" || !Number.isFinite(n)) || (x.k as number) <= 0) throw new Error("无效图变换"); }
  object(b.viewports); validateDisplay(b.viewports);
  const collection = object(b.collection_filters);
  fields(collection, ["model", "fixture", "scenario", "observed"]);
  [collection.model, collection.fixture, collection.scenario].forEach(nullableStr); if (collection.observed !== null) bool(collection.observed);
  const r = object(b.replay); fields(r, ["cursorUs", "masking"]); us(r.cursorUs); bool(r.masking);
  nullableStr(b.intervention_position);
  if (ds !== "MC2" && b.intervention_position !== null) throw new Error("干预仅 MC2 支持");
  if (!Array.isArray(b.pinned_evidence)) throw new Error("证据应为数组");
  for (const value of b.pinned_evidence) {
    const e = object(value); fields(e, ["event_id", "dataset", "role", "label", "excerpt"]);
    str(e.event_id); str(e.label); str(e.excerpt); choice(e.role, ["support", "counter", "uncertain"]);
    if (e.dataset !== ds) throw new Error("固定证据跨数据集");
  }
  return b as SnapshotBody;
}
export function validateSnapshot(value: unknown, aliasSummary: string[] = []): UiSnapshot {
  const original = object(value);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > SNAPSHOT_MAX_BYTES) throw new Error("快照超过 256 KiB");
  if (original.contract_version !== 2 || original.ui_state_version !== 1) throw new Error("不支持的快照版本");
  const snapshot = normalizeModes(original, aliasSummary);
  const { contract_version, ui_state_version, return_point, ...b } = snapshot;
  if (contract_version !== 2 || ui_state_version !== 1) throw new Error("不支持的快照版本");
  const parsed = validateBody(b);
  if (return_point !== null) validateBody(return_point, parsed.dataset_id);
  function references(value: unknown) {
    if (Array.isArray(value)) { value.forEach(references); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (["id", "event_id", "rootEventId", "fileId", "actorId", "participantId", "focusedEntityId", "runId", "baselineRunId", "targetRootId", "agentId", "sourceId", "targetId"].includes(key) && typeof v === "string") {
        const prefix = v.split(":")[0];
        if (["MC1", "MC2", "CUSTOM"].includes(prefix) && prefix !== parsed.dataset_id) throw new Error("引用属于另一数据集");
      }
      if (["eventIds", "includedRootIds", "channels"].includes(key) && Array.isArray(v)) {
        v.forEach((id) => references({ id }));
      } else if (key !== "viewports" && key !== "collection_filters") references(v);
    }
  }
  references(snapshot);
  return snapshot as UiSnapshot;
}
function investigation(b: SnapshotBody): Investigation {
  return { dataset: b.dataset_id, task: b.task, mode: b.mode, baseEventFilters: b.base_filters,
    traceObject: b.trace_object, selection: b.selection, comparison: b.comparison,
    taskModes: b.task_modes, viewports: b.viewports, graphContext: b.graph_context,
    collectionFilters: b.collection_filters, replay: b.replay,
    interventionPosition: b.intervention_position, basket: b.pinned_evidence };
}
export function migrateLegacy(value: unknown, dataset: DatasetId): { snapshot: UiSnapshot; summary: string[] } {
  const old = object(value);
  if (old.dataset_id !== undefined && old.dataset_id !== dataset) throw new Error("旧快照数据集不符");
  if (old.contract_version !== undefined && old.contract_version !== 2) throw new Error("旧快照不是微秒契约 v2");
  const raw = old.filters === undefined ? {} : object(old.filters);
  const filters = { ...EMPTY_FILTERS, ...raw } as Filters;
  // Validate before dispatch: a rejected reducer update must never masquerade as restoration.
  validateFilters(baseFilters(filters)); nullableStr(filters.runId);
  for (const key of ["selection", "comparison", "trace_object", "graph_context", "base_filters", "return_point"]) {
    if (old[key] !== undefined && old[key] !== null) object(old[key]);
  }
  if (old.selected_run_id != null) { str(old.selected_run_id); if (dataset !== "CUSTOM") throw new Error("运行不属于当前数据集"); }
  if (old.run_pair != null) { strings(old.run_pair); if (dataset !== "CUSTOM" || (old.run_pair as unknown[]).length !== 2) throw new Error("旧运行配对无效"); }
  let state = initialWorkspace(dataset);
  state = workspaceReducer(state, { type: "filters", patch: filters });
  const summary = ["旧快照已迁移；未记录的配对、视口和子模式不作推测。"];
  if (old.canvas_view !== undefined) choice(old.canvas_view, ["timeline", "graph", "compare", "trace"]);
  if (old.canvas_view === "graph") state = workspaceReducer(state, { type: "canvas", view: "graph" });
  else if (old.canvas_view === "compare") state = workspaceReducer(state, { type: "canvas", view: "compare" });
  else if (old.canvas_view === "trace" && dataset === "MC2") state = workspaceReducer(state, { type: "canvas", view: "trace" });
  if (filters.runId && dataset === "CUSTOM") {
    state = workspaceReducer(state, { type: "openRun", runId: filters.runId });
    state.comparison = null;
    summary.push("旧 filters.runId 优先恢复为运行追踪。");
  } else if (raw.runId && dataset !== "CUSTOM") throw new Error("非 CUSTOM 快照包含 runId");
  else if (dataset === "CUSTOM" && (old.selected_run_id || old.run_pair)) {
    const pair = old.run_pair as string[] | undefined;
    state = workspaceReducer(state, { type: "openRun", runId: (old.selected_run_id as string | undefined) ?? pair![0], baselineRunId: pair?.[1] });
  }
  if (old.selected_event_id != null) { str(old.selected_event_id); state.selection = { kind: "event", id: old.selected_event_id as string, timeUs: null }; }
  if (old.focused_entity_id != null) { str(old.focused_entity_id); state.graphContext.focusedEntityId = old.focused_entity_id as string; }
  if (state.traceObject.dataset === "MC2") {
    if (old.trace_root_id != null) { str(old.trace_root_id); state.traceObject.rootEventId = old.trace_root_id as string; }
    if (old.trace_file_id != null) { str(old.trace_file_id); state.traceObject.fileId = old.trace_file_id as string; }
  }
  if (old.pinned_evidence !== undefined) {
    if (!Array.isArray(old.pinned_evidence)) throw new Error("损坏的固定证据");
    state.basket = old.pinned_evidence.map((v) => {
      const e = object(v); str(e.event_id); choice(e.role, ["support", "counter", "uncertain"]);
      return { event_id: e.event_id as string, dataset, role: e.role as "support" | "counter" | "uncertain", label: typeof e.label === "string" ? e.label : e.event_id as string, excerpt: typeof e.excerpt === "string" ? e.excerpt : "" };
    });
  }
  state.returnStack = [];
  return { snapshot: serializeSnapshot(state), summary };
}
export interface RestoreOptions {
  dataset: DatasetId; savedDataVersion?: string; currentDataVersion?: string;
  missingReferences?: string[]; bounds?: { startUs: number; endUs: number };
}
export function planRestore(value: unknown, options: RestoreOptions): RestorePlan {
  try {
    const original = object(value);
    if (typeof original.ui_state_version === "number" && original.ui_state_version > UI_STATE_VERSION) return { status: "unsupported", original: value, summary: [`UI 快照版本 ${original.ui_state_version} 尚不支持恢复；可查看案例元信息并导出原始 JSON。`] };
    const migrated = original.ui_state_version === undefined;
    const aliasSummary: string[] = [];
    const result = migrated ? migrateLegacy(original, options.dataset) : { snapshot: validateSnapshot(original, aliasSummary), summary: aliasSummary };
    if (result.snapshot.dataset_id !== options.dataset) throw new Error("案例与快照数据集不符");
    const stale = !!options.savedDataVersion && !!options.currentDataVersion && options.savedDataVersion !== options.currentDataVersion;
    const summary = [...result.summary, "已恢复调查引用与显示参数，回放保持暂停；缺失引用保留，未替换为其他对象。"];
    if (stale) summary.push("数据版本已变（stale）；原案例未修改，证据需要重新核验。");
    if (options.missingReferences?.length) summary.push(`缺失引用 ${options.missingReferences.length} 条：${options.missingReferences.join("、")}。原引用保留，请重新定位。`);
    const restored = JSON.parse(JSON.stringify(result.snapshot)) as UiSnapshot;
    if (options.bounds && options.bounds.startUs < options.bounds.endUs) {
      const { startUs, endUs } = options.bounds;
      const clamp = (value: unknown): void => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const entry = value as Record<string, unknown>;
        if (Number.isSafeInteger(entry.startUs) && Number.isSafeInteger(entry.endUs)) {
          const a = Math.max(startUs, entry.startUs as number), b = Math.min(endUs, entry.endUs as number);
          if (a !== entry.startUs || b !== entry.endUs) { entry.startUs = a < b ? a : startUs; entry.endUs = a < b ? b : endUs; summary.push("时间视口已夹取到当前数据/对象边界。"); }
        }
        Object.values(entry).forEach(clamp);
      };
      clamp(restored.viewports);
      // A return point may refer to a different run; clamp it against its own bounds when used later.
    }
    return { status: "ready", investigation: investigation(restored),
      returnPoint: restored.return_point ? investigation(restored.return_point) : null, stale, migrated, summary };
  } catch (error) {
    return { status: "invalid", original: value, summary: [`无法恢复：${error instanceof Error ? error.message : "快照损坏"}`] };
  }
}
/** Construct exactly one reducer action at the call site. */
export function restoreAction(plan: Extract<RestorePlan, { status: "ready" }>) {
  return { type: "restore" as const, investigation: returnPoint(plan.investigation), returnPoint: plan.returnPoint, notice: plan.summary.join(" ") };
}
