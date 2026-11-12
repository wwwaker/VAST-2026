
export function shortBucket(bucket, granularity) {
  if (!bucket) return '';
  if (granularity === 'daily') {
    const [, m, d] = bucket.split('-');
    return `${Number(m)}/${Number(d)}`;
  }
  if (granularity === 'hourly') {
    return `${bucket.slice(5, 10)} ${bucket.slice(11, 16)}`;
  }
  return bucket;
}

export function fmtRoundLabel(hour) {
  if (!hour) return '';
  const [date, time] = hour.split('T');
  const [, m, d] = date.split('-');
  const hh = (time || '').slice(0, 5);
  return `${Number(m)}月${Number(d)}日 · ${hh}`;
}

const BLUES = [
  [240, 246, 255],
  [200, 223, 248], // #c8dff8
  [147, 190, 236], // #93beec
  [85, 143, 216],  // #558fd8
  [26, 92, 192],
];
export function bluesRGB(t) {
  const x = Math.max(0, Math.min(1, t)) * (BLUES.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = BLUES[i], b = BLUES[Math.min(i + 1, BLUES.length - 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function countColor(count, max) {
  if (!count || !max) return { bg: '#edf2f8', opacity: 1, fg: '#637a92' };

  const norm = Math.log1p(count) / Math.log1p(max);
  const [r, g, b] = bluesRGB(norm);

  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const fg = lum > 150 ? '#10202f' : '#fff';
  return { bg: `rgb(${r},${g},${b})`, opacity: 1, fg };
}

export function sentimentCellColor(score) {
  if (score === null || score === undefined) return { bg: '#edf2f8', opacity: 0.7 };

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
  return { bg, opacity: 1 };
}

export function semanticCellColor(distance) {
  if (distance === null || distance === undefined) return { bg: '#edf2f8', opacity: 0.7 };

  const t = Math.max(0, Math.min(1, distance));
  const r = Math.round(0x2a + (0x9d - 0x2a) * t);
  const g = Math.round(0x33 + (0x4d - 0x33) * t);
  const b = Math.round(0x5e + (0xdd - 0x5e) * t);
  return { bg: `rgb(${r},${g},${b})`, opacity: t < 0.05 ? 0.7 : 1 };
}

// ISO zaman → heatmap/line chart bucket anahtarı (backend bucket_expression ile aynı kural)
export function timeToBucket(time, granularity) {
  if (!time) return '';
  return granularity === 'daily' ? time.slice(0, 10) : time.slice(0, 13) + ':00:00';
}

export function apiTimeToInputValue(value) {
  if (!value) return '';
  return value.slice(0, 16);
}
export function inputValueToApiTime(value) {
  if (!value) return '';
  return value.length === 16 ? `${value}:00` : value;
}

export function formatRecipients(value) {
  if (!value) return '[]';
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.join(', ');
  } catch (_) {
    return value;
  }
  return value;
}

export function fmtPct(v) {
  if (v === null || v === undefined) return 'N/A';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

export function pctClass(v) {
  if (v === null || v === undefined) return 'pct-na';
  return v >= 0 ? 'pct-up' : 'pct-down';
}

export function fmtSigned(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}
