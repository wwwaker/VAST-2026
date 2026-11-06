import { useEffect, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { useTheme } from "../theme/theme";
import { HOUR_US, SECOND_US, fetchDatasets, fetchRun, formatUtc } from "../data/api";

export function TimeBrush() {
  const {
    dataset,
    filters,
    cursor,
    setCursor,
    playing,
    setPlaying,
    togglePlaying,
    stepCursor,
    masking,
    setMasking,
    setFilters,
  } = useWorkspace();
  const { reducedMotion } = useTheme();
  const [range, setRange] = useState<[number, number] | null>(null);
  /** CUSTOM 选中运行后，回放范围收窄到该运行的精确起止 */
  const runId = dataset === "CUSTOM" ? filters.runId : null;

  /** CUSTOM 的运行以秒级流程为主，其余数据集保留小时步进 */
  const stepUs = dataset === "CUSTOM" ? SECOND_US : HOUR_US;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const apply = (start: number | null, end: number | null) => {
      if (start == null || end == null) {
        setRange(null);
        return;
      }
      setRange([start, end]);
      // 只在游标为空时初始化到末尾；恢复案例或用户已定位时不覆盖
      setCursor((prev) => (prev == null ? end : prev));
    };

    if (runId) {
      fetchRun(runId, {}, controller.signal)
        .then((detail) => {
          if (!cancelled) apply(detail.run.start_us, detail.run.end_us);
        })
        .catch(() => {
          if (!cancelled) setRange(null);
        });
    } else {
      fetchDatasets(controller.signal)
        .then((datasets) => {
          if (cancelled) return;
          const info = datasets.find((d) => d.dataset_id === dataset);
          apply(info?.start_us ?? null, info?.end_us ?? null);
        })
        .catch(() => {
          if (!cancelled) setRange(null);
        });
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [dataset, runId, setCursor]);


  useEffect(() => {
    if (!playing || !range) return;
    const interval = reducedMotion ? 500 : 220;
    const id = window.setInterval(() => {
      setCursor((prev) => {
        const next = (prev ?? range[0]) + stepUs;
        return next >= range[1] ? range[1] : next;
      });
    }, interval);
    return () => window.clearInterval(id);
  }, [playing, range, reducedMotion, setCursor, stepUs]);

  // 抵达末尾后停止播放并恢复“播放”按钮
  useEffect(() => {
    if (playing && range && cursor != null && cursor >= range[1]) setPlaying(false);
  }, [playing, range, cursor, setPlaying]);

  const progress = range && cursor != null ? (cursor - range[0]) / Math.max(1, range[1] - range[0]) : 0;

  return (
    <div className="timebrush">
      <div className="timebrush-row">
        <button
          type="button"
          className="btn btn-icon"
          onClick={togglePlaying}
          aria-label={playing ? "暂停回放" : "开始回放"}
        >
          {playing ? "暂停" : "播放"}
        </button>
        <button type="button" className="btn btn-icon" onClick={() => stepCursor(-1, stepUs)} aria-label="上一个步长">
          {dataset === "CUSTOM" ? "−1s" : "−1h"}
        </button>
        <button type="button" className="btn btn-icon" onClick={() => stepCursor(1, stepUs)} aria-label="下一个步长">
          {dataset === "CUSTOM" ? "+1s" : "+1h"}
        </button>

        <div className="timebrush-track">
          <div className="timebrush-fill" style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
          <span className="timebrush-thumb" style={{ left: `${Math.min(100, Math.max(0, progress * 100))}%` }} aria-hidden="true" />
          {range && (
            <input
              className="timebrush-slider"
              type="range"
              min={range[0]}
              max={range[1]}
              step={stepUs}
              value={Math.min(range[1], Math.max(range[0], cursor ?? range[1]))}
              aria-label="回放时间"
              aria-valuetext={cursor != null ? formatUtc(cursor) : "最新"}
              onChange={(event) => setCursor(Number(event.target.value))}
            />
          )}
        </div>

        <span className="timebrush-readout">
          {cursor != null ? formatUtc(cursor) : "—"}
          <span className="muted"> / {dataset === "MC1" ? "源时区未知" : "UTC"}</span>
        </span>

        <button
          type="button"
          className="info-button"
          title={
            masking
              ? "游标之后的记录不显示；游标之前的记录始终可查。"
              : "关闭遮蔽后，当前展示全量数据，不代表游标时刻状态。"
          }
          aria-label={masking ? "回放遮蔽说明：游标之后的记录不显示" : "回放遮蔽已关闭说明：当前展示全量数据"}
        >
          i
        </button>

        <label className="check">
          <input type="checkbox" checked={masking} onChange={(e) => setMasking(e.target.checked)} />
          <span>回放遮蔽</span>
        </label>

        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            if (range) setCursor(range[1]);
            setFilters({ startUs: null, endUs: null });
            setPlaying(false);
          }}
        >
          回到最新
        </button>
      </div>
    </div>
  );
}
