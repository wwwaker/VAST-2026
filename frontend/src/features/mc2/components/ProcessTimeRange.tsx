import { WindowRange } from "../../../shared/ui/WindowRange";
import { time } from "../eventPresentation";
import { rangeLabels } from "../timeDisplay";

export function ProcessTimeRange({
  start,
  end,
  bounds,
  change,
  focus,
  points,
}: {
  start: number;
  end: number;
  bounds: number[];
  change: (v: [number, number]) => void;
  focus: () => void;
  points: { time: number; count: number }[];
}) {
  const span = Math.max(0.001, (end - start) / 1e6);
  const buckets = Array.from({ length: 64 }, () => 0);
  points.forEach((p) => {
    if (p.time >= start && p.time < end) {
      buckets[Math.min(63, Math.floor(((p.time - start) / Math.max(1, end - start)) * 64))] +=
        p.count;
    }
  });
  const peak = Math.max(1, ...buckets);
  const labels = rangeLabels(start, end);
  const visibleLabels = rangeLabels(bounds[0], bounds[1]);

  return (
    <div
      className="w-process-range"
      aria-label="调整过程图时间范围"
    >
      <div className="w-process-range-meta">
        <span title={`精确图中范围：[${time(bounds[0])}, ${time(bounds[1])})`}>
          <b>图中时间</b> {visibleLabels[0]} → {visibleLabels[1]}
        </span>
        <div>
          <button
            onClick={focus}
            title="聚焦实际活动，保留完整查询统计"
          >
            聚焦活动
          </button>
          <button onClick={() => change([start, end])}>全部窗口</button>
        </div>
      </div>
      <div className="w-process-range-track">
        <svg
          width="100%"
          height={24}
          viewBox="0 0 640 24"
          preserveAspectRatio="none"
          aria-label="完整查询窗口活动分布"
        >
          {buckets.map((count, i) => (
            <rect
              key={i}
              x={i * 10 + 1}
              y={24 - (count ? 3 + Math.sqrt(count / peak) * 20 : 1)}
              width={8}
              height={count ? 3 + Math.sqrt(count / peak) * 20 : 1}
              fill="#a3bfd5"
            >
              <title>
                {count} 条记录 · {time(start + (i / 64) * (end - start))}
              </title>
            </rect>
          ))}
        </svg>
        <WindowRange
          maximum={span}
          value={[(bounds[0] - start) / 1e6, (bounds[1] - start) / 1e6]}
          step={0.001}
          minSpan={Math.min(0.001, span)}
          startLabel="过程图窗口起点"
          endLabel="过程图窗口终点"
          windowLabel="平移过程图时间窗口"
          change={(v) =>
            change([Math.round(start + v[0] * 1e6), Math.round(Math.min(end, start + v[1] * 1e6))])
          }
        />
      </div>
      <div className="w-process-range-labels">
        <span title={time(start)}>{labels[0]}</span>
        <span>拖动两端调整范围 · 拖动中间平移 · 仅调整图中时间</span>
        <span title={time(end)}>{labels[1]}</span>
      </div>
    </div>
  );
}
