import type { ProcessAggregate, ProcessItem } from "./workspaceApi";

export type ProcessMark = { id: string; lane: string; time: number; count: number; context: boolean; events: ProcessItem[]; aggregates: ProcessAggregate[]; x: number; y: number; track: number; label: boolean };
/** Sweep occupied pixel intervals. Time remains exact; only y is stacked. */
export function processLayout(items: ProcessItem[], aggregates: ProcessAggregate[], lanes: string[], start: number, end: number, anchor: string, selected?: string, expanded = false) {
  const x = (t: number) => 205 + (t - start) / Math.max(1, end - start) * 810;
  const marks: ProcessMark[] = [
    ...items.map(i => ({ id: i.event_id, lane: i.actor_id ?? "__missing__", time: i.time_us, count: 1, context: i.context, events: [i], aggregates: [] as ProcessAggregate[], x: x(i.time_us), y: 0, track: 0, label: false })),
    ...aggregates.map(a => ({ id: a.aggregate_id, lane: a.lane_id, time: a.bucket_start, count: a.count, context: a.context, events: [] as ProcessItem[], aggregates: [a], x: x(a.bucket_start), y: 0, track: 0, label: false })),
  ].filter(m => lanes.includes(m.lane) && m.time >= start && m.time < end);
  const output: ProcessMark[] = [], heights: number[] = [], offsets: number[] = [];
  lanes.forEach(lane => {
    offsets.push(heights.reduce((a,b) => a+b, 60));
    const tracks: number[] = [];
    const rank = (m:ProcessMark) => m.id===anchor?0:m.id===selected?1:m.events.some(i=>i.event_type==='queue_subordinate_task')?2:3;
    const source = marks.filter(m => m.lane === lane).sort((a,b) => a.time-b.time || rank(a)-rank(b) || a.id.localeCompare(b.id));
    for (const mark of source) {
      const half = mark.count > 1 ? 24 : 10;
      let track = tracks.findIndex(t => t + 4 < mark.x - half);
      if (track < 0) track = tracks.length;
      if (!expanded && track >= 4 && mark.id !== anchor && mark.id !== selected) {
        // Display aggregation contains identities, not a representative event.
        const previous = [...output].reverse().find(m => m.lane === lane && m.track === 3 && m.context === mark.context && Math.abs(m.x-mark.x) < 52 && m.id !== anchor && m.id !== selected);
        if (previous) { previous.events.push(...mark.events); previous.aggregates.push(...mark.aggregates); previous.count += mark.count; previous.id = `collision:${previous.events.map(e => e.event_id).join(',')}:${previous.aggregates.map(a=>a.aggregate_id).join(',')}`; continue; }
        // Different main/context groups keep a separate track rather than mix counts.
      }
      mark.track = track; tracks[track] = mark.x + half;
      output.push(mark);
    }
    const occupied = new Map<number,[number,number][]>();
    for (const mark of output.filter(m=>m.lane===lane && m.count===1 && !m.aggregates.length).sort((a,b)=>rank(a)-rank(b)||a.time-b.time||a.id.localeCompare(b.id))) {
      const intervals=occupied.get(mark.track)??[], left=mark.x+11, right=left+132;
      if (!intervals.some(([a,b])=>left<b+4 && right>a-4)) {mark.label=true;intervals.push([left,right]);occupied.set(mark.track,intervals);}
    }
    heights.push(Math.max(80, tracks.length * 46 + 40));
  });
  for (const mark of output) mark.y = offsets[lanes.indexOf(mark.lane)] + 28 + mark.track * 46;
  return { marks: output, offsets, heights, height: heights.reduce((a,b)=>a+b, 90) };
}
