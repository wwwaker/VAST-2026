import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { useTheme } from "../theme/theme";
import { fetchCompare, formatUtc, toEpoch, type ComparePayload } from "../data/api";

const RATIO_FLAG = 2;

export function CompareView() {
  const { dataset, filters, setCanvasView } = useWorkspace();
  const { colors } = useTheme();

  const [dimension, setDimension] = useState<"event_type" | "actor">("event_type");
  const [payload, setPayload] = useState<ComparePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const start = filters.from;
  const end = filters.to;

  useEffect(() => {
    if (start == null || end == null) {
      setPayload(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCompare({ dataset, start, end, dimension })
      .then((data) => {
        if (!cancelled) setPayload(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "读取失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataset, start, end, dimension]);

  const maxAbsDelta = useMemo(
    () => Math.max(0.0001, ...(payload?.rows ?? []).map((r) => Math.abs(r.delta))),
    [payload],
  );

  const flagged = useMemo(
    () =>
      (payload?.rows ?? []).filter(
        (r) => r.is_new || (r.ratio != null && (r.ratio >= RATIO_FLAG || r.ratio <= 1 / RATIO_FLAG)),
      ),
    [payload],
  );

  if (start == null || end == null) {
    return (
      <div className="empty-state">
        <h2>先选一个时间窗</h2>
        <p>
          基线比较需要一个「当前窗口」。在时间线上拖动选取一段，或点击锚点跳到该时刻 ±1 小时，
          这里会自动与等长的前一个窗口对比。
        </p>
        <button type="button" className="btn" onClick={() => setCanvasView("timeline")}>
          去时间线刷选
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h2>比较失败</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!payload) {
    return <div className="empty-state"><p className="muted">{loading ? "正在计算…" : "暂无数据"}</p></div>;
  }

  const baselineBeforeData =
    payload.baseline.start < toEpoch(payload.dataset_range.ts_min) &&
    payload.baseline.events === 0;

  return (
    <div className="compare">
      <div className="compare-head">
        <div>
          <h2>基线比较</h2>
          <p className="muted small">
            当前窗口 {formatUtc(payload.window.start)} → {formatUtc(payload.window.end)}
            （{payload.window.hours} 小时 · {payload.window.events.toLocaleString()} 条）
            · 基线 {formatUtc(payload.baseline.start)} → {formatUtc(payload.baseline.end)}
            （{payload.baseline.hours} 小时 · {payload.baseline.events.toLocaleString()} 条）
            {payload.baseline.auto && " · 自动取等长的前一窗口"}
          </p>
        </div>
        <div className="seg">
          {(
            [
              { key: "event_type", label: "按事件类型" },
              { key: "actor", label: "按主体" },
            ] as const
          ).map((d) => (
            <button
              key={d.key}
              type="button"
              className={`seg-item${dimension === d.key ? " seg-active" : ""}`}
              onClick={() => setDimension(d.key)}
              aria-pressed={dimension === d.key}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {baselineBeforeData && (
        <div className="callout callout-warn">
          <strong>基线窗口落在数据范围之前</strong>
          <p>该窗口内没有任何事件，因此所有比值都是"新增"。换一段更靠后的窗口再比较。</p>
        </div>
      )}

      {flagged.length > 0 && (
        <p className="muted small">
          有 {flagged.length} 项偏离超过 {RATIO_FLAG} 倍或属新增。这是统计偏离，不是异常结论
          ——需要回到事件流核对具体记录。
        </p>
      )}

      <div className="compare-table">
        <div className="compare-row compare-header">
          <span className="cmp-label">{dimension === "actor" ? "主体" : "事件类型"}</span>
          <span className="cmp-num">当前/h</span>
          <span className="cmp-num">基线/h</span>
          <span className="cmp-bar-head">变化</span>
        </div>

        {payload.rows.map((row) => {
          const deviated =
            row.is_new || (row.ratio != null && (row.ratio >= RATIO_FLAG || row.ratio <= 1 / RATIO_FLAG));
          const width = (Math.abs(row.delta) / maxAbsDelta) * 50;
          return (
            <div key={row.key} className={`compare-row${deviated ? " compare-deviated" : ""}`}>
              <span className="cmp-label" title={row.key}>
                {row.label}
                {row.is_new && <span className="tag tag-risk">新增</span>}
                {row.is_absent && <span className="tag tag-warn">消失</span>}
              </span>
              <span className="cmp-num">{row.window_rate.toFixed(2)}</span>
              <span className="cmp-num">{row.baseline_rate.toFixed(2)}</span>
              <span className="cmp-bar">
                <span className="cmp-axis" />
                {row.delta >= 0 ? (
                  <span
                    className="cmp-fill cmp-fill-up"
                    style={{ left: "50%", width: `${width}%`, background: colors.risk }}
                  />
                ) : (
                  <span
                    className="cmp-fill cmp-fill-down"
                    style={{ right: "50%", width: `${width}%`, background: colors.textFaint }}
                  />
                )}
                <span className="cmp-ratio">
                  {row.ratio == null ? "—" : `${row.ratio.toFixed(2)}x`}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <p className="muted small">{payload.metric_note}</p>
      <p className="muted small">
        基线只反映"这段时间里通常发生什么"，不反映"应该发生什么"。系统行为随时间合理漂移时，
        偏离也可能来自正常的负载变化——判断前请结合事件流与原始记录。
      </p>

      {loading && <p className="muted small">更新中…</p>}
    </div>
  );
}
