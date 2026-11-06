/** 统一筛选上下文。后端 contract v2：所有时间都是整数微秒，窗口为 [startUs, endUs)。 */

export interface Filters {
  startUs: number | null;
  endUs: number | null;
  /** 类别 id（1..8）；由服务端字典解析成具体事件类型 */
  categories: number[];
  /** 精确事件类型（通常由比较下钻写入） */
  eventTypes: string[];
  /** 执行者必须相等 */
  actorId: string | null;
  /** 任一参与者命中；与图焦点分开 */
  participantId: string | null;
  /** 仅 CUSTOM */
  runId: string | null;
  keyword: string;
}

export const EMPTY_FILTERS: Filters = {
  startUs: null,
  endUs: null,
  categories: [],
  eventTypes: [],
  actorId: null,
  participantId: null,
  runId: null,
  keyword: "",
};

export type QueryValue = string | number | undefined;

export function toApiFilters(filters: Filters): Record<string, QueryValue> {
  const keyword = filters.keyword.trim();
  return {
    start_us: filters.startUs ?? undefined,
    end_us: filters.endUs ?? undefined,
    categories: filters.categories.length ? filters.categories.join(",") : undefined,
    types: filters.eventTypes.length ? filters.eventTypes.join(",") : undefined,
    actor: filters.actorId ?? undefined,
    participant: filters.participantId ?? undefined,
    run_id: filters.runId ?? undefined,
    q: keyword || undefined,
  };
}

/** 请求与缓存键：只包含影响结果集的字段。 */
export function filterKey(filters: Filters, extra: Record<string, unknown> = {}): string {
  return JSON.stringify([toApiFilters(filters), extra]);
}

export function hasActiveFilters(filters: Filters): boolean {
  return Boolean(
    filters.startUs != null ||
      filters.endUs != null ||
      filters.categories.length ||
      filters.eventTypes.length ||
      filters.actorId ||
      filters.participantId ||
      filters.runId ||
      filters.keyword.trim(),
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

export function describeFilters(filters: Filters): string {
  const parts: string[] = [];
  if (filters.startUs != null && filters.endUs != null) {
    parts.push(`时间 ${formatUs(filters.startUs)} → ${formatUs(filters.endUs)}`);
  }
  if (filters.categories.length) parts.push(`类别 ${filters.categories.join("/")}`);
  if (filters.eventTypes.length) parts.push(`类型 ${filters.eventTypes.join("、")}`);
  if (filters.actorId) parts.push(`执行者 ${filters.actorId}`);
  if (filters.participantId) parts.push(`参与者 ${filters.participantId}`);
  // 运行 ID 很长（run-<32 位>），摘要里只显示可辨认的前 8 位
  if (filters.runId) parts.push(`运行 ${filters.runId.replace(/^run-/, "").slice(0, 8)}`);
  if (filters.keyword.trim()) parts.push(`关键词「${filters.keyword.trim()}」`);
  return parts.length ? parts.join(" · ") : "无筛选（全量数据）";
}

/** 与 api.formatUtc 保持一致，避免为了摘要文本引入循环依赖。 */
function formatUs(us: number): string {
  const iso = new Date(us / 1000).toISOString();
  return `${iso.slice(0, 10)} ${pad(Number(iso.slice(11, 13)))}:${iso.slice(14, 16)}`;
}
