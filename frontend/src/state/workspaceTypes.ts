import type { Filters } from "../data/filterContext";

export type DatasetId = "MC1" | "MC2" | "CUSTOM";
export type TaskId = "overview" | "trace" | "compare" | "findings";
export type CanvasView = "timeline" | "graph" | "compare" | "trace";
export type Mode = "activity" | "time" | "relations" | "system" | "runs" | "decision" |
  "source" | "localGraph" | "intervention" | "run" | "window" | "history" | "transitions" | "runPair" | "claims" | "notes";
export type BaseEventFilters = Omit<Filters, "runId">;
export type UsWindow = [number, number];
export type SelectedRef =
  | { kind: "event"; id: string; timeUs: number | null }
  | { kind: "entity" | "file" | "context" | "rule"; id: string }
  | { kind: "activityCell"; agentId: string; bucketKey: string }
  | { kind: "graphEdge"; sourceId: string; targetId: string; relation: string; derivation: string }
  | { kind: "transitionCell"; fromType: string; toType: string }
  | { kind: "eventGroup"; viewId: string; eventIds: string[] }
  | { kind: "gap"; scopeId: string; key: string };
export type TraceObject =
  | { dataset: "MC1"; windowUs: UsWindow | null }
  | { dataset: "MC2"; rootEventId: string | null; fileId: string | null }
  | { dataset: "CUSTOM"; runId: string | null };
export type ComparisonContext =
  | { kind: "window"; dimension: "actor" | "event_type"; currentUs: UsWindow | null;
      baselineMode: "auto" | "manual"; baselineUs: UsWindow | null }
  | { kind: "history"; targetRootId: string | null; includedRootIds: string[];
      alignment: "stage" | "postTime"; beforeUs: number | null }
  | { kind: "runPair"; runId: string | null; baselineRunId: string | null }
  | { kind: "transitions"; selectedPair: [string, string] | null; maxLagUs: number | null };
export interface CompareState {
  dimension: "actor" | "event_type";
  mode: "auto" | "manual";
  baselineStartUs: number | null;
  baselineEndUs: number | null;
}
export interface CompareReturn { filters: Filters; compare: CompareState }
export interface BasketItem {
  event_id: string; dataset: DatasetId; role: "support" | "counter" | "uncertain";
  label: string; excerpt: string;
}
export interface RunCollectionFilters {
  model: string | null; fixture: string | null; scenario: string | null; observed: boolean | null;
}
/** JSON-only display parameters. No DOM, API payload, timer or hover. */
export type DisplayValue = null | boolean | number | string | DisplayValue[] | { [key: string]: DisplayValue };
export interface Investigation {
  dataset: DatasetId;
  task: TaskId;
  mode: Mode;
  taskModes: Record<TaskId, Mode>;
  baseEventFilters: BaseEventFilters;
  traceObject: TraceObject;
  selection: SelectedRef | null;
  comparison: ComparisonContext | null;
  viewports: Record<string, DisplayValue>;
  graphContext: { focusedEntityId: string | null; depth: 1 | 2 | 3; transform?: { x: number; y: number; k: number } };
  collectionFilters: RunCollectionFilters;
  replay: { cursorUs: number | null; masking: boolean };
  interventionPosition: string | null;
  basket: BasketItem[];
}
export interface WorkspaceState extends Investigation {
  returnStack: Investigation[];
  playing: boolean;
  notice: string | null;
}
