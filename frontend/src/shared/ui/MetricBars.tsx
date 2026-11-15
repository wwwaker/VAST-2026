/** A common zero baseline for each metric; exact values remain readable. */
export function barShade(color: string, ratio: number) {
  const channels = (color.match(/#[\da-f]{6}/i)?.[0] ?? "#6e9fcb")
    .slice(1)
    .match(/.{2}/g)!
    .map((s) => parseInt(s, 16));

  const weight = 0.35 + 0.65 * Math.max(0, Math.min(1, ratio));

  const light = `rgb(${channels.map((c) => Math.round(255 + (c - 255) * weight)).join(", ")})`;

  return `light-dark(${light}, color-mix(in srgb, ${color} ${weight * 100}%, var(--surface-panel)))`;
}

export function MetricBars({
  values,
  maximum,
  format = String,
}: {
  values: { label: string; value: number | null; className?: string; color?: string }[];
  maximum: number;
  format?: (value: number) => string;
}) {
  return (
    <div className="metric-bars">
      {values.map(({ label, value, className, color }) => (
        <div
          key={label}
          className={`metric-bar ${className ?? ""}`}
          aria-label={`${label}：${value == null ? "未知" : format(value)}`}
        >
          <span className="metric-bar-label">{label}</span>
          <span
            className="metric-bar-track"
            aria-hidden="true"
          >
            <i
              style={{
                width: `${value == null ? 0 : Math.min(100, (value / Math.max(1, maximum)) * 100)}%`,
                background: color
                  ? barShade(color, (value ?? 0) / Math.max(1, maximum))
                  : undefined,
              }}
            />
          </span>
          <b>{value == null ? "未知" : format(value)}</b>
        </div>
      ))}
    </div>
  );
}
