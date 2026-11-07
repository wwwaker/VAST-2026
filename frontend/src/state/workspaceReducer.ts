import { EMPTY_FILTERS, type Filters } from "../data/filterContext";
import type { BaseEventFilters, CanvasView, CompareState, ComparisonContext, DatasetId, Investigation,
  Mode, SelectedRef, TaskId, TraceObject, WorkspaceState } from "./workspaceTypes";

export const CAPABILITIES: Record<DatasetId, Record<TaskId, readonly Mode[]>> = {
  MC1: { overview: ["activity", "time", "relations"], trace: ["decision", "localGraph"], compare: ["window"], findings: ["claims", "notes"] },
  MC2: { overview: ["system", "time", "relations"], trace: ["source", "localGraph", "intervention"], compare: ["history", "window", "transitions"], findings: ["claims", "notes"] },
  CUSTOM: { overview: ["runs", "time", "relations"], trace: ["run", "localGraph"], compare: ["runPair", "window"], findings: ["claims", "notes"] },
};
export function baseFilters(filters: Filters): BaseEventFilters {
  const { runId: _runId, ...base } = filters;
  return base;
}
export function emptyTrace(dataset: DatasetId): TraceObject {
  return dataset === "MC2" ? { dataset, rootEventId: null, fileId: null } :
    dataset === "CUSTOM" ? { dataset, runId: null } : { dataset, windowUs: null };
}
export function initialWorkspace(dataset: DatasetId = "MC2"): WorkspaceState {
  const taskModes = Object.fromEntries(Object.entries(CAPABILITIES[dataset]).map(([key, values]) => [key, values[0]])) as Record<TaskId, Mode>;
  return { dataset, task: "overview", mode: taskModes.overview, taskModes,
    baseEventFilters: baseFilters({ ...EMPTY_FILTERS }), traceObject: emptyTrace(dataset),
    selection: null, comparison: null, viewports: {}, graphContext: { focusedEntityId: null, depth: 1 },
    collectionFilters: { model: null, fixture: null, scenario: null, observed: null },
    replay: { cursorUs: null, masking: true }, interventionPosition: null, basket: [],
    returnStack: [], playing: false, notice: null };
}
export function composeEventFilters(base: BaseEventFilters, object: TraceObject): Filters {
  return { ...base, runId: object.dataset === "CUSTOM" ? object.runId : null };
}
export function currentWindow(base: BaseEventFilters): [number, number] | null {
  return base.startUs != null && base.endUs != null ? [base.startUs, base.endUs] : null;
}
export function supportsPlayback(state: Investigation): boolean {
  return !(state.mode === "system" || state.mode === "history" || state.mode === "intervention" || state.mode === "runPair");
}
export function windowComparison(state: Investigation): Extract<ComparisonContext, { kind: "window" }> {
  return state.comparison?.kind === "window" ? state.comparison : {
    kind: "window", dimension: "event_type", currentUs: currentWindow(state.baseEventFilters), baselineMode: "auto", baselineUs: null,
  };
}
export function legacyCompare(state: Investigation): CompareState {
  const c = windowComparison(state);
  return { dimension: c.dimension, mode: c.baselineMode, baselineStartUs: c.baselineUs?.[0] ?? null, baselineEndUs: c.baselineUs?.[1] ?? null };
}
export function canvasProjection(state: Investigation): CanvasView {
  if (state.mode === "relations" || state.mode === "localGraph" || (state.mode === "system" && state.dataset === "MC2")) return "graph";
  if (state.task === "compare" && state.mode === "window") return "compare";
  if (state.dataset === "MC2" && (state.task === "trace" || state.task === "compare")) return "trace";
  return "timeline";
}
export function returnPoint(state: Investigation): Investigation {
  const { dataset, task, mode, taskModes, baseEventFilters, traceObject, selection, comparison,
    viewports, graphContext, collectionFilters, replay, interventionPosition, basket } = state;
  return { dataset, task, mode, taskModes, baseEventFilters, traceObject, selection, comparison,
    viewports, graphContext, collectionFilters, replay, interventionPosition, basket };
}
function pushReturn(state: WorkspaceState): Investigation[] {
  const point = returnPoint(state);
  const previous = state.returnStack.at(-1);
  return JSON.stringify(previous) === JSON.stringify(point) ? state.returnStack : [...state.returnStack, point].slice(-20);
}
function chooseMode(state: WorkspaceState, task: TaskId, proposed?: Mode): WorkspaceState {
  const supported = CAPABILITIES[state.dataset][task];
  const wanted = proposed ?? state.taskModes[task];
  const mode = supported.includes(wanted) ? wanted : supported[0];
  return { ...state, task, mode, taskModes: { ...state.taskModes, [task]: mode },
    playing: false, notice: mode !== wanted ? `当前数据集不支持 ${wanted}，已切换为 ${mode}` : state.notice };
}
export type WorkspaceAction =
  | { type: "dataset"; dataset: DatasetId }
  | { type: "task"; task: TaskId; mode?: Mode }
  | { type: "canvas"; view: CanvasView }
  | { type: "filters"; patch: Partial<Filters> }
  | { type: "clearFilters" }
  | { type: "inspect"; selection: SelectedRef | null }
  | { type: "focus"; id: string | null; switchView?: boolean; onlyIfEmpty?: boolean }
  | { type: "openTrace"; rootEventId?: string | null; fileId?: string | null }
  | { type: "openRun"; runId: string; baselineRunId?: string | null; complete?: boolean; compare?: boolean }
  | { type: "comparison"; comparison: ComparisonContext | null }
  | { type: "comparePatch"; patch: Partial<CompareState> }
  | { type: "drillFilters"; patch: Partial<Filters> }
  | { type: "resolvedPair"; runId: string; baselineRunId: string }
  | { type: "resolvedWindow"; currentUs: [number, number]; baselineUs: [number, number] }
  | { type: "pushReturn" } | { type: "return" } | { type: "clearReturn" }
  | { type: "replay"; cursorUs?: number | null; masking?: boolean; playing?: boolean }
  | { type: "cursor"; value: number | null | ((previous: number | null) => number | null) }
  | { type: "togglePlaying" } | { type: "step"; deltaUs: number }
  | { type: "basketAdd"; item: Investigation["basket"][number] }
  | { type: "basketRemove"; eventId: string; role: Investigation["basket"][number]["role"] }
  | { type: "display"; patch: Partial<Pick<Investigation, "viewports" | "graphContext" | "collectionFilters" | "interventionPosition" | "basket">> }
  | { type: "restore"; investigation: Investigation; returnPoint: Investigation | null; notice: string }
  | { type: "reset" };

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "dataset": return action.dataset === state.dataset ? state : initialWorkspace(action.dataset);
    case "reset": return initialWorkspace(state.dataset);
    case "task": {
      let next = chooseMode(state, action.task, action.mode);
      // CUSTOM runs are scoped to the trace/run task. MC2's root/file context is
      // investigation context and must survive ordinary task navigation.
      if (action.task === "overview" && state.dataset === "CUSTOM") next = { ...next, traceObject: emptyTrace(state.dataset) };
      if (action.task === "compare") {
        const comparison = next.mode === "window" ? windowComparison(next) :
          next.mode === "history" ? (state.comparison?.kind === "history" ? state.comparison : { kind: "history" as const, targetRootId: state.traceObject.dataset === "MC2" ? state.traceObject.rootEventId : null, includedRootIds: [], alignment: "stage" as const, beforeUs: null }) :
          next.mode === "transitions" ? (state.comparison?.kind === "transitions" ? state.comparison : { kind: "transitions" as const, selectedPair: null, maxLagUs: null }) :
          (state.comparison?.kind === "runPair" ? state.comparison : { kind: "runPair" as const, runId: state.traceObject.dataset === "CUSTOM" ? state.traceObject.runId : null, baselineRunId: null });
        next = { ...next, comparison,
          traceObject: comparison.kind === "runPair" ? { dataset: "CUSTOM", runId: comparison.runId } : next.traceObject };
      }
      return next;
    }
    case "canvas": {
      if (action.view === "trace") return state.dataset === "MC2" ? chooseMode(state, "trace", "source") : { ...chooseMode(state, "overview"), notice: "来源链仅 MC2 支持，已返回概览" };
      if (action.view === "compare") return { ...chooseMode(state, "compare", "window"), comparison: windowComparison(state) };
      if (action.view === "graph") return chooseMode(state, "overview", "relations");
      return { ...chooseMode(state, "overview", state.dataset === "CUSTOM" ? "runs" : state.dataset === "MC1" ? "activity" : "time"), traceObject: emptyTrace(state.dataset) };
    }
    case "filters": {
      const { runId, ...patch } = action.patch;
      const base = { ...state.baseEventFilters, ...patch };
      if ((base.startUs != null && !Number.isSafeInteger(base.startUs)) || (base.endUs != null && !Number.isSafeInteger(base.endUs)) ||
          (base.startUs != null && base.endUs != null && base.startUs >= base.endUs)) return { ...state, notice: "时间范围必须是整数微秒半开窗口" };
      return { ...state, baseEventFilters: base,
        traceObject: runId !== undefined && state.dataset === "CUSTOM" ? { dataset: "CUSTOM", runId } : state.traceObject,
        comparison: state.comparison?.kind === "window" ? { ...state.comparison, currentUs: currentWindow(base) } :
          state.comparison?.kind === "runPair" && runId !== undefined ? { ...state.comparison, runId,
            baselineRunId: runId === state.comparison.runId ? state.comparison.baselineRunId : null } : state.comparison };
    }
    case "clearFilters": return workspaceReducer(state, { type: "filters", patch: baseFilters(EMPTY_FILTERS) });
    case "inspect": return { ...state, selection: action.selection };
    case "focus": return action.onlyIfEmpty && state.graphContext.focusedEntityId ? state : { ...(action.switchView ? chooseMode(state, "overview", "relations") : state), graphContext: { ...state.graphContext, focusedEntityId: action.id } };
    case "openTrace": {
      if (state.dataset !== "MC2" || state.traceObject.dataset !== "MC2") return { ...state, notice: "来源链仅 MC2 支持" };
      const object = { ...state.traceObject };
      if ("rootEventId" in action) object.rootEventId = action.rootEventId ?? null;
      if ("fileId" in action) object.fileId = action.fileId ?? null;
      return { ...chooseMode(state, "trace", "source"), traceObject: object, returnStack: pushReturn(state) };
    }
    case "openRun": {
      if (state.dataset !== "CUSTOM") return { ...state, notice: "运行仅 CUSTOM 支持" };
      const compare = action.compare || !!action.baselineRunId;
      const next = chooseMode(state, compare ? "compare" : "trace", compare ? "runPair" : "run");
      const base = action.complete ? baseFilters(EMPTY_FILTERS) : state.baseEventFilters;
      return { ...next, traceObject: { dataset: "CUSTOM", runId: action.runId },
        baseEventFilters: base,
        comparison: compare ? { kind: "runPair", runId: action.runId, baselineRunId: action.baselineRunId ?? null } :
          state.comparison?.kind === "runPair" ? { ...state.comparison, runId: action.runId, baselineRunId: state.comparison.runId === action.runId ? state.comparison.baselineRunId : null } :
          state.comparison?.kind === "window" ? { ...state.comparison, currentUs: currentWindow(base) } : state.comparison,
        selection: null, replay: { ...state.replay, cursorUs: null }, returnStack: pushReturn(state) };
    }
    case "comparison": {
      const c = action.comparison;
      if (c && ((c.kind === "runPair" && state.dataset !== "CUSTOM") || ((c.kind === "history" || c.kind === "transitions") && state.dataset !== "MC2"))) return { ...state, notice: "比较对象不适用于当前数据集" };
      if (!c && state.task === "compare") return workspaceReducer({ ...state, comparison: null }, { type: "task", task: "compare" });
      return { ...(c && state.task === "compare" ? chooseMode(state, "compare", c.kind) : state),
        traceObject: c?.kind === "runPair" ? { dataset: "CUSTOM", runId: c.runId } : state.traceObject,
        comparison: c?.kind === "window" ? { ...c, currentUs: currentWindow(state.baseEventFilters) } : c };
    }
    case "resolvedPair": return state.comparison?.kind === "runPair" && state.comparison.runId === action.runId && state.comparison.baselineRunId === null ? { ...state, comparison: { ...state.comparison, baselineRunId: action.baselineRunId } } : state;
    case "resolvedWindow": return state.comparison?.kind === "window" && state.comparison.baselineMode === "auto" && JSON.stringify(state.comparison.currentUs) === JSON.stringify(action.currentUs) && JSON.stringify(state.comparison.baselineUs) !== JSON.stringify(action.baselineUs) ? { ...state, comparison: { ...state.comparison, baselineUs: action.baselineUs } } : state;
    case "comparePatch": {
      const legacy = { ...legacyCompare(state), ...action.patch };
      return { ...(state.task === "compare" ? chooseMode(state, "compare", "window") : state), comparison: { ...windowComparison(state), dimension: legacy.dimension, baselineMode: legacy.mode,
        baselineUs: legacy.baselineStartUs != null && legacy.baselineEndUs != null ? [legacy.baselineStartUs, legacy.baselineEndUs] : null } };
    }
    case "drillFilters": {
      const next = workspaceReducer(state, { type: "filters", patch: action.patch });
      return { ...next, task: "overview", mode: state.dataset === "CUSTOM" ? "runs" : state.dataset === "MC1" ? "activity" : "time",
        taskModes: { ...next.taskModes, overview: state.dataset === "CUSTOM" ? "runs" : state.dataset === "MC1" ? "activity" : "time" },
        returnStack: pushReturn(state), playing: false };
    }
    case "pushReturn": return { ...state, returnStack: pushReturn(state) };
    case "clearReturn": return { ...state, returnStack: [] };
    case "return": {
      const point = state.returnStack.at(-1);
      return point ? { ...state, ...point, playing: false, returnStack: state.returnStack.slice(0, -1) } : state;
    }
    case "replay": return { ...state, replay: { cursorUs: action.cursorUs !== undefined ? action.cursorUs : state.replay.cursorUs, masking: action.masking ?? state.replay.masking }, playing: supportsPlayback(state) ? action.playing ?? state.playing : false };
    case "cursor": return { ...state, replay: { ...state.replay, cursorUs: typeof action.value === "function" ? action.value(state.replay.cursorUs) : action.value } };
    case "togglePlaying": return supportsPlayback(state) ? { ...state, playing: !state.playing } : { ...state, playing: false, notice: "当前视角展示完整对象/回溯集合，不随回放重建；已保持暂停。" };
    case "basketAdd": return action.item.dataset !== state.dataset || state.basket.some((e) => e.event_id === action.item.event_id && e.role === action.item.role) ? state : { ...state, basket: [...state.basket, action.item] };
    case "basketRemove": return { ...state, basket: state.basket.filter((e) => e.event_id !== action.eventId || e.role !== action.role) };
    case "step": return { ...state, replay: { ...state.replay, cursorUs: state.replay.cursorUs == null ? null : state.replay.cursorUs + action.deltaUs } };
    case "display": return { ...state, ...action.patch };
    case "restore": return { ...state, ...action.investigation, returnStack: action.returnPoint ? [action.returnPoint] : [], playing: false, notice: action.notice };
  }
}
