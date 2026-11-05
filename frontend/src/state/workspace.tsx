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

export type DatasetId = "MC1" | "MC2" | "CUSTOM";

/** 主画布视图：三个切面共享同一套筛选与选中状态 */
export type CanvasView = "timeline" | "graph" | "compare";

export interface Filters {
  /** 时间窗口，epoch 秒；null 表示未裁剪 */
  from: number | null;
  to: number | null;
  /** 选中的类别 id；空数组表示不过滤 */
  categories: number[];
  actorId: string | null;
  keyword: string;
}

const EMPTY_FILTERS: Filters = { from: null, to: null, categories: [], actorId: null, keyword: "" };

export type EvidenceTab = "message" | "related" | "raw" | "notes";

interface WorkspaceValue {
  dataset: DatasetId;
  setDataset: (id: DatasetId) => void;

  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
  clearFilters: () => void;
  filterSummary: string;

  selectedEventId: string | null;
  /** 选中事件的时间，用于在时间线上标位置 */
  selectedEventAt: number | null;
  selectEvent: (id: string | null, at?: number | null) => void;

  canvasView: CanvasView;
  setCanvasView: (view: CanvasView) => void;
  /** 关系图的聚焦实体 */
  focusedEntityId: string | null;
  focusEntity: (id: string | null, options?: { switchView?: boolean }) => void;

  evidenceOpen: boolean;
  setEvidenceOpen: (open: boolean) => void;
  evidenceTab: EvidenceTab;
  setEvidenceTab: (tab: EvidenceTab) => void;

  cursor: number | null;
  setCursor: Dispatch<SetStateAction<number | null>>;
  playing: boolean;
  togglePlaying: () => void;
  stepCursor: (direction: 1 | -1) => void;
  masking: boolean;
  setMasking: (on: boolean) => void;

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
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>("message");
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [masking, setMasking] = useState(true);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);

  /** 切换数据集必须清空时间窗与选中项：不同数据集的时间轴不可比，沿用会造成空结果 */
  const setDataset = useCallback((id: DatasetId) => {
    setDatasetState(id);
    setFiltersState(EMPTY_FILTERS);
    setSelectedEventId(null);
    setSelectedEventAt(null);
    setEvidenceOpen(false);
    setCursor(null);
    setPlaying(false);
  }, []);

  const setFilters = useCallback((patch: Partial<Filters>) => {
    setFiltersState((prev) => ({ ...prev, ...patch }));
  }, []);

  const clearFilters = useCallback(() => setFiltersState(EMPTY_FILTERS), []);

  const selectEvent = useCallback((id: string | null, at?: number | null) => {
    setSelectedEventId(id);
    setSelectedEventAt(id ? (at ?? null) : null);
    if (id) setEvidenceOpen(true);
  }, []);

  const focusEntity = useCallback(
    (id: string | null, options?: { switchView?: boolean }) => {
      setFocusedEntityId(id);
      if (options?.switchView) setCanvasView("graph");
    },
    [],
  );

  // 笔记会把当时的筛选条件一并存档，所以要先算好摘要
  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (filters.from != null && filters.to != null) {
      const fmt = (t: number) =>
        new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
      parts.push(`时间 ${fmt(filters.from)} → ${fmt(filters.to)}`);
    }
    if (filters.categories.length) parts.push(`类别 ${filters.categories.length} 项`);
    if (filters.actorId) parts.push(`主体 ${filters.actorId}`);
    if (filters.keyword) parts.push(`关键词 "${filters.keyword}"`);
    return parts.length ? parts.join(" · ") : "无筛选（全量数据）";
  }, [filters]);

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

  const stepCursor = useCallback((direction: 1 | -1) => {
    setCursor((prev) => {
      if (prev == null) return null;
      return prev + direction * 3600;
    });
  }, []);

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
      evidenceOpen,
      setEvidenceOpen,
      evidenceTab,
      setEvidenceTab,
      cursor,
      setCursor,
      playing,
      togglePlaying: () => setPlaying((p) => !p),
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
      evidenceOpen,
      evidenceTab,
      cursor,
      playing,
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
