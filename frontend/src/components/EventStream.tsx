import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { useTheme } from "../theme/theme";
import { categoryOf } from "../theme/categories";
import { fetchEvents, formatUtc, type EventItem } from "../data/api";

const PAGE = 50;

export function EventStream({ allTypes }: { allTypes: string[] }) {
  const { dataset, filters, selectedEventId, selectEvent } = useWorkspace();
  const { colors } = useTheme();

  const [items, setItems] = useState<EventItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 仅 MC1 有内部审议，其余数据集不显示该开关 */
  const [onlyDeliberation, setOnlyDeliberation] = useState(false);
  const requestId = useRef(0);

  const activeTypes =
    filters.categories.length === 0
      ? undefined
      : allTypes.filter((t) => filters.categories.includes(categoryOf(t).id));

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      const ticket = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const page = await fetchEvents({
          dataset,
          start: filters.from ?? undefined,
          end: filters.to ?? undefined,
          types: activeTypes,
          actor: filters.actorId ?? undefined,
          q: filters.keyword || undefined,
          hasDeliberation: onlyDeliberation ? true : undefined,
          limit: PAGE,
          cursor: nextCursor,
        });
        if (ticket !== requestId.current) return;
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
      } catch (err) {
        if (ticket === requestId.current) {
          setError(err instanceof Error ? err.message : "加载失败");
        }
      } finally {
        if (ticket === requestId.current) setLoading(false);
      }
    },
    [dataset, filters.from, filters.to, filters.keyword, filters.actorId, activeTypes, onlyDeliberation],
  );

  useEffect(() => {
    if (dataset !== "MC1") setOnlyDeliberation(false);
  }, [dataset]);

  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load(null, false);
  }, [load]);

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
      selectEvent(target.event_id, target.time_sort_key);
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
          {loading && items.length === 0 ? "加载中…" : `已载入 ${items.length} 条`}
          {filters.keyword && ` · 关键词「${filters.keyword}」`}
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
          onClick={() => load(null, false)}
          disabled={loading}
        >
          刷新
        </button>
      </div>

      {error && <p className="stream-error">接口错误：{error}</p>}

      <ul className="stream-list">
        {items.map((item) => (
          <li key={item.event_id}>
            <button
              type="button"
              data-event-id={item.event_id}
              className={`stream-row${selectedEventId === item.event_id ? " stream-row-active" : ""}`}
              onClick={() => selectEvent(item.event_id, item.time_sort_key)}
            >
              <span className="stream-time mono">{formatUtc(item.time_sort_key)}</span>
              <span
                className="stream-dot"
                style={{ background: colors.categories[categoryOf(item.event_type).id - 1] }}
                aria-hidden="true"
              />
              <span className="stream-type">{item.event_type}</span>
              <span className="stream-actor mono">{item.actor_label ?? item.actor_id ?? "—"}</span>
              <span className="stream-preview">{item.preview || "（无正文摘要）"}</span>
              {/* 已按"仅含内心审议"筛选时不再逐行重复该标记 */}
              {item.has_deliberation && !onlyDeliberation && (
                <span className="tag tag-delib">含内心审议</span>
              )}
              {item.annotations.length > 0 && (
                <span
                  className={`tag${item.annotations[0].observed ? " tag-risk" : " tag-warn"}`}
                  title={item.annotations[0].reason ?? ""}
                >
                  {item.annotations[0].observed ? "已观测异常" : "已配置未观测"}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {items.length === 0 && !loading && !error && (
        <p className="muted small stream-empty">当前筛选条件下没有事件。放宽时间窗或清除筛选。</p>
      )}

      {cursor && (
        <button type="button" className="btn stream-more" onClick={() => load(cursor, true)} disabled={loading}>
          {loading ? "加载中…" : "加载更多"}
        </button>
      )}
    </section>
  );
}
