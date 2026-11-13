import { WindowRange } from "../../shared/WindowRange";
import { barShade } from "../../shared/MetricBars";
import type { EvidenceEvent } from "./customApi";

/** Full-run density stays fixed while local event filters and the window change. */
export function TrajectoryRange({ events, start, duration, window, change }: { events: EvidenceEvent[]; start: number; duration: number; window: [number, number]; change: (w: [number, number]) => void }) {
  const bins = Array.from({ length: 48 }, () => 0);
  for (const event of events) {
    const seconds = (event.time_us - start) / 1e6;
    if (seconds >= 0 && seconds <= duration) bins[Math.min(47, Math.floor(seconds / duration * 48))]++;
  }
  const maximum = Math.max(1, ...bins);
  return <div className="cu-trajectory-range">
    <svg className="cu-time-density" viewBox="0 0 960 32" preserveAspectRatio="none" role="img" aria-label="完整运行事件分布，柱高表示事件数">
      {bins.map((count, i) => {
        const a = i * duration / 48, b = (i + 1) * duration / 48, inside = b >= window[0] && a <= window[1];
        return <rect key={i} data-count={count} x={i * 20 + 1} width={18} y={32 - count / maximum * 30} height={count / maximum * 30} fill={inside ? barShade("#599b86", count / maximum) : "#d3dce5"}><title>{a.toFixed(2)}–{b.toFixed(2)} s：{count} 条事件</title></rect>;
      })}
    </svg>
    <WindowRange maximum={duration} value={window} change={change} step={.001} minSpan={Math.min(.001, duration / 10)} startLabel="轨迹起点" endLabel="轨迹终点"/>
    <div className="cu-time-scale"><span>0 s</span><span>全程事件分布 · 拖动两端缩放，拖动选区平移</span><span>{duration.toFixed(2)} s</span></div>
  </div>;
}
