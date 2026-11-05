import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scaleLinear } from "d3-scale";
import { CATEGORIES, categoryOf } from "../theme/categories";
import { useTheme } from "../theme/theme";
import { useWorkspace } from "../state/workspace";
import {
  fetchDatasets,
  fetchOverview,
  formatUtc,
  formatUtcDate,
  type DatasetInfo,
  type OverviewPayload,
} from "../data/api";

const PAD = { top: 18, right: 16, bottom: 26, left: 46 };
const CAT_COUNT = CATEGORIES.length;

interface Aggregates {
  byCategory: Float64Array;
  totals: Float64Array;
  max: number;
}

export function OverviewView() {
  const { dataset, filters, setFilters, cursor, masking, selectedEventAt, setCursor } = useWorkspace();
  const { colors, reducedMotion } = useTheme();

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [info, setInfo] = useState<DatasetInfo | null>(null);
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [granularity, setGranularity] = useState<"day" | "hour">("day");
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 320 });
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const visibleCategory = useCallback(
    (id: number) => filters.categories.length === 0 || filters.categories.includes(id),
    [filters.categories],
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setOverview(null);
    Promise.all([fetchDatasets(), fetchOverview(dataset, { granularity, topTypes: 6 })])
      .then(([datasets, payload]) => {
        if (cancelled) return;
        setInfo(datasets.find((d) => d.dataset_id === dataset) ?? null);
        setOverview(payload);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "接口不可用");
      });
    return () => {
      cancelled = true;
    };
  }, [dataset, granularity]);

  const setWrap = useCallback((node: HTMLDivElement | null) => {
    wrapRef.current = node;
    roRef.current?.disconnect();
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ w: Math.max(320, rect.width), h: Math.max(180, rect.height) });
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);

  const series = overview?.series;
  const bucketCount = series?.buckets.length ?? 0;

  const agg = useMemo<Aggregates | null>(() => {
    if (!series || bucketCount === 0) return null;
    const byCategory = new Float64Array(bucketCount * CAT_COUNT);
    for (const [b, t, count] of series.points) {
      const cat = categoryOf(series.types[t] ?? "__other__").id - 1;
      byCategory[b * CAT_COUNT + cat] += count;
    }
    const totals = new Float64Array(bucketCount);
    let max = 1;
    for (let b = 0; b < bucketCount; b++) {
      let sum = 0;
      for (let c = 0; c < CAT_COUNT; c++) {
        if (visibleCategory(CATEGORIES[c].id)) sum += byCategory[b * CAT_COUNT + c];
      }
      totals[b] = sum;
      if (sum > max) max = sum;
    }
    return { byCategory, totals, max };
  }, [series, bucketCount, visibleCategory]);

  const xScale = useMemo(
    () => scaleLinear().domain([0, Math.max(1, bucketCount)]).range([PAD.left, size.w - PAD.right]),
    [bucketCount, size.w],
  );
  const yScale = useMemo(
    () => scaleLinear().domain([0, agg?.max ?? 1]).nice().range([size.h - PAD.bottom, PAD.top]),
    [agg, size.h],
  );

  const anchors = info?.anchors ?? [];
  const anchorPositions = useMemo(() => {
    if (!series || anchors.length === 0) return [];
    return anchors.map((a) => {
      const idx = series.buckets.findIndex((b) => b >= a.sort_key);
      const i = idx === -1 ? bucketCount - 1 : idx;
      return { anchor: a, x: xScale(i + 0.5) };
    });
  }, [anchors, series, bucketCount, xScale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !series || !agg) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const plotBottom = size.h - PAD.bottom;
    const plotRight = size.w - PAD.right;
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");

    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors.textFaint;
    ctx.font = `11px ${mono}`;
    ctx.lineWidth = 1;
    for (const tick of yScale.ticks(4)) {
      const y = yScale(tick);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y + 0.5);
      ctx.lineTo(plotRight, y + 0.5);
      ctx.stroke();
      ctx.fillText(String(tick), 6, y + 4);
    }

    const tickCount = Math.min(6, bucketCount);
    for (let i = 0; i < tickCount; i++) {
      const idx = Math.round((i / Math.max(1, tickCount - 1)) * (bucketCount - 1));
      const x = xScale(idx + 0.5);
      // 首末刻度贴边对齐，避免被裁掉
      if (i === 0) ctx.textAlign = "left";
      else if (i === tickCount - 1) ctx.textAlign = "right";
      else ctx.textAlign = "center";
      ctx.fillText(formatUtcDate(series.buckets[idx]), x, size.h - 8);
    }
    ctx.textAlign = "left";

    const step = (plotRight - PAD.left) / Math.max(1, bucketCount);
    // 桶很少时（如自建集只有 1 天）不要撑满整幅，限制宽度并居中
    const barW = Math.min(48, Math.max(0.8, step - 0.2));
    const barOffset = (step - barW) / 2;
    const maskCutoff = masking && cursor != null ? cursor : null;

    for (let b = 0; b < bucketCount; b++) {
      if (maskCutoff != null && series.buckets[b] > maskCutoff) continue;
      const total = agg.totals[b];
      if (total <= 0) continue;
      const x = xScale(b) + barOffset;
      let yCursor = plotBottom;
      for (let c = 0; c < CAT_COUNT; c++) {
        if (!visibleCategory(CATEGORIES[c].id)) continue;
        const v = agg.byCategory[b * CAT_COUNT + c];
        if (v <= 0) continue;
        const h = plotBottom - yScale(v);
        yCursor -= h;
        ctx.fillStyle = colors.categories[c];
        ctx.fillRect(x, yCursor, barW, Math.max(1, h));
      }
    }

    if (filters.from != null && filters.to != null) {
      const i0 = series.buckets.findIndex((b) => b >= filters.from!);
      const i1 = series.buckets.findIndex((b) => b > filters.to!);
      const x0 = xScale(i0 === -1 ? 0 : i0);
      const x1 = xScale(i1 === -1 ? bucketCount : i1);
      ctx.fillStyle = colors.selection;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(x0, PAD.top, Math.max(1, x1 - x0), plotBottom - PAD.top);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.selection;
      ctx.beginPath();
      ctx.moveTo(x0, PAD.top);
      ctx.lineTo(x0, plotBottom);
      ctx.moveTo(x1, PAD.top);
      ctx.lineTo(x1, plotBottom);
      ctx.stroke();
    }

    if (drag) {
      const x0 = Math.min(drag.x0, drag.x1);
      const x1 = Math.max(drag.x0, drag.x1);
      ctx.fillStyle = colors.selection;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x0, PAD.top, x1 - x0, plotBottom - PAD.top);
      ctx.globalAlpha = 1;
    }

    if (cursor != null) {
      const idx = series.buckets.findIndex((b) => b >= cursor);
      const x = xScale(idx === -1 ? bucketCount : idx);
      ctx.strokeStyle = colors.warn;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top - 4);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    for (const { x } of anchorPositions) {
      ctx.fillStyle = colors.risk;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top - 2);
      ctx.lineTo(x - 4, PAD.top - 10);
      ctx.lineTo(x + 4, PAD.top - 10);
      ctx.closePath();
      ctx.fill();
    }

    if (selectedEventAt != null) {
      const idx = series.buckets.findIndex((b) => b >= selectedEventAt);
      const x = xScale(idx === -1 ? bucketCount : idx + 0.5);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, PAD.top - 6, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }, [
    series,
    agg,
    size,
    colors,
    xScale,
    yScale,
    filters.from,
    filters.to,
    drag,
    cursor,
    masking,
    anchorPositions,
    selectedEventAt,
    bucketCount,
    visibleCategory,
  ]);

  const xToBucket = useCallback(
    (x: number) => {
      if (bucketCount === 0) return 0;
      const ratio = (x - PAD.left) / Math.max(1, size.w - PAD.right - PAD.left);
      return Math.max(0, Math.min(bucketCount - 1, Math.round(ratio * (bucketCount - 1))));
    },
    [bucketCount, size.w],
  );

  const bucketEnd = useCallback(
    (index: number) => {
      if (!series) return 0;
      return series.buckets[index] + (granularity === "hour" ? 3600 : 86400);
    },
    [series, granularity],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < PAD.left) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x0: x, x1: x });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (drag) {
      setDrag({ x0: drag.x0, x1: x });
      return;
    }
    setHover(xToBucket(x));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag || !series) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i0 = xToBucket(Math.min(drag.x0, x));
    const i1 = xToBucket(Math.max(drag.x0, x));
    setDrag(null);
    if (Math.abs(x - drag.x0) < 3) {
      if (filters.from != null) setFilters({ from: null, to: null });
      return;
    }
    setFilters({ from: series.buckets[i0], to: bucketEnd(i1) });
  };

  // 只有"存在起始时间晚于游标的桶"才算真的遮住了记录；
  // 游标停在数据集末尾时，最后一桶虽未结束，但内容已全部可见，不应报警。
  const hasMaskedRecords =
    masking && cursor != null && series != null && series.buckets.some((b) => b > cursor);

  if (error) {
    return (
      <div className="empty-state">
        <h2>无法读取数据</h2>
        <p>{error}</p>
        <p className="muted">
          确认后端已启动：<code>cd backend &amp;&amp; python -m uvicorn app.main:app --port 8000</code>
        </p>
      </div>
    );
  }

  if (!overview || !agg) {
    return <div className="empty-state"><p className="muted">正在载入概览…</p></div>;
  }

  const hoveredBucket = hover != null ? series!.buckets[hover] : null;

  return (
    <div className="overview">
      <div className="overview-head">
        <div>
          <h2>系统活动概览</h2>
          <p className="muted">
            {series!.buckets.length.toLocaleString()} 个{granularity === "hour" ? "小时" : "天"}桶 ·
            共 {overview.total_events.toLocaleString()} 条事件 · 源时区{" "}
            {overview.timezone_status === "unknown" ? "未知" : "UTC"}
          </p>
        </div>
        <div className="overview-tools">
          <div className="seg">
            {(["day", "hour"] as const).map((g) => (
              <button
                key={g}
                type="button"
                className={`seg-item${granularity === g ? " seg-active" : ""}`}
                onClick={() => setGranularity(g)}
                aria-pressed={granularity === g}
              >
                {g === "day" ? "按天" : "按小时"}
              </button>
            ))}
          </div>
          <div className="readout">
            {hoveredBucket != null ? (
              <>
                <span className="readout-key">{formatUtc(hoveredBucket)}</span>
                <span className="readout-val">{agg.totals[hover!].toLocaleString()} 条</span>
              </>
            ) : (
              <span className="muted">拖动选取时间窗</span>
            )}
          </div>
        </div>
      </div>

      <div className="chart-wrap" ref={setWrap}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="系统活动时间分布，按事件类别堆叠"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
        />
        {hasMaskedRecords && <div className="mask-badge">回放遮蔽中：游标之后的记录不显示</div>}
        {!masking && cursor != null && <div className="mask-badge mask-off">已关闭回放遮蔽</div>}
      </div>

      <div className="legend">
        {CATEGORIES.map((c) => {
          const active = visibleCategory(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className={`legend-item${active ? "" : " legend-off"}`}
              onClick={() =>
                setFilters({
                  categories: active
                    ? filters.categories.length === 0
                      ? CATEGORIES.filter((x) => x.id !== c.id).map((x) => x.id)
                      : filters.categories.filter((x) => x !== c.id)
                    : [...filters.categories, c.id],
                })
              }
              aria-pressed={active}
            >
              <span className="swatch" style={{ background: colors.categories[c.id - 1] }} />
              {c.label}
            </button>
          );
        })}
      </div>

      {anchors.length > 0 && (
        <div className="anchor-row">
          <span className="anchor-label">预置锚点</span>
          {anchors.map((a) => (
            <button
              key={a.key}
              type="button"
              className={`anchor-chip${a.primary ? " anchor-primary" : ""}`}
              title={a.note}
              onClick={() => {
                setFilters({ from: a.sort_key - 3600, to: a.sort_key + 3600 });
                setCursor(a.sort_key);
              }}
            >
              {a.primary && <span className="anchor-star" aria-label="演示主线">★</span>}
              {formatUtcDate(a.sort_key)} · {a.label}
            </button>
          ))}
        </div>
      )}

      {info?.intervention && (
        <div className="callout intervention">
          <strong>建议的唯一干预点</strong>
          <p>{info.intervention}</p>
        </div>
      )}

      {reducedMotion && <p className="muted small">已开启减少动态效果，图表仅静态重绘。</p>}

    </div>
  );
}
