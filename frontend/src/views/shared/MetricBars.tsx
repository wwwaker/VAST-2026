/** A common zero baseline for each metric; exact values remain readable. */
export function barShade(color: string, ratio: number) {
  const channels = color.replace("#", "").match(/.{2}/g)!.map(s => parseInt(s, 16));
  const weight = .35 + .65 * Math.max(0, Math.min(1, ratio));
  return `rgb(${channels.map(c => Math.round(255 + (c - 255) * weight)).join(", ")})`;
}
export function MetricBars({ values, maximum, format = String }: { values: { label: string; value: number | null; className?: string; color?: string }[]; maximum: number; format?: (value: number) => string }) {
  return <div className="metric-bars">{values.map(({ label, value, className, color }) => <div key={label} className={`metric-bar ${className ?? ""}`} aria-label={`${label}：${value == null ? "未知" : format(value)}`}><span className="metric-bar-label">{label}</span><span className="metric-bar-track" aria-hidden="true"><i style={{ width: `${value == null ? 0 : Math.min(100, value / Math.max(1, maximum) * 100)}%`, background: color ? barShade(color, (value ?? 0) / Math.max(1, maximum)) : undefined }}/></span><b>{value == null ? "未知" : format(value)}</b></div>)}</div>;
}
