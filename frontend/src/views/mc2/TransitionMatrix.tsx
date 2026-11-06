import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import {
  fetchTransitionEvidence,
  fetchTransitions,
  formatDuration,
  formatUtc,
  type TransitionCell,
  type TransitionEvidenceItem,
  type TransitionPayload,
} from "../../data/api";
import { filterKey } from "../../data/filterContext";

const PAGE_SIZE = 50;

interface Selection {
  source_type: string;
  next_type: string;
}

/** M2-04：MC2 相邻操作转移矩阵。未做 actor 校正前只显示支持数与 actor 数。 */
export function TransitionMatrix() {
  const { filters, cursor, masking, selectEvent } = useWorkspace();
  const [windowMinutes, setWindowMinutes] = useState<5 | 30>(5);
  const [payload, setPayload] = useState<TransitionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);

  const key = filterKey(filters, {
    window: windowMinutes,
    cursor_us: masking ? cursor : undefined,
    masking,
  });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchTransitions(
      { windowMinutes, filters, cursorUs: masking ? cursor : null, masking },
      controller.signal,
    )
      .then((data) => {
        setPayload(data);
        setSelected(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : "转移矩阵加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // filters 通过 key 参与依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cellMap = useMemo(() => {
    const map = new Map<string, TransitionCell>();
    for (const cell of payload?.cells ?? []) {
      map.set(`${cell.source_type}|${cell.next_type}`, cell);
    }
    return map;
  }, [payload]);

  const maxSupport = useMemo(
    () => Math.max(1, ...(payload?.cells ?? []).map((cell) => cell.support)),
    [payload],
  );

  return (
    <div className="transition-view">
      <div className="canvas-subbar">
        <div className="seg" role="group" aria-label="转移矩阵时间窗">
          {([5, 30] as const).map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={`seg-item${windowMinutes === minutes ? " seg-active" : ""}`}
              aria-pressed={windowMinutes === minutes}
              onClick={() => setWindowMinutes(minutes)}
            >
              {minutes} 分钟
            </button>
          ))}
        </div>
        <span className="muted small">
          只统计同一执行者的相邻操作；源与后继都必须满足当前筛选。
        </span>
      </div>

      {error && (
        <div className="callout callout-warn">
          <strong>转移矩阵不可用</strong>
          <p className="muted small">{error}</p>
        </div>
      )}
      {loading && !payload && <p className="muted small">正在读取转移矩阵…</p>}

      {payload && (
        <>
          <div className="callout callout-info">
            <strong>方法说明</strong>
            <ul className="tight-list">
              {payload.method_notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <p className="muted small">
              actor 覆盖 {payload.actor_coverage.actors_matched}/{payload.actor_coverage.actors_in_window}
              （{payload.actor_coverage.coverage_ratio == null
                ? "—"
                : `${Math.round(payload.actor_coverage.coverage_ratio * 100)}%`}
              ）· 支持对 {payload.totals.matched_pairs.toLocaleString()} / 窗口内{" "}
              {payload.totals.within_window_pairs.toLocaleString()} / 已导入{" "}
              {payload.totals.installed_pairs.toLocaleString()}
            </p>
            <p className="muted small">
              排除：筛选未同时命中两端的对 {payload.excluded.by_filter?.toLocaleString() ?? 0}
              · 缺 actor {payload.excluded.missing_actor ?? 0}
              · 并列时间 {payload.excluded.equal_timestamp ?? 0}
              · 未知端点 {payload.excluded.unknown_event ?? 0}
              · 超窗 {payload.excluded.out_of_range ?? 0}
              · 重复 {payload.excluded.duplicate ?? 0}
            </p>
            <p className="muted small">
              未实现 actor 校正，因此不展示 lift、倍数或异常概率；低样本格只给具体 n。
            </p>
          </div>

          {payload.cells.length === 0 ? (
            <div className="empty-state">
              <p className="muted">当前筛选下没有同时满足两端条件的相邻对。</p>
            </div>
          ) : (
            <div className="transition-grid-wrap">
              <table className="transition-table">
                <caption className="muted small">
                  行 = 源事件类型，列 = 后继事件类型；格内为支持对数（≥ {payload.low_sample_threshold}{" "}
                  时括号内为 actor 数）。点击格子查看相邻对。
                </caption>
                <thead>
                  <tr>
                    <th scope="col">源 \\ 后继</th>
                    {payload.types.map((type) => (
                      <th key={type} scope="col" title={type}>
                        <span>{type}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payload.types.map((sourceType) => (
                    <tr key={sourceType}>
                      <th scope="row" title={sourceType}>
                        {sourceType}
                      </th>
                      {payload.types.map((nextType) => {
                        const cell = cellMap.get(`${sourceType}|${nextType}`);
                        const active =
                          selected?.source_type === sourceType && selected?.next_type === nextType;
                        return (
                          <td key={nextType}>
                            <button
                              type="button"
                              className={`transition-cell${cell ? "" : " transition-cell-empty"}${
                                cell?.low_sample ? " transition-cell-low" : ""
                              }${active ? " transition-cell-active" : ""}`}
                              disabled={!cell}
                              onClick={() => setSelected({ source_type: sourceType, next_type: nextType })}
                              title={
                                cell
                                  ? `${sourceType} → ${nextType}：${cell.support} 对 / ${cell.actor_count} 个 actor`
                                  : "当前筛选下没有支持对"
                              }
                              aria-label={
                                cell
                                  ? `${sourceType} 到 ${nextType} 支持 ${cell.support} 对`
                                  : `${sourceType} 到 ${nextType} 无支持对`
                              }
                            >
                              {cell ? (
                                <>
                                  <span className="transition-cell-n">{cell.support}</span>
                                  {cell.support >= payload.low_sample_threshold && (
                                    <span className="transition-cell-actors">{cell.actor_count}</span>
                                  )}
                                </>
                              ) : (
                                <span className="muted">·</span>
                              )}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">
                最大支持对 {maxSupport.toLocaleString()}；颜色不随数值增强，避免把高样本误读为强异常。
              </p>
            </div>
          )}

          {selected && (
            <EvidenceList
              selection={selected}
              windowMinutes={windowMinutes}
              onSelectEvent={(eventId, atUs) => selectEvent(eventId, atUs)}
            />
          )}
        </>
      )}
    </div>
  );
}

function EvidenceList({
  selection,
  windowMinutes,
  onSelectEvent,
}: {
  selection: Selection;
  windowMinutes: 5 | 30;
  onSelectEvent: (eventId: string, atUs: number) => void;
}) {
  const { filters, cursor, masking } = useWorkspace();
  const [items, setItems] = useState<TransitionEvidenceItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cellKey = `${selection.source_type}|${selection.next_type}|${windowMinutes}|${filterKey(filters, {
    cursor_us: masking ? cursor : undefined,
    masking,
  })}`;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setOffset(0);
    fetchTransitionEvidence(
      {
        windowMinutes,
        sourceType: selection.source_type,
        nextType: selection.next_type,
        filters,
        limit: PAGE_SIZE,
        offset: 0,
        cursorUs: masking ? cursor : null,
        masking,
      },
      controller.signal,
    )
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        setHasMore(data.has_more);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setItems([]);
        setTotal(0);
        setHasMore(false);
        setError(err instanceof Error ? err.message : "相邻对加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellKey]);

  const loadMore = () => {
    const nextOffset = offset + PAGE_SIZE;
    setLoading(true);
    fetchTransitionEvidence({
      windowMinutes,
      sourceType: selection.source_type,
      nextType: selection.next_type,
      filters,
      limit: PAGE_SIZE,
      offset: nextOffset,
      cursorUs: masking ? cursor : null,
      masking,
    })
      .then((data) => {
        setItems((prev) => [...prev, ...data.items]);
        setTotal(data.total);
        setHasMore(data.has_more);
        setOffset(nextOffset);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "相邻对加载失败"))
      .finally(() => setLoading(false));
  };

  return (
    <div className="transition-evidence">
      <div className="trace-head">
        <strong className="mono">
          {selection.source_type} → {selection.next_type}
        </strong>
        <span className="muted small">支持 {total.toLocaleString()} 对（与矩阵格一致）</span>
        {error && <span className="tag tag-warn">{error}</span>}
      </div>
      <p className="muted small">
        同执行者的相邻操作，不表示因果；点击任一侧事件可回查原始记录。
      </p>
      <ul className="trace-list">
        {items.map((item) => (
          <li key={`${item.source.event_id}|${item.next.event_id}`}>
            <div className="transition-pair">
              <span className="muted small">间隔 {formatDuration(item.lag_us)}</span>
              <button
                type="button"
                className="trace-item"
                onClick={() => onSelectEvent(item.source.event_id, item.source.time_us)}
              >
                <span className="tag">源</span>
                <span className="mono small">{formatUtc(item.source.time_us)}</span>
                <span className="stream-type">{item.source.event_type}</span>
                <span className="muted small">{item.source.preview || "（无摘要）"}</span>
              </button>
              <button
                type="button"
                className="trace-item"
                onClick={() => onSelectEvent(item.next.event_id, item.next.time_us)}
              >
                <span className="tag">后继</span>
                <span className="mono small">{formatUtc(item.next.time_us)}</span>
                <span className="stream-type">{item.next.event_type}</span>
                <span className="muted small">{item.next.preview || "（无摘要）"}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
      {items.length === 0 && !loading && <p className="muted small">没有可展示的相邻对。</p>}
      {hasMore && (
        <button type="button" className="btn" onClick={loadMore} disabled={loading}>
          {loading ? "加载中…" : `加载更多（已显示 ${items.length}/${total}）`}
        </button>
      )}
    </div>
  );
}
