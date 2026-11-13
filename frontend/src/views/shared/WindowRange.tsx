import { useRef } from "react";

/** MC1's two handles on one track, also usable with continuous seconds. */
export function WindowRange({ minimum = 0, maximum, value, change, step = 1, minSpan = 0, startLabel = "窗口起点", endLabel = "窗口终点", windowLabel = "平移时间窗口" }: { minimum?: number; maximum: number; value: [number, number]; change: (value: [number, number]) => void; step?: number; minSpan?: number; startLabel?: string; endLabel?: string; windowLabel?: string }) {
  const drag = useRef<{ x: number; width: number; value: [number, number] } | null>(null);
  const extent = Math.max(step, maximum - minimum), gap = Math.min(minSpan, Math.max(0, maximum - minimum));
  const shift = (start: number, span = value[1] - value[0]) => { const snapped = minimum + Math.round((start - minimum) / step) * step; const a = Math.max(minimum, Math.min(maximum - span, snapped)); change([a, a + span]); };
  return <div className="tl-range-multi" onPointerMove={e => { if (!drag.current) return; const initial = drag.current; shift(initial.value[0] + (e.clientX - initial.x) / initial.width * extent, initial.value[1] - initial.value[0]); }} onPointerUp={e => { drag.current = null; if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { drag.current = null; }}>
    <div className="tl-track"/>
    <div className="tl-track-fill" style={{ left: `${(value[0] - minimum) / extent * 100}%`, width: `${(value[1] - value[0]) / extent * 100}%` }}/>
    <div className="tl-window-drag" role="slider" tabIndex={0} aria-label={windowLabel} aria-valuemin={minimum} aria-valuemax={maximum - (value[1] - value[0])} aria-valuenow={value[0]} aria-valuetext={`${value[0].toFixed(3)}–${value[1].toFixed(3)}`} style={{ left: `${(value[0] - minimum) / extent * 100}%`, width: `${(value[1] - value[0]) / extent * 100}%` }} onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); const host = e.currentTarget.parentElement!; drag.current = { x: e.clientX, width: Math.max(1, host.getBoundingClientRect().width), value: [...value] }; host.setPointerCapture?.(e.pointerId); }} onKeyDown={e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); const delta = Math.max(step, extent / 100); shift(e.key === "Home" ? minimum : e.key === "End" ? maximum : value[0] + (e.key === "ArrowLeft" ? -delta : delta)); } }}/>
    <input className="tl-range tl-range-start" type="range" min={minimum} max={maximum} step={step} value={value[0]} onChange={e => change([Math.max(minimum, Math.min(Number(e.target.value), value[1] - gap)), value[1]])} aria-label={startLabel} aria-valuetext={value[0].toFixed(3)}/>
    <input className="tl-range tl-range-end" type="range" min={minimum} max={maximum} step={step} value={value[1]} onChange={e => change([value[0], Math.min(maximum, Math.max(Number(e.target.value), value[0] + gap))])} aria-label={endLabel} aria-valuetext={value[1].toFixed(3)}/>
  </div>;
}
