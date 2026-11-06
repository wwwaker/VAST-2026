import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createNote, deleteNote, fetchNotes, type NoteItem } from "../data/api";
import {
  EMPTY_FILTERS,
  describeFilters,
  type Filters,
} from "../data/filterContext";

export type DatasetId = "MC1" | "MC2" | "CUSTOM";
export type { Filters };

/** 主画布视图：共享同一套筛选与选中状态；trace 仅 MC2 可用 */
export type CanvasView = "timeline" | "graph" | "compare" | "trace";

export type EvidenceTab = "message" | "related" | "raw" | "notes" | "basket";

/** 证据篮条目：只保存引用与角色，不复制事件内容 */
export interface BasketItem {
  event_id: string;
  dataset: DatasetId;
  role: "support" | "counter" | "uncertain";
  label: string;
  excerpt: string;
}

export interface ActiveCase {
  case_id: string;
  title: string;
}

interface WorkspaceValue {
  dataset: DatasetId;
  setDataset: (id: DatasetId) => void;

  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
  clearFilters: () => void;
  filterSummary: string;

  selectedEventId: string | null;
  /** 选中事件的微秒时间，用于在时间线上标位置 */
  selectedEventAt: number | null;
  selectEvent: (id: string | null, atUs?: number | null) => void;

  canvasView: CanvasView;
  setCanvasView: (view: CanvasView) => void;
  /** 关系图的聚焦实体；只是探索中心，不等于 participant 筛选 */
  focusedEntityId: string | null;
  focusEntity: (id: string | null, options?: { switchView?: boolean }) => void;

  /** MC2 来源链：链根事件与被查看的文件；切换数据集时清空 */
  traceRootId: string | null;
  traceFileId: string | null;
  openTrace: (options?: { rootEventId?: string | null; fileId?: string | null }) => void;

  evidenceOpen: boolean;
  setEvidenceOpen: (open: boolean) => void;
  evidenceTab: EvidenceTab;
  setEvidenceTab: (tab: EvidenceTab) => void;

  /** 回放游标：整数微秒 */
  cursor: number | null;
  setCursor: Dispatch<SetStateAction<number | null>>;
  playing: boolean;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  stepCursor: (direction: 1 | -1, stepUs: number) => void;
  masking: boolean;
  setMasking: (on: boolean) => void;

  /** 证据篮与当前案例：结论必须挂在一个案例上，证据来自篮内引用 */
  basket: BasketItem[];
  addToBasket: (item: BasketItem) => void;
  removeFromBasket: (eventId: string, role: BasketItem["role"]) => void;
  clearBasket: () => void;
  activeCase: ActiveCase | null;
  setActiveCase: (value: ActiveCase | null) => void;

  /** 笔记存在后端，刷新页面不丢 */
  notes: NoteItem[];
  notesLoading: boolean;
  refreshNotes: () => Promise<void>;
  addNote: (
    body: string,
    options?: { eventId?: string | null; eventTime?: number | null },
  ) => Promise<void>;
  removeNote: (noteId: number) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [dataset, setDatasetState] = useState<DatasetId>("MC2");
  const [filters, setFiltersState] = useState<Filters>(EMPTY_FILTERS);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEventAt, setSelectedEventAt] = useState<number | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [canvasView, setCanvasView] = useState<CanvasView>("timeline");
  const [focusedEntityId, setFocusedEntityId] = useState<string | null>(null);
  const [traceRootId, setTraceRootId] = useState<string | null>(null);
  const [traceFileId, setTraceFileId] = useState<string | null>(null);
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>("message");
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [masking, setMasking] = useState(true);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [activeCase, setActiveCase] = useState<ActiveCase | null>(null);

  /** 切换数据集必须清空调查状态：时间轴不可比，旧的焦点/运行/游标会串到新数据集 */
  const setDataset = useCallback((id: DatasetId) => {
    setDatasetState(id);
    setFiltersState(EMPTY_FILTERS);
    setSelectedEventId(null);
    setSelectedEventAt(null);
    setFocusedEntityId(null);
    setTraceRootId(null);
    setTraceFileId(null);
    // 一条结论只能用一个数据集的证据，换数据集时清空篮子与当前案例
    setBasket([]);
    setActiveCase(null);
    setEvidenceOpen(false);
    setCursor(null);
    setPlaying(false);
    if (canvasView === "trace") setCanvasView("timeline");
  }, [canvasView]);

  const setFilters = useCallback((patch: Partial<Filters>) => {
    setFiltersState((prev) => ({ ...prev, ...patch }));
  }, []);

  const clearFilters = useCallback(() => setFiltersState(EMPTY_FILTERS), []);

  const selectEvent = useCallback((id: string | null, atUs?: number | null) => {
    setSelectedEventId(id);
    setSelectedEventAt(id ? (atUs ?? null) : null);
    if (id) setEvidenceOpen(true);
  }, []);

  const addToBasket = useCallback((item: BasketItem) => {
    setBasket((prev) => {
      const exists = prev.some((entry) => entry.event_id === item.event_id && entry.role === item.role);
      return exists ? prev : [...prev, item];
    });
  }, []);

  const removeFromBasket = useCallback((eventId: string, role: BasketItem["role"]) => {
    setBasket((prev) => prev.filter((entry) => !(entry.event_id === eventId && entry.role === role)));
  }, []);

  const clearBasket = useCallback(() => setBasket([]), []);

  const focusEntity = useCallback(
    (id: string | null, options?: { switchView?: boolean }) => {
      setFocusedEntityId(id);
      if (options?.switchView) setCanvasView("graph");
    },
    [],
  );

  /** 打开来源链：可同时指定链根与被查看文件；只切换视图而不改筛选 */
  const openTrace = useCallback(
    (options?: { rootEventId?: string | null; fileId?: string | null }) => {
      if (options && "rootEventId" in options) setTraceRootId(options.rootEventId ?? null);
      if (options && "fileId" in options) setTraceFileId(options.fileId ?? null);
      setCanvasView("trace");
    },
    [],
  );

  const filterSummary = useMemo(() => describeFilters(filters), [filters]);

  const refreshNotes = useCallback(async () => {
    setNotesLoading(true);
    try {
      const data = await fetchNotes(dataset);
      setNotes(data.items);
    } catch {
      // 后端不可用时保持空列表，不阻塞其它功能
      setNotes([]);
    } finally {
      setNotesLoading(false);
    }
  }, [dataset]);

  useEffect(() => {
    void refreshNotes();
  }, [refreshNotes]);

  const addNote = useCallback(
    async (body: string, options?: { eventId?: string | null; eventTime?: number | null }) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const created = await createNote({
        dataset_id: dataset,
        body: trimmed,
        event_id: options?.eventId ?? null,
        // v2 统一写入微秒；旧笔记的秒值在展示端按数量级归一化
        event_time: options?.eventTime ?? null,
        filter_summary: filterSummary,
      });
      setNotes((prev) => [created, ...prev]);
    },
    [dataset, filterSummary],
  );

  const removeNote = useCallback(async (noteId: number) => {
    await deleteNote(noteId);
    setNotes((prev) => prev.filter((n) => n.note_id !== noteId));
  }, []);

  const stepCursor = useCallback((direction: 1 | -1, stepUs: number) => {
    setCursor((prev) => (prev == null ? null : prev + direction * stepUs));
  }, []);

  const togglePlaying = useCallback(() => setPlaying((value) => !value), []);

  const value = useMemo<WorkspaceValue>(
    () => ({
      dataset,
      setDataset,
      filters,
      setFilters,
      clearFilters,
      filterSummary,
      selectedEventId,
      selectedEventAt,
      selectEvent,
      canvasView,
      setCanvasView,
      focusedEntityId,
      focusEntity,
      traceRootId,
      traceFileId,
      openTrace,
      basket,
      addToBasket,
      removeFromBasket,
      clearBasket,
      activeCase,
      setActiveCase,
      evidenceOpen,
      setEvidenceOpen,
      evidenceTab,
      setEvidenceTab,
      cursor,
      setCursor,
      playing,
      setPlaying,
      togglePlaying,
      stepCursor,
      masking,
      setMasking,
      notes,
      notesLoading,
      refreshNotes,
      addNote,
      removeNote,
    }),
    [
      dataset,
      setDataset,
      filters,
      setFilters,
      clearFilters,
      filterSummary,
      selectedEventId,
      selectedEventAt,
      selectEvent,
      canvasView,
      focusedEntityId,
      focusEntity,
      traceRootId,
      traceFileId,
      openTrace,
      basket,
      addToBasket,
      removeFromBasket,
      clearBasket,
      activeCase,
      evidenceOpen,
      evidenceTab,
      cursor,
      playing,
      togglePlaying,
      stepCursor,
      masking,
      notes,
      notesLoading,
      refreshNotes,
      addNote,
      removeNote,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace 必须在 WorkspaceProvider 内使用");
  return ctx;
}
