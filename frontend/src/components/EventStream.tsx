import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { useTheme } from "../theme/theme";
import { fetchEvents, formatUtc, type EventItem } from "../data/api";
import { filterKey } from "../data/filterContext";
import { annotationBadge, badgeClass } from "../data/labels";
import { useDebounced } from "../hooks/useDebounced";

const PAGE = 50;

export function EventStream() {
  const { dataset, filters, cursor, masking, selectedEventId, selectEvent } = useWorkspace();
  const { colors } = useTheme();

  const keyword = useDebounced(filters.keyword, 250);
  const requestFilters = useMemo(() => ({ ...filters, keyword }), [filters, keyword]);
  const requestKey = filterKey(requestFilters, {
    dataset,
    cursor_us: masking ? cursor : undefined,
    masking,
  });

  const [items, setItems] = useState<EventItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matched, setMatched] = useState<number | null>(null);
  /** 仅 MC1 有内部审议，其余数据集不显示该开关 */
  const [onlyDeliberation, setOnlyDeliberation] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (dataset !== "MC1") setOnlyDeliberation(false);
  }, [dataset]);

  const load = useCallback(
    async (pageCursor: string | null, append: boolean, signal: AbortSignal) => {
      const ticket = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const page = await fetchEvents(
          {
            dataset,
            filters: requestFilters,
            limit: PAGE,
            cursor: pageCursor,
            direction: "desc",
            cursorUs: masking ? cursor : null,
            masking,
            hasDeliberation: onlyDeliberation ? true : undefined,
          },
          signal,
        );
        if (ticket !== requestId.current) return;
        setMatched(page.meta.matched_events);
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setNextCursor(page.next_cursor);
      } catch (err) {
        if (signal.aborted) return;
        if (ticket === requestId.current) {
          setError(err instanceof Error ? err.message : "加载失败");
        }
      } finally {
        if (ticket === requestId.current) setLoading(false);
      }
    },
    [dataset, requestFilters, cursor, masking, onlyDeliberation],
  );

  // 筛选键变化即重置分页并取消旧请求
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setNextCursor(null);
    void load(null, false, controller.signal);
    return () => controller.abort();
  }, [load, requestKey]);

  // 上下键在事件流内移动选择；输入框内不抢键
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) {
        return;
      }
      if (items.length === 0) return;

      event.preventDefault();
      const current = items.findIndex((i) => i.event_id === selectedEventId);
      let next: number;
      if (current === -1) {
        next = event.key === "ArrowDown" ? 0 : items.length - 1;
      } else {
        next = event.key === "ArrowDown" ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
      }
      const target = items[next];
      selectEvent(target.event_id, target.time_us);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-event-id="${CSS.escape(target.event_id)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, selectedEventId, selectEvent]);

  return (
    <section className="stream" aria-label="事件流">
      <div className="stream-head">
        <h3>事件流</h3>
        <span className="muted small">
          {loading && items.length === 0
            ? "加载中…"
            : matched != null
              ? `${matched.toLocaleString()} 条匹配 · 已载入 ${items.length}`
              : `已载入 ${items.length} 条`}
          {keyword.trim() && ` · 关键词「${keyword.trim()}」`}
        </span>
        {dataset === "MC1" && (
          <label className="check" title="MC1 全库只有 86 条事件记录了内部审议">
            <input
              type="checkbox"
              checked={onlyDeliberation}
              onChange={(e) => setOnlyDeliberation(e.target.checked)}
            />
            <span>仅含内心审议</span>
          </label>
        )}
        <button
          type="button"
          className="btn btn-quiet stream-refresh"
          onClick={() => {
            const controller = new AbortController();
            void load(null, false, controller.signal);
          }}
          disabled={loading}
        >
          刷新
        </button>
      </div>

      {masking && cursor != null && (
        <p className="muted small">
          回放遮蔽：仅显示 {formatUtc(cursor)} 之前的记录
          {matched === 0 && "（当前游标之前没有匹配记录）"}
        </p>
      )}
      {error && <p className="stream-error">接口错误：{error}</p>}

      <ul className="stream-list">
        {items.map((item) => {
          const badges = item.annotations.map((a) => ({ ...annotationBadge(a), reason: a.reason }));
          return (
            <li key={item.event_id}>
              <button
                type="button"
                data-event-id={item.event_id}
                className={`stream-row${selectedEventId === item.event_id ? " stream-row-active" : ""}`}
                onClick={() => selectEvent(item.event_id, item.time_us)}
              >
                <span className="stream-time mono">{formatUtc(item.time_us)}</span>
                <span
                  className="stream-dot"
                  style={{ background: colors.categories[Math.max(0, Math.min(7, item.category - 1))] }}
                  aria-hidden="true"
                />
                <span className="stream-type">{item.event_type}</span>
                <span className="stream-actor mono">{item.actor_label ?? item.actor_id ?? "—"}</span>
                <span className="stream-preview">{item.preview || "（无正文摘要）"}</span>
                {/* 已按“仅含内心审议”筛选时不再逐行重复该标记 */}
                {item.has_deliberation && !onlyDeliberation && (
                  <span className="tag tag-delib">含内心审议</span>
                )}
                {badges[0] && (
                  <span className={badgeClass(badges[0].tone)} title={badges[0].reason ?? ""}>
                    {badges[0].text}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {items.length === 0 && !loading && !error && (
        <p className="muted small stream-empty">当前筛选条件下没有事件。放宽时间窗或清除筛选。</p>
      )}

      {nextCursor && (
        <button
          type="button"
          className="btn stream-more"
          onClick={() => {
            const controller = new AbortController();
            void load(nextCursor, true, controller.signal);
          }}
          disabled={loading}
        >
          {loading ? "加载中…" : "加载更多"}
        </button>
      )}
    </section>
  );
}
