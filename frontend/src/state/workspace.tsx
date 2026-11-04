import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

export type Chapter = "overview" | "trace" | "compare" | "evidence";

export const CHAPTERS: { key: Chapter; label: string; hint: string }[] = [
  { key: "overview", label: "概览", hint: "建立行为基线，找出值得深入的时间段" },
  { key: "trace", label: "追踪", hint: "沿参与者与事件重建链路" },
  { key: "compare", label: "比较", hint: "与历史窗口或同角色基线对比" },
  { key: "evidence", label: "证据记录", hint: "核对原始记录并记录结论" },
];

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

export type EvidenceTab = "message" | "related" | "raw";

interface WorkspaceValue {
  dataset: DatasetId;
  setDataset: (id: DatasetId) => void;

  /** null 表示自由探索；章节用于讲解，不强制接受预设结论 */
  chapter: Chapter | null;
  setChapter: (c: Chapter | null) => void;
  modeLabel: string;

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

  notes: string[];
  addNote: (text: string) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [dataset, setDatasetState] = useState<DatasetId>("MC2");
  const [chapter, setChapterState] = useState<Chapter | null>("overview");
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
  const [notes, setNotes] = useState<string[]>([]);

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

  const setChapter = useCallback((c: Chapter | null) => {
    setChapterState(c);
    setPlaying(false);
  }, []);

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

  const addNote = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed) setNotes((prev) => [trimmed, ...prev]);
  }, []);

  const stepCursor = useCallback((direction: 1 | -1) => {
    setCursor((prev) => {
      if (prev == null) return null;
      return prev + direction * 3600;
    });
  }, []);

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

  const modeLabel = chapter
    ? `章节：${CHAPTERS.find((c) => c.key === chapter)?.label ?? ""}`
    : "自由探索";

  const value = useMemo<WorkspaceValue>(
    () => ({
      dataset,
      setDataset,
      chapter,
      setChapter,
      modeLabel,
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
      addNote,
    }),
    [
      dataset,
      setDataset,
      chapter,
      setChapter,
      modeLabel,
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
      addNote,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace 必须在 WorkspaceProvider 内使用");
  return ctx;
}
