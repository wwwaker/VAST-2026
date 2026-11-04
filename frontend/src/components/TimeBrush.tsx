import { useEffect, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { useTheme } from "../theme/theme";
import { fetchDatasets, formatUtc, toEpoch } from "../data/api";

export function TimeBrush() {
  const { dataset, cursor, setCursor, playing, togglePlaying, stepCursor, masking, setMasking, filters, setFilters } =
    useWorkspace();
  const { reducedMotion } = useTheme();
  const [range, setRange] = useState<[number, number] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDatasets()
      .then((datasets) => {
        if (cancelled) return;
        const info = datasets.find((d) => d.dataset_id === dataset);
        if (!info) return;
        const start = toEpoch(info.ts_min);
        const end = toEpoch(info.ts_max);
        setRange([start, end]);
        setCursor(end);
      })
      .catch(() => setRange(null));
    return () => {
      cancelled = true;
    };
  }, [dataset, setCursor]);

  useEffect(() => {
    if (!playing || !range) return;
    const step = reducedMotion ? 500 : 220;
    const id = window.setInterval(() => {
      setCursor((prev) => {
        const next = (prev ?? range[0]) + 3600;
        if (next >= range[1]) {
          window.clearInterval(id);
          return range[1];
        }
        return next;
      });
    }, step);
    return () => window.clearInterval(id);
  }, [playing, range, reducedMotion, setCursor]);

  const progress = range && cursor != null ? (cursor - range[0]) / Math.max(1, range[1] - range[0]) : 0;

  return (
    <div className="timebrush">
      <div className="timebrush-row">
        <button type="button" className="btn btn-icon" onClick={togglePlaying} aria-label={playing ? "暂停回放" : "开始回放"}>
          {playing ? "暂停" : "播放"}
        </button>
        <button type="button" className="btn btn-icon" onClick={() => stepCursor(-1)} aria-label="上一小时">
          −1h
        </button>
        <button type="button" className="btn btn-icon" onClick={() => stepCursor(1)} aria-label="下一小时">
          +1h
        </button>

        <div className="timebrush-track" aria-hidden="true">
          <div className="timebrush-fill" style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
        </div>

        <span className="timebrush-readout">
          {cursor != null ? formatUtc(cursor) : "—"}
          <span className="muted"> / 源时区 {dataset === "MC1" ? "未知" : "UTC"}</span>
        </span>

        <label className="check">
          <input type="checkbox" checked={masking} onChange={(e) => setMasking(e.target.checked)} />
          <span>回放遮蔽</span>
        </label>

        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            if (range) setCursor(range[1]);
            setFilters({ from: null, to: null });
          }}
        >
          回到最新
        </button>
      </div>

      <div className="timebrush-hint muted small">
        {masking
          ? "游标之后的记录不显示，游标之前始终全量可查；关闭遮蔽后界面会明确标注。"
          : "已关闭回放遮蔽：当前可见的是全量数据，不是某一时刻的状态。"}
        {filters.from != null && " · 当前有刷选窗口"}
      </div>
    </div>
  );
}
