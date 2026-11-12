import { useMemo } from "react";
import type { OverviewPayload } from "../../../data/api";
import { number, time } from "./shared";

export type CellSelection = { start: number; end: number; category: number; label: string };
export function Activity({ overview, enabledCategories, selected, onSelect }: { overview: OverviewPayload; enabledCategories: number[]; selected: CellSelection | null; onSelect: (cell: CellSelection | null) => void }) {
  const { buckets, points } = overview.filtered.series;
  const { counts, totals, max } = useMemo(() => {
    const counts = new Map<string, number>();
    const totals = buckets.map(() => 0);
    let max = 1;
    for (const [bucket, category, count] of points) {
      const key = `${bucket}:${category}`;
      const combined = (counts.get(key) ?? 0) + count;
      counts.set(key, combined); totals[bucket] += count; max = Math.max(max, combined);
    }
    return { counts, totals, max };
  }, [buckets, points]);
  const width = Math.max(700, buckets.length * 18);
  const peak = Math.max(1, ...totals);
  const step = overview.granularity === "hour" ? 3600e6 : 86400e6;
  // Render every bucket; keep the line and heatmap in the same horizontal scroller.
  return <>
    <p className="mc2-note">当前筛选 · {number(overview.filtered.matched_events)} 条记录 · 颜色越深，数量越多。点击格子只筛选下方列表，再次点击取消。</p>
    <div className="mc2-chart-scroll" tabIndex={0} aria-label="活动图，可横向滚动">
      <div className="mc2-activity" style={{ width: width + 104 }}>
        <div className="mc2-line-label">记录总量<br/><b>{number(peak)}</b><br/><span>0</span></div>
        <svg className="mc2-volume" viewBox={`0 0 ${width} 80`} role="img" aria-label="与下方时间列对齐的记录总量折线">
          <path d={`M0 76H${width}`} stroke="#cdd9e6" fill="none" />
          <polyline points={totals.map((n, i) => `${(i + .5) * width / Math.max(1, buckets.length)},${76 - n / peak * 66}`).join(" ")} fill="none" stroke="#2673b8" strokeWidth="2" />
        </svg>
        <div className="mc2-axis-label">类别 / UTC</div><div className="mc2-axis" style={{ gridTemplateColumns: `repeat(${Math.max(1, buckets.length)}, 1fr)` }}>
          {buckets.map((bucket, i) => <span key={bucket} title={time(bucket)}>{i % Math.max(1, Math.ceil(buckets.length / 12)) === 0 ? new Date(bucket / 1000).toISOString().slice(5, overview.granularity === "hour" ? 13 : 10).replace("T", " ") : ""}</span>)}
        </div>
        {overview.categories.map(category => <div className="mc2-heat-row" key={category.id}>
          <div className="mc2-category-label" title={`${category.label}：${number(category.count_filtered)} 条`}>{category.label}<small>{number(category.count_filtered)}</small></div>
          <div className="mc2-heat-cells" style={{ gridTemplateColumns: `repeat(${Math.max(1, buckets.length)}, 1fr)` }}>
            {buckets.map((bucket, i) => {
              const count = counts.get(`${i}:${category.id - 1}`) ?? 0;
              const active = selected?.start === bucket && selected?.category === category.id;
              return <button key={bucket} disabled={enabledCategories.length > 0 && !enabledCategories.includes(category.id)} className={`mc2-cell${active ? " selected" : ""}`} aria-pressed={active} aria-label={`${category.label} ${time(bucket)} ${count} 条记录`} title={`${time(bucket)}\n${category.label}：${number(count)} 条记录`}
                style={{ background: count ? `rgba(38, 115, 184, ${.18 + .82 * Math.log1p(count) / Math.log1p(max)})` : "#edf2f7" }}
                onClick={() => onSelect(active ? null : { start: bucket, end: bucket + step, category: category.id, label: category.label })} />;
            })}
          </div>
        </div>)}
      </div>
    </div>
    {!buckets.length && <p className="mc2-empty">此时间范围没有活动。请调整筛选条件。</p>}
    <div className="mc2-legend"><span>少</span><i style={{ background: "#edf2f7" }}/><i style={{ background: "#c4daed" }}/><i style={{ background: "#79a8d0" }}/><i style={{ background: "#2673b8" }}/><span>多 · 含动作与回执记录，不等于发帖数量</span></div>
  </>;
}
