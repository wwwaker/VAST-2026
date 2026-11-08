import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState,
  type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createNote, deleteNote, fetchNotes, type NoteItem } from "../data/api";
import { describeFilters, type Filters } from "../data/filterContext";
import { canvasProjection, composeEventFilters, initialWorkspace, legacyCompare, workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { planRestore, restoreAction, serializeSnapshot, type RestoreOptions } from "./snapshot";
import type { BasketItem, CanvasView, CompareReturn, CompareState, DatasetId, Mode, TaskId, WorkspaceState } from "./workspaceTypes";
export type { BasketItem, CanvasView, CompareReturn, CompareState, DatasetId } from "./workspaceTypes";
export type { Filters };
export type EvidenceTab = "message" | "related" | "raw" | "notes" | "basket";
export interface ActiveCase { case_id: string; title: string }
export interface FindingDraft {
  title: string;
  claim: string;
  status: "hypothesis" | "supported" | "inconclusive";
  explanation: string;
  limitations: string;
}
const EMPTY_FINDING_DRAFT: FindingDraft = { title: "", claim: "", status: "hypothesis", explanation: "", limitations: "" };

interface WorkspaceValue {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  changeTask: (task: TaskId, mode?: Mode) => void;
  snapshot: () => ReturnType<typeof serializeSnapshot>;
  restoreSnapshot: (snapshot: unknown, options: RestoreOptions) => ReturnType<typeof planRestore>;
  /** 每次成功恢复 +1；页面用它重新应用"选中对象/工具/面板"映射，而不是把 task/mode 当唯一触发器。 */
  restoreSeq: number;
  /** 最近一次恢复中被判定缺失的引用；缺失对象保留但不再打开阅读面板。 */
  restoreMissing: string[];
  dataset: DatasetId; setDataset: (id: DatasetId) => void;
  filters: Filters; setFilters: (patch: Partial<Filters>) => void; clearFilters: () => void; filterSummary: string;
  selectedEventId: string | null; selectedEventAt: number | null;
  selectEvent: (id: string | null, atUs?: number | null) => void;
  canvasView: CanvasView; setCanvasView: (view: CanvasView) => void;
  compareState: CompareState; setCompareState: (patch: Partial<CompareState>) => void;
  compareReturn: CompareReturn | null; saveCompareReturn: (snapshot: CompareReturn) => void;
  restoreCompare: () => void; clearCompareReturn: () => void;
  focusedEntityId: string | null; focusEntity: (id: string | null, options?: { switchView?: boolean; onlyIfEmpty?: boolean }) => void;
  traceRootId: string | null; traceFileId: string | null;
  openTrace: (options?: { rootEventId?: string | null; fileId?: string | null }) => void;
  evidenceOpen: boolean; setEvidenceOpen: (open: boolean) => void;
  evidenceTab: EvidenceTab; setEvidenceTab: (tab: EvidenceTab) => void;
  cursor: number | null; setCursor: Dispatch<SetStateAction<number | null>>;
  playing: boolean; setPlaying: (playing: boolean) => void; togglePlaying: () => void;
  stepCursor: (direction: 1 | -1, stepUs: number) => void;
  masking: boolean; setMasking: (on: boolean) => void;
  basket: BasketItem[]; addToBasket: (item: BasketItem) => void;
  removeFromBasket: (eventId: string, role: BasketItem["role"]) => void; clearBasket: () => void;
  activeCase: ActiveCase | null; setActiveCase: (value: ActiveCase | null, expectedDataset?: DatasetId) => void;
  findingDraft: FindingDraft; setFindingDraft: (patch: Partial<FindingDraft>) => void;
  noteDraft: string; setNoteDraft: (value: string) => void;
  notes: NoteItem[]; notesLoading: boolean; refreshNotes: () => Promise<void>;
  addNote: (body: string, options?: { eventId?: string | null; eventTime?: number | null }) => Promise<void>;
  removeNote: (noteId: number) => Promise<void>;
}
const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => initialWorkspace());
  const stateRef = useRef(state);
  stateRef.current = state;
  // Layout and server content do not duplicate investigation state.
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>("message");
  const [activeCaseState, setActiveCaseState] = useState<(ActiveCase & { dataset: DatasetId }) | null>(null);
  const [findingDrafts, setFindingDrafts] = useState<Record<string, FindingDraft>>({});
  const [noteDrafts, setNoteDrafts] = useState<Partial<Record<DatasetId, string>>>({});
  const [notesState, setNotes] = useState<{ dataset: DatasetId; items: NoteItem[] }>({ dataset: state.dataset, items: [] });
  const [notesLoading, setNotesLoading] = useState(false);
  const dataset = state.dataset;
  const filters = useMemo(() => composeEventFilters(state.baseEventFilters, state.traceObject), [state.baseEventFilters, state.traceObject]);
  const filterSummary = useMemo(() => describeFilters(filters), [filters]);
  const notes = notesState.dataset === dataset ? notesState.items : [];
  const activeCase = activeCaseState?.dataset === dataset ? activeCaseState : null;
  const findingDraftKey = `${dataset}:${activeCase?.case_id ?? "new"}`;
  const findingDraft = findingDrafts[findingDraftKey] ?? EMPTY_FINDING_DRAFT;
  const noteDraft = noteDrafts[dataset] ?? "";

  const refreshNotes = useCallback(async () => {
    const requestedDataset = stateRef.current.dataset;
    setNotesLoading(true);
    try {
      const data = await fetchNotes(requestedDataset);
      if (stateRef.current.dataset === requestedDataset) setNotes({ dataset: requestedDataset, items: data.items });
    } catch {
      if (stateRef.current.dataset === requestedDataset) setNotes({ dataset: requestedDataset, items: [] });
    } finally { if (stateRef.current.dataset === requestedDataset) setNotesLoading(false); }
  }, []);
  useEffect(() => { void refreshNotes(); }, [dataset, refreshNotes]);

  const setDataset = useCallback((id: DatasetId) => {
    if (id === stateRef.current.dataset) return;
    dispatch({ type: "dataset", dataset: id });
    setActiveCaseState(null); setEvidenceOpen(false);
  }, []);
  const selectEvent = useCallback((id: string | null, atUs?: number | null) => {
    dispatch({ type: "inspect", selection: id ? { kind: "event", id, timeUs: atUs ?? null } : null });
  }, []);
  const setCursor = useCallback<Dispatch<SetStateAction<number | null>>>((value) => {
    dispatch({ type: "cursor", value });
  }, []);
  const addNote = useCallback(async (body: string, options?: { eventId?: string | null; eventTime?: number | null }) => {
    if (!body.trim()) return;
    const requestedDataset = stateRef.current.dataset;
    const created = await createNote({ dataset_id: requestedDataset, body: body.trim(), event_id: options?.eventId ?? null,
      event_time: options?.eventTime ?? null, filter_summary: describeFilters(composeEventFilters(stateRef.current.baseEventFilters, stateRef.current.traceObject)) });
    if (stateRef.current.dataset === requestedDataset) setNotes((prev) => ({ dataset: requestedDataset, items: [created, ...(prev.dataset === requestedDataset ? prev.items : [])] }));
  }, []);
  const removeNote = useCallback(async (noteId: number) => {
    await deleteNote(noteId);
    setNotes((prev) => ({ ...prev, items: prev.items.filter((n) => n.note_id !== noteId) }));
  }, []);
  const snapshot = useCallback(() => serializeSnapshot(stateRef.current), []);
  const [restoreSeq, setRestoreSeq] = useState(0);
  const [restoreMissing, setRestoreMissing] = useState<string[]>([]);
  const restoreSnapshot = useCallback<WorkspaceValue["restoreSnapshot"]>((value, options) => {
    const plan = planRestore(value, options);
    if (plan.status === "ready") {
      dispatch(restoreAction(plan));
      setActiveCaseState(null); setEvidenceOpen(false);
      setRestoreMissing(options.missingReferences ?? []);
      setRestoreSeq((count) => count + 1);
    }
    return plan;
  }, []);
  const value: WorkspaceValue = {
    state, dispatch, dataset, setDataset, filters, filterSummary,
    changeTask: (task, mode) => dispatch({ type: "task", task, mode }), snapshot, restoreSnapshot, restoreSeq, restoreMissing,
    setFilters: (patch) => dispatch({ type: "filters", patch }), clearFilters: () => dispatch({ type: "clearFilters" }),
    selectedEventId: state.selection?.kind === "event" ? state.selection.id : null,
    selectedEventAt: state.selection?.kind === "event" ? state.selection.timeUs : null, selectEvent,
    canvasView: canvasProjection(state), setCanvasView: (view) => dispatch({ type: "canvas", view }),
    compareState: legacyCompare(state), setCompareState: (patch) => dispatch({ type: "comparePatch", patch }),
    compareReturn: state.returnStack.at(-1)?.comparison?.kind === "window" ? {
      filters: composeEventFilters(state.returnStack.at(-1)!.baseEventFilters, state.returnStack.at(-1)!.traceObject), compare: legacyCompare(state.returnStack.at(-1)!) } : null,
    saveCompareReturn: () => dispatch({ type: "pushReturn" }), restoreCompare: () => dispatch({ type: "return" }), clearCompareReturn: () => dispatch({ type: "clearReturn" }),
    focusedEntityId: state.graphContext.focusedEntityId,
    focusEntity: (id, options) => dispatch({ type: "focus", id, ...options }),
    traceRootId: state.traceObject.dataset === "MC2" ? state.traceObject.rootEventId : null,
    traceFileId: state.traceObject.dataset === "MC2" ? state.traceObject.fileId : null,
    openTrace: (options) => dispatch({ type: "openTrace", ...options }),
    evidenceOpen, setEvidenceOpen, evidenceTab, setEvidenceTab,
    cursor: state.replay.cursorUs, setCursor, playing: state.playing,
    setPlaying: (playing) => dispatch({ type: "replay", playing }), togglePlaying: () => dispatch({ type: "togglePlaying" }),
    stepCursor: (direction, stepUs) => dispatch({ type: "step", deltaUs: direction * stepUs }),
    masking: state.replay.masking, setMasking: (masking) => dispatch({ type: "replay", masking }),
    basket: state.basket, addToBasket: (item) => dispatch({ type: "basketAdd", item }),
    removeFromBasket: (eventId, role) => dispatch({ type: "basketRemove", eventId, role }), clearBasket: () => dispatch({ type: "display", patch: { basket: [] } }),
    activeCase, setActiveCase: (item, expectedDataset) => {
      if (expectedDataset && stateRef.current.dataset !== expectedDataset) return;
      setActiveCaseState(item ? { ...item, dataset: stateRef.current.dataset } : null);
    },
    findingDraft,
    setFindingDraft: (patch) => setFindingDrafts((prev) => ({ ...prev, [findingDraftKey]: { ...(prev[findingDraftKey] ?? EMPTY_FINDING_DRAFT), ...patch } })),
    noteDraft,
    setNoteDraft: (value) => setNoteDrafts((prev) => ({ ...prev, [dataset]: value })),
    notes, notesLoading, refreshNotes, addNote, removeNote,
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace 必须在 WorkspaceProvider 内使用");
  return ctx;
}
