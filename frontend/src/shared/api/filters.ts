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
  /** 精确 channel_id；MC1 的公开/内部渠道切换走这里 */
  channels: string[];
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
  channels: [],
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
    channels: filters.channels.length ? filters.channels.join(",") : undefined,
    q: keyword || undefined,
  };
}
