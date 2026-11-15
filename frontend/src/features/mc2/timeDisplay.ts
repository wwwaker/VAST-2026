/** Display helpers only. Query bounds and event positions remain integer microseconds. */
export function duration(us: number): string {
  let remaining = Math.round(Math.abs(us));
  const parts: string[] = [];
  for (const [unit, size] of [
    ["天", 86400e6],
    ["小时", 3600e6],
    ["分", 60e6],
  ] as const) {
    const n = Math.floor(remaining / size);
    if (n || parts.length) {
      parts.push(`${n}${unit}`);
    }
    remaining %= size;
  }
  parts.push(
    `${(remaining / 1e6).toLocaleString("zh-CN", { maximumFractionDigits: 6, useGrouping: false })}秒`,
  );

  return parts.join("");
}

export const relativeTime = (us: number) =>
  us === 0 ? "0" : `${us < 0 ? "−" : "+"}${duration(us)}`;

export function axisTime(us: number, step: number): string {
  if (!us) {
    return "0";
  }
  const abs = Math.abs(us);
  const sign = us < 0 ? "−" : "+";

  const [size, unit] =
    step >= 86400e6
      ? [86400e6, "天"]
      : step >= 3600e6
        ? [3600e6, "小时"]
        : step >= 60e6
          ? [60e6, "分"]
          : step >= 1e6
            ? [1e6, "秒"]
            : step >= 1000
              ? [1000, "毫秒"]
              : [1, "微秒"];

  return `${sign}${(abs / size).toLocaleString("zh-CN", { maximumFractionDigits: 6, useGrouping: false })}${unit}`;
}

export function timeTicks(
  min: number,
  max: number,
  width = 810,
): { value: number; label: string }[] {
  const desired = Math.max(1, (max - min) / Math.max(1, Math.floor(width / 110)));
  const power = 10 ** Math.floor(Math.log10(desired));
  const step = Math.max(1, [1, 2, 5, 10].map((n) => n * power).find((n) => n >= desired)!);
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value < max && ticks.length < 30; value += step) {
    const rounded = Math.round(value);
    ticks.push({ value: rounded, label: axisTime(rounded, step) });
  }

  return ticks;
}

export const shortUtc = (us: number, date = false) =>
  new Date(Math.floor(us / 1e6) * 1000)
    .toISOString()
    .slice(date ? 5 : 11, 19)
    .replace("T", " ") + " UTC";

export const rangeLabels = (start: number, end: number) => {
  const dates =
    new Date(start / 1000).toISOString().slice(0, 10) !==
    new Date(end / 1000).toISOString().slice(0, 10);

  return [shortUtc(start, dates), shortUtc(end, dates)];
};
