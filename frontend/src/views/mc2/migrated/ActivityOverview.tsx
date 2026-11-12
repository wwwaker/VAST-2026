import { useMemo, useRef } from "react";
import type { ActivityData, Selection } from "./workspaceApi";
import { categoryColors, number, time } from "./shared";

export function ActivityOverview({ data, selected, choose, day, chooseDay, collapsed, scrollCache, anchorTime }: { data: ActivityData; selected: Selection | null; choose: (s: Selection | null) => void; day: Selection | null; chooseDay: (s: Selection | null) => void; collapsed: boolean; scrollCache: Map<string, number>; anchorTime?: number }) {
  const legendMax = useRef({ key: "", max: 1 });
  const { cells, totals, rowTotals, max } = useMemo(() => {
    const cells = new Map(data.cells.map(c => [`${c.type}:${c.bucket}`, c.count]));
    const byBucket = new Map<number, number>();
    const rowTotals: Record<string, number> = Object.fromEntries(data.types.map(t => [t.type, 0]));
    data.cells.forEach(c => { byBucket.set(c.bucket, (byBucket.get(c.bucket) ?? 0) + c.count); rowTotals[c.type] = (rowTotals[c.type] ?? 0) + c.count; });
    const totals = data.buckets.map(b => byBucket.get(b) ?? 0);
    return { cells, totals, rowTotals, max: Math.max(1, ...data.cells.map(c => c.count)) };
  }, [data]);
  const key = `${data.meta.selection_hash}:${data.step}`;
  if (legendMax.current.key !== key) legendMax.current = { key, max };
  const width = Math.max(640, data.buckets.length * 13);
  const peak = Math.max(1, ...totals);
  const rowPeak = Math.max(1, ...Object.values(rowTotals));
  return <>
    <div className="mc2-chart-scroll" tabIndex={0} aria-label="24 类型活动矩阵" ref={el => { if (el) el.scrollLeft = scrollCache.get(data.meta.selection_hash) ?? 0; }} onScroll={e => scrollCache.set(data.meta.selection_hash, e.currentTarget.scrollLeft)}>
      <div className="w-activity" style={{ width: width + 260 }}>
        <div className="w-volume-label">记录总量<br/><b>{number(peak)}</b></div>
        <svg width={width} height="65" role="img" aria-label="时间总量柱">
          {totals.map((n, i) => {
            const start = Math.floor(data.buckets[i] / 86400e6) * 86400e6;
            const active = day?.start === start;
            const pick = () => chooseDay(active ? null : { start, end: start + 86400e6, label: new Date(start / 1000).toISOString().slice(0, 10) });
            return <g key={data.buckets[i]} role="button" tabIndex={0} aria-pressed={active} aria-label={`筛选当天 ${new Date(start / 1000).toISOString().slice(0, 10)} ${n} 条`} onClick={pick} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }} style={{ cursor: "pointer" }}><title>{time(data.buckets[i])} · {number(n)} 条</title><rect x={i * width / totals.length + 1} y={58 - n / peak * 51} width={Math.max(2, width / totals.length - 2)} height={Math.max(2, n / peak * 51)} fill={active ? "#bc7750" : "#579b92"} /><rect x={i * width / totals.length} y="0" width={width / totals.length} height="65" fill="transparent" /></g>; })}
          {anchorTime !== undefined && anchorTime >= data.buckets[0] && anchorTime < data.buckets.at(-1)! + data.step && <g><title>保留的过程锚点 · {time(anchorTime)}；是否符合当前类型请看局部过程状态。</title><line x1={(anchorTime - data.buckets[0]) / data.step / data.buckets.length * width} x2={(anchorTime - data.buckets[0]) / data.step / data.buckets.length * width} y1="0" y2="65" stroke="#d58c27" strokeWidth="2" strokeDasharray="3 2" /></g>}
        </svg><div className="w-row-total">当前范围总量</div>
        <div className="w-axis-label">事件类型 / UTC</div><div className="w-axis" style={{ gridTemplateColumns: `repeat(${data.buckets.length || 1},1fr)` }}>{data.buckets.map((b, i) => <span key={b}>{i % Math.max(1, Math.ceil(data.buckets.length / 10)) === 0 ? new Date(b / 1000).toISOString().slice(5, data.step < 86400e6 ? 13 : 10).replace("T", " ") : ""}</span>)}</div><div />
        {!collapsed && data.types.map((t, index) => <div className={`w-heat-row ${index === 0 || data.types[index - 1].category !== t.category ? "group-start" : ""}`} key={t.type}>
          <button className={`w-type-label ${selected?.type === t.type ? "is-selected" : ""}`} aria-pressed={selected?.type === t.type} style={{ borderLeft: `3px solid ${categoryColors[(t.category - 1) % categoryColors.length]}` }} title={`${t.type} · ${data.categories.find(c => c.id === t.category)?.label}`} onClick={() => choose(selected?.type === t.type ? null : { start: data.coverage.start, end: data.coverage.end, type: t.type, label: t.display_label })}>{t.display_label}</button>
          <div className="w-cells" style={{ gridTemplateColumns: `repeat(${data.buckets.length || 1},1fr)` }}>{data.buckets.map(b => {
            const n = cells.get(`${t.type}:${b}`) ?? 0;
            const isSelected = selected?.type === t.type;
            const covered = b < data.coverage.end && b + data.step > data.coverage.start;
            return <button key={b} className={`mc2-cell ${!covered ? "outside" : ""}`} aria-pressed={!!isSelected} aria-label={`${t.type} ${time(b)} ${n} 条记录`} title={`${t.display_label} · ${t.type}\n${time(b)} 至 ${time(b + data.step)}（不含终点）\n${covered ? `${number(n)} 条记录` : "数据覆盖外"}`} style={{ background: covered ? n ? `rgba(38,115,184,${.16 + .84 * Math.log1p(n) / Math.log1p(legendMax.current.max)})` : "#eef2f6" : undefined }} onClick={() => choose(isSelected ? null : { start: data.coverage.start, end: data.coverage.end, type: t.type, label: t.display_label })} />;
          })}</div><div className="w-total-bar"><i style={{ width: `${rowTotals[t.type] / rowPeak * 100}%`, background: `${categoryColors[(t.category - 1) % categoryColors.length]}30` }} /><b>{number(rowTotals[t.type])}</b></div>
        </div>)}
      </div>
    </div>
    <div className="mc2-legend"><span>零记录</span><i style={{ background: "#eef2f6" }} /><span>1</span><i style={{ background: "#d9e6f2" }} /><i style={{ background: "#8ab2d5" }} /><i style={{ background: "#2673b8" }} /><span>{number(max)} · 统一对数数量刻度 · 动作与回执分别计数</span></div>
  </>;
}
