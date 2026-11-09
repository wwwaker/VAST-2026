import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scaleLinear } from "d3-scale";
import { CATEGORIES } from "../theme/categories";
import { useTheme } from "../theme/theme";
import { useWorkspace } from "../state/workspace";
import {
  HOUR_US,
  fetchDatasets,
  fetchOverview,
  formatUtc,
  formatUtcDate,
  type DatasetInfo,
  type OverviewPayload,
  type OverviewSeries,
} from "../data/api";
import { hasActiveFilters } from "../data/filterContext";
import { useDebounced } from "../hooks/useDebounced";

const PAD = { top: 20, right: 16, bottom: 28, left: 52 };
const CAT_COUNT = CATEGORIES.length;
const DAY_US = 86_400_000_000;

interface Matrix {
  byCategory: Float64Array;
  totals: Float64Array;
  max: number;
}

function buildMatrix(series: OverviewSeries | undefined): Matrix | null {
  if (!series || series.buckets.length === 0) return null;
  const count = series.buckets.length;
  const byCategory = new Float64Array(count * CAT_COUNT);
  const totals = new Float64Array(count);
  let max = 1;
  for (const [bucket, category, value] of series.points) {
    if (bucket < 0 || bucket >= count) continue;
    const index = Math.max(0, Math.min(CAT_COUNT - 1, category));
    byCategory[bucket * CAT_COUNT + index] += value;
    totals[bucket] += value;
  }
  for (let i = 0; i < count; i++) if (totals[i] > max) max = totals[i];
  return { byCategory, totals, max };
}

/**
 * 活动分布概览。MC2 单页（F2）以 `compact` 复用同一份 overview 聚合：
 * 只保留粒度、悬停读数、图形、类别图例与锚点，标题/干预说明由页面卡片承担，
 * 不再新建第二套活动聚合服务。
 */
export function OverviewView({ compact = false }: { compact?: boolean } = {}) {
  const {
    dataset,
    filters,
    setFilters,
    cursor,
    masking,
    selectedEventAt,
    setCursor,
  } = useWorkspace();
  const { colors, reducedMotion } = useTheme();

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [info, setInfo] = useState<DatasetInfo | null>(null);
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [granularity, setGranularity] = useState<"day" | "hour">("day");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState({ w: 800, h: 320 });
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const [hoverUs, setHoverUs] = useState<number | null>(null);

  const keyword = useDebounced(filters.keyword, 250);
  const requestFilters = useMemo(() => ({ ...filters, keyword }), [filters, keyword]);
  const active = hasActiveFilters(requestFilters);

  useEffect(() => {
    const controller = new AbortController();
    fetchDatasets(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) {
          setInfo(list.find((d) => d.dataset_id === dataset) ?? null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setInfo(null);
      });
    return () => controller.abort();
  }, [dataset]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setLoading(true);
    fetchOverview(
      dataset,
      { filters: requestFilters, granularity, cursorUs: cursor, masking },
      controller.signal,
    )
      .then((payload) => {
        if (!controller.signal.aborted) setOverview(payload);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "接口不可用");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [dataset, granularity, requestFilters, cursor, masking]);

  const setWrap = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    wrapRef.current = node;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ w: Math.max(320, rect.width), h: Math.max(180, rect.height) });
    });
    observer.observe(node);
    roRef.current = observer;
  }, []);

  const rangeStart = overview?.time_range.start_us ?? 0;
  const rangeEnd = overview?.time_range.end_us ?? 1;
  const bucketUs = granularity === "hour" ? HOUR_US : DAY_US;

  const xScale = useMemo(
    () => scaleLinear().domain([rangeStart, rangeEnd]).range([PAD.left, Math.max(PAD.left + 1, size.w - PAD.right)]),
    [rangeStart, rangeEnd, size.w],
  );

  const filteredMatrix = useMemo(() => buildMatrix(overview?.filtered.series), [overview]);
  const globalMatrix = useMemo(() => buildMatrix(overview?.global_context.series), [overview]);

  const yScale = useMemo(
    () =>
      scaleLinear()
        .domain([0, Math.max(filteredMatrix?.max ?? 1, globalMatrix?.max ?? 1)])
        .nice()
        .range([size.h - PAD.bottom, PAD.top]),
    [filteredMatrix, globalMatrix, size.h],
  );

  const visibleCategory = useCallback(
    (id: number) => filters.categories.length === 0 || filters.categories.includes(id),
    [filters.categories],
  );

  const anchors = info?.anchors ?? [];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !overview || !filteredMatrix) return;
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

    // 真实时间横轴：刻度位置来自微秒映射，缺失时段自然留白
    const ticks = xScale.ticks(5);
    ctx.textAlign = "center";
    for (const tick of ticks) {
      const x = xScale(tick);
      if (x < PAD.left - 1 || x > plotRight + 1) continue;
      ctx.fillText(granularity === "day" ? formatUtcDate(tick) : formatUtc(tick).slice(5), x, size.h - 8);
    }
    ctx.textAlign = "left";

    const widthOf = (bucket: number) => Math.max(1, xScale(bucket + bucketUs) - xScale(bucket) - 0.6);
    const bucketCount = filteredMatrix.totals.length;

    // 首末桶可能跨出数据范围，裁剪到绘图区，避免压到坐标轴
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, plotRight - PAD.left, plotBottom - PAD.top);
    ctx.clip();

    // 背景：全局上下文（忽略局部时间窗与非时间筛选），用低饱和轮廓保留对照
    if (active && globalMatrix) {
      const globalBuckets = overview.global_context.series.buckets;
      ctx.fillStyle = colors.textFaint;
      ctx.globalAlpha = 0.22;
      for (let i = 0; i < globalBuckets.length; i++) {
        const total = globalMatrix.totals[i];
        if (total <= 0) continue;
        const x = xScale(globalBuckets[i]);
        const height = plotBottom - yScale(total);
        ctx.fillRect(x, plotBottom - height, widthOf(globalBuckets[i]), Math.max(1, height));
      }
      ctx.globalAlpha = 1;
    }

    const buckets = overview.filtered.series.buckets;
    for (let b = 0; b < bucketCount; b++) {
      const total = filteredMatrix.totals[b];
      if (total <= 0) continue;
      const x = xScale(buckets[b]);
      const width = widthOf(buckets[b]);
      let yCursor = plotBottom;
      for (let c = 0; c < CAT_COUNT; c++) {
        if (!visibleCategory(CATEGORIES[c].id)) continue;
        const value = filteredMatrix.byCategory[b * CAT_COUNT + c];
        if (value <= 0) continue;
        const height = plotBottom - yScale(value);
        yCursor -= height;
        ctx.fillStyle = colors.categories[c];
        ctx.fillRect(x, yCursor, width, Math.max(1, height));
      }
    }
    ctx.restore();

    if (filters.startUs != null && filters.endUs != null) {
      const x0 = xScale(filters.startUs);
      const x1 = xScale(filters.endUs);
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
      const x = xScale(cursor);
      ctx.strokeStyle = colors.warn;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top - 4);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    for (const anchor of anchors) {
      const x = xScale(anchor.time_us);
      ctx.fillStyle = colors.risk;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top - 2);
      ctx.lineTo(x - 4, PAD.top - 10);
      ctx.lineTo(x + 4, PAD.top - 10);
      ctx.closePath();
      ctx.fill();
    }

    if (selectedEventAt != null) {
      const x = xScale(selectedEventAt);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, PAD.top - 6, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }, [
    overview,
    filteredMatrix,
    globalMatrix,
    size,
    colors,
    xScale,
    yScale,
    filters.startUs,
    filters.endUs,
    drag,
    cursor,
    anchors,
    selectedEventAt,
    granularity,
    bucketUs,
    visibleCategory,
    active,
  ]);

  const xToUs = useCallback(
    (x: number) => Math.max(rangeStart, Math.min(rangeEnd, xScale.invert(x))),
    [xScale, rangeStart, rangeEnd],
  );

  // 桶由服务端按 epoch 对齐（time_sort_us // div * div），这里必须用同一基准
  const snapBucket = useCallback((us: number) => Math.floor(us / bucketUs) * bucketUs, [bucketUs]);

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
    if (!overview) return;
    const us = xToUs(x);
    setHoverUs(snapBucket(us));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setDrag(null);
    if (Math.abs(x - drag.x0) < 3) {
      if (filters.startUs != null) setFilters({ startUs: null, endUs: null });
      return;
    }
    const left = snapBucket(xToUs(Math.min(drag.x0, x)));
    const right = Math.max(left + bucketUs, snapBucket(xToUs(Math.max(drag.x0, x))) + bucketUs);
    setFilters({ startUs: Math.max(rangeStart, left), endUs: Math.min(rangeEnd, right) });
  };

  const hovered = useMemo(() => {
    if (hoverUs == null || !overview) return null;
    const index = overview.filtered.series.buckets.indexOf(hoverUs);
    if (index === -1) return { bucket: hoverUs, count: 0, globalCount: null as number | null };
    const globalIndex = overview.global_context.series.buckets.indexOf(hoverUs);
    return {
      bucket: hoverUs,
      count: filteredMatrix?.totals[index] ?? 0,
      globalCount: globalIndex >= 0 ? (globalMatrix?.totals[globalIndex] ?? 0) : null,
    };
  }, [hoverUs, overview, filteredMatrix, globalMatrix]);

  const hasMaskedRecords =
    masking && cursor != null && overview != null
      ? overview.filtered.series.buckets.some((bucket) => bucket > cursor)
      : false;

  if (error) {
    return (
      <div className="empty-state">
        <h2>无法读取数据</h2>
        <p>{error}</p>
        <p className="muted">
          确认后端已启动且主库为 v2：<code>python -m uvicorn app.main:app --port 8000</code>
        </p>
      </div>
    );
  }

  if (!overview || !filteredMatrix) {
    return <div className="empty-state"><p className="muted">正在载入概览…</p></div>;
  }

  return (
    <div className="overview">
      <div className="overview-head">
        {!compact && (
          <div>
            <h2>系统活动概览</h2>
            <p className="muted">
              匹配 {overview.filtered.matched_events.toLocaleString()} 条
              {active && ` · 全局背景 ${overview.global_context.matched_events.toLocaleString()} 条`}
              {" · "}源时区 {overview.timezone_status === "unknown" ? "未知" : "UTC"}
              {loading && " · 更新中…"}
            </p>
            <p className="muted small">
              横轴按真实时间线性映射；没有记录的时段保留空白，不当作零活动。
              {overview.filtered.coverage.coverage_status === "partial" &&
                " 当前窗口只有部分落在数据范围内。"}
            </p>
          </div>
        )}
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
            {hovered ? (
              <>
                <span className="readout-key">{formatUtc(hovered.bucket)}</span>
                <span className="readout-val">{hovered.count.toLocaleString()} 条匹配</span>
                {hovered.globalCount != null && (
                  <span className="muted small"> · 全局 {hovered.globalCount.toLocaleString()}</span>
                )}
              </>
            ) : (
              <span className="muted">拖动选取时间窗</span>
            )}
          </div>
        </div>
      </div>

      {compact && (
        <p className="muted small overview-compact-summary">
          匹配 {overview.filtered.matched_events.toLocaleString()} 条
          {active && ` · 全局背景 ${overview.global_context.matched_events.toLocaleString()} 条`}
          {" · "}源时区 {overview.timezone_status === "unknown" ? "未知" : "UTC"}
          {loading && " · 更新中…"}
          {overview.filtered.coverage.coverage_status === "partial" && " · 当前窗口只有部分落在数据范围内"}
        </p>
      )}

      <div className="chart-wrap" ref={setWrap}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="系统活动时间分布：真实时间轴，按事件类别堆叠"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHoverUs(null)}
        />
        {hasMaskedRecords && <div className="mask-badge">回放遮蔽中：游标之后的记录不显示</div>}
        {!masking && cursor != null && <div className="mask-badge mask-off">已关闭回放遮蔽</div>}
      </div>

      <div className="legend">
        {CATEGORIES.map((c, index) => {
          const cat = overview.categories.find((item) => item.id === c.id);
          const visible = visibleCategory(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className={`legend-item${visible ? "" : " legend-off"}`}
              onClick={() =>
                setFilters({
                  categories: visible
                    ? filters.categories.length === 0
                      ? CATEGORIES.filter((x) => x.id !== c.id).map((x) => x.id)
                      : filters.categories.filter((x) => x !== c.id)
                    : [...filters.categories, c.id],
                })
              }
              aria-pressed={visible}
              title={`${c.label}：当前筛选 ${cat?.count_filtered ?? 0} 条 / 全局 ${cat?.count_global ?? 0} 条`}
            >
              <span className="swatch" style={{ background: colors.categories[index] }} />
              {c.label}
              <span className="muted small">{cat?.count_filtered ?? 0}</span>
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
                setFilters({ startUs: a.time_us - HOUR_US, endUs: a.time_us + HOUR_US });
                setCursor(a.time_us);
              }}
            >
              {a.primary && <span className="anchor-star" aria-label="演示主线">★</span>}
              {formatUtcDate(a.time_us)} · {a.label}
            </button>
          ))}
        </div>
      )}

      {/* 干预论证在 MC2 单页有独立卡片，概览里不再重复同一段说明 */}
      {!compact && info?.intervention && (
        <div className="callout intervention">
          <strong>候选干预点（待证据核验）</strong>
          <p>{info.intervention}</p>
          <p className="muted small">
            这是提交约束下的候选位置，不是已证明的唯一入口；需要目标链与历史实例的事件证据支持。
          </p>
        </div>
      )}

      {reducedMotion && <p className="muted small">已开启减少动态效果，图表仅静态重绘。</p>}
    </div>
  );
}
