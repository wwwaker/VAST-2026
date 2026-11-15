/** Keep categorical hue identity while raising its visibility on dark chart surfaces. */
export function seriesColor(color: string) {
  return `light-dark(${color}, color-mix(in srgb, ${color} 65%, white))`;
}

/** Choose a legible foreground for quantitative cells without changing their scale. */
export function darkCellText(channels: number[]) {
  const luminance = channels
    .map((channel) => {
      const value = channel / 255;

      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);

  return luminance > 0.179 ? "#000" : "#fff";
}

/** Preserve existing alpha bytes in light mode; CSS colors cannot take a hex suffix. */
export function colorAlpha(color: string, alpha: string) {
  return /^#[\da-f]{6}$/i.test(color)
    ? `${color}${alpha}`
    : `color-mix(in srgb, ${color} ${(parseInt(alpha, 16) / 255) * 100}%, transparent)`;
}

const resolvedColors = new Map<string, string>();

/** Canvas renderers need concrete colors; DOM/SVG can inherit CSS colors directly. */
export function resolveChartColor(color: string) {
  const key = `${document.documentElement.dataset.theme}:${color}`;
  const cached = resolvedColors.get(key);
  if (cached) {
    return cached;
  }
  const probe = document.createElement("span");
  probe.style.color = color;
  probe.style.display = "none";
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = computed;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  const resolved = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
  resolvedColors.set(key, resolved);

  return resolved;
}
