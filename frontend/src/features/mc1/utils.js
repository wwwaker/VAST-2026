import { darkCellText } from "../../shared/lib/chartColors";

export function shortBucket(bucket, granularity) {
  if (!bucket) {
    return "";
  }
  if (granularity === "daily") {
    const [, m, d] = bucket.split("-");

    return `${Number(m)}/${Number(d)}`;
  }
  if (granularity === "hourly") {
    return `${bucket.slice(5, 10)} ${bucket.slice(11, 16)}`;
  }

  return bucket;
}

export { fmtRoundLabel } from "../../shared/lib/timeLabels.js";

const BLUES = [
  [240, 246, 255],
  [200, 223, 248], // #c8dff8
  [147, 190, 236], // #93beec
  [85, 143, 216], // #558fd8
  [26, 92, 192],
];

export function bluesRGB(t) {
  const x = Math.max(0, Math.min(1, t)) * (BLUES.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = BLUES[i];
  const b = BLUES[Math.min(i + 1, BLUES.length - 1)];

  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function countColor(count, max) {
  if (!count || !max) {
    return { bg: "var(--surface-grid)", opacity: 1, fg: "var(--chart-empty-text)" };
  }

  const norm = Math.log1p(count) / Math.log1p(max);
  const [r, g, b] = bluesRGB(norm);

  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const fg = lum > 150 ? "#10202f" : "#fff";
  const dark = darkCountRGB(norm);

  const darkForeground = darkCellText(dark);

  return {
    bg: `light-dark(rgb(${r},${g},${b}), rgb(${dark.join(",")}))`,
    opacity: 1,
    fg: `light-dark(${fg}, ${darkForeground})`,
  };
}

function darkCountRGB(t) {
  const stops = [
    [35, 54, 77],
    [54, 94, 132],
    [77, 136, 183],
    [115, 176, 228],
    [156, 208, 255],
  ];

  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const a = stops[Math.floor(x)];
  const b = stops[Math.min(Math.floor(x) + 1, stops.length - 1)];

  return a.map((c, i) => Math.round(c + (b[i] - c) * (x % 1)));
}

export function sentimentCellColor(score) {
  if (score === null || score === undefined) {
    return { bg: "var(--surface-grid)", opacity: 0.7 };
  }

  let bg;
  if (score >= 0) {
    const t = Math.min(1, score);
    const r = Math.round(0x9a + (0x37 - 0x9a) * t);
    const g = Math.round(0xa7 + (0x8a - 0xa7) * t);
    const b = Math.round(0xb5 + (0xdd - 0xb5) * t);
    bg = `rgb(${r},${g},${b})`;
  } else {
    const t = Math.min(1, -score);
    const r = Math.round(0x9a + (0xe2 - 0x9a) * t);
    const g = Math.round(0xa7 + (0x4b - 0xa7) * t);
    const b = Math.round(0xb5 + (0x4a - 0xb5) * t);
    bg = `rgb(${r},${g},${b})`;
  }

  const endpoint = score >= 0 ? [103, 173, 245] : [242, 119, 115];

  const dark = [55, 70, 89].map((c, i) =>
    Math.round(c + (endpoint[i] - c) * Math.min(1, Math.abs(score))),
  );

  return {
    bg: `light-dark(${bg}, rgb(${dark.join(",")}))`,
    fg: `light-dark(#fff, ${darkCellText(dark)})`,
    opacity: 1,
  };
}

export function semanticCellColor(distance) {
  if (distance === null || distance === undefined) {
    return { bg: "var(--surface-grid)", opacity: 0.7 };
  }

  const t = Math.max(0, Math.min(1, distance));
  const r = Math.round(0x2a + (0x9d - 0x2a) * t);
  const g = Math.round(0x33 + (0x4d - 0x33) * t);
  const b = Math.round(0x5e + (0xdd - 0x5e) * t);

  const dark = [40, 38, 70].map((c, i) => Math.round(c + ([164, 134, 245][i] - c) * t));

  return {
    bg: `light-dark(rgb(${r},${g},${b}), rgb(${dark.join(",")}))`,
    opacity: t < 0.05 ? 0.7 : 1,
  };
}

// 将源时间映射为热力图／折线图的桶键，与后端 bucket_expression 保持一致。
export function timeToBucket(time, granularity) {
  if (!time) {
    return "";
  }

  return granularity === "daily" ? time.slice(0, 10) : time.slice(0, 13) + ":00:00";
}

export function apiTimeToInputValue(value) {
  if (!value) {
    return "";
  }

  return value.slice(0, 16);
}

export function inputValueToApiTime(value) {
  if (!value) {
    return "";
  }

  return value.length === 16 ? `${value}:00` : value;
}

export function formatRecipients(value) {
  if (!value) {
    return "[]";
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.join(", ");
    }
  } catch (_) {
    return value;
  }

  return value;
}

export function fmtPct(v) {
  if (v === null || v === undefined) {
    return "N/A";
  }
  const sign = v > 0 ? "+" : "";

  return `${sign}${v.toFixed(1)}%`;
}

export function pctClass(v) {
  if (v === null || v === undefined) {
    return "pct-na";
  }

  return v >= 0 ? "pct-up" : "pct-down";
}

export function fmtSigned(v) {
  if (v === null || v === undefined || Number.isNaN(v)) {
    return "";
  }

  return (v >= 0 ? "+" : "") + v.toFixed(2);
}
