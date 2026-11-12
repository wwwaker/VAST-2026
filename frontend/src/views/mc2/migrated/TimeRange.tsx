import { useEffect, useMemo, useState, type SetStateAction } from "react";
import { CrisisTimeline } from "../../mc1/reference/components/CrisisTimeline";
import type { ActivityData } from "./workspaceApi";
import type { Filters } from "../../../data/filterContext";
import { number, time } from "./shared";

export function TimeRange({ data, filters, change, granularity, setGranularity }: { data: ActivityData; filters: Filters; change: (f: Filters) => void; granularity: string; setGranularity: (g: string) => void }) {
  const buckets = data.buckets, n = buckets.length;
  const start = Math.max(0, buckets.findIndex(b => b + data.step > (filters.startUs ?? buckets[0])));
  const end = Math.max(start, buckets.reduce((last, b, i) => b < (filters.endUs ?? Infinity) ? i : last, 0));
  const [draft, setDraft] = useState<[number, number]>([start, end]);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setDraft([start, end]); }, [start, end]);
  useEffect(() => {
    if (draft[0] === start && draft[1] === end) return;
    const timer = window.setTimeout(() => change({ ...filters, startUs: buckets[draft[0]], endUs: buckets[draft[1]] + data.step }), 180);
    return () => window.clearTimeout(timer);
  }, [draft, start, end, buckets, data.step, filters, change]);
  useEffect(() => {
    if (!playing) return;
    if (draft[1] >= n - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setDraft(value => [value[0], value[1] + 1]), 1000);
    return () => window.clearTimeout(timer);
  }, [playing, draft, n]);
  const timeline = useMemo(() => {
    const totals = new Map<number, number>();
    data.cells.forEach(c => totals.set(c.bucket, (totals.get(c.bucket) ?? 0) + c.count));
    return buckets.map(b => ({ hour: new Date(b / 1000).toISOString().slice(0, 19), total_msgs: totals.get(b) ?? 0, merger_msgs: 0 }));
  }, [data, buckets]);
  const resolve = (value: SetStateAction<number>, previous: number) => typeof value === "function" ? value(previous) : value;
  return <div className="w-shared-timeline" aria-label="全局时间筛选"><CrisisTimeline
    timeline={timeline} idx={draft[1]} startIdx={draft[0]}
    setIdx={(value: SetStateAction<number>) => setDraft(previous => [previous[0], Math.max(previous[0], Math.min(n - 1, resolve(value, previous[1])))])}
    setStartIdx={(value: SetStateAction<number>) => setDraft(previous => [Math.max(0, Math.min(previous[1], resolve(value, previous[0]))), previous[1]])}
    playing={playing} onTogglePlay={() => { if (!playing && draft[1] >= n - 1) setDraft([draft[0], draft[0]]); setPlaying(value => !value); }}
    granularity={granularity} setGranularity={setGranularity} eventMarkers={[]} playTitle="从起点开始逐日扩展调查窗口"
    scaleOptions={[{ value: "day", label: "按日" }, { value: "hour", label: "按小时（10天内）", disabled: ((filters.endUs ?? data.coverage.end) - (filters.startUs ?? data.coverage.start)) > 240 * 3600e6 }]}
    tickColor={(_row: unknown, inRange: boolean) => inRange ? "#579b92" : "#dce4eb"}
    tickLabel={(row: { hour: string; total_msgs: number }) => `${row.hour.slice(0, 10)} · 全库 ${number(row.total_msgs)} 条`}
    tickAriaLabel={(row: { hour: string }) => `定位日期 ${row.hour.slice(0, 10)}`}
    onTick={(i: number) => { setPlaying(false); setDraft([i, i]); }}
    renderMeta={() => <><span className="tl-round">日期 {draft[0] + 1}–{draft[1] + 1} / {n}</span><span className="tl-date">{time(filters.startUs ?? data.coverage.start)} → {time(filters.endUs ?? data.coverage.end)}（不含终点）</span><span>全库数量 · UTC</span><button className="fp-toggle" onClick={() => { setPlaying(false); change({ ...filters, startUs: null, endUs: null }); }}>全部时间</button></>}
  /></div>;
}
