import React, { useEffect, useRef, useState } from "react";
import { scaleLinear } from "d3-scale";
import { CELL, LABEL_COL, EVENT_MARKERS, sentimentLabelOf } from "../constants.js";
import { shortBucket, timeToBucket } from "../utils.js";

const labels = {
  derived: "百分比推导",
  narrative: "叙述候选价",
  reported: "消息引述",
  model_baseline: "模型基准",
  forecast: "条件预测",
  after_hours_report: "盘后消息引述",
};

const money = (v) =>
  v == null ? "未记录" : `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

const pct = (v) => (v == null ? "未记录" : `${v > 0 ? "+" : ""}${Number(v.toFixed(4))}%`);
const sentimentLabel = (value) => sentimentLabelOf(value?.toLowerCase());

const evidenceColor = (e) =>
  e.kind === "forecast"
    ? "light-dark(#92631b, var(--status-warning-text))"
    : e.kind === "model_baseline"
      ? "light-dark(#78509a, var(--tone-violet-text))"
      : "light-dark(#2469b5, var(--accent))";

function EvidenceMark({ e, x, y }) {
  const color = evidenceColor(e);
  if (e.range) {
    const top = y(e.range[1]);
    const bottom = y(e.range[0]);

    return (
      <g
        stroke={color}
        strokeWidth={2}
        fill="none"
      >
        <line
          x1={x}
          x2={x}
          y1={top}
          y2={bottom}
          strokeDasharray="4 3"
        />
        <path d={`M${x - 6} ${top}h12 M${x - 6} ${bottom}h12`} />
      </g>
    );
  }
  const cy = y(e.value);
  if (e.kind === "derived") {
    return (
      <path
        d={`M${x} ${cy - 6}l6 6-6 6-6-6Z`}
        fill="light-dark(white, var(--surface-subtle))"
        stroke={color}
        strokeWidth={2}
      />
    );
  }
  if (e.kind === "model_baseline") {
    return (
      <line
        x1={x - 8}
        x2={x + 8}
        y1={cy}
        y2={cy}
        stroke={color}
        strokeWidth={3}
      />
    );
  }

  return (
    <rect
      x={x - 5}
      y={cy - 5}
      width={10}
      height={10}
      fill="light-dark(white, var(--surface-subtle))"
      stroke={color}
      strokeWidth={2}
    />
  );
}

function Source({ source }) {
  return source ? (
    <span>
      轮次 {source.round_index} · {source.recorded_time}（
      {source.time_precision === "message" ? "消息时间" : "轮次精度"}）<br />
      <code>{source.source_pointer || "来源指针未记录"}</code>
    </span>
  ) : (
    <span>未记录来源</span>
  );
}

// Only the display domain changes. Disputed source values remain selectable at
// the range boundary, and the full scale shows every original value in place.
export function priceDomain(series, extra, mode) {
  const raw = series.filter((s) => Number.isFinite(s.stock_price));
  const ordinary = raw.filter((s) => !s.price_disputed);
  const values = (mode === "focus" && ordinary.length ? ordinary : raw).map((s) => s.stock_price);
  if (extra) {
    values.push(
      ...series
        .flatMap((s) => (s.price_evidence || []).flatMap((e) => e.range || [e.value]))
        .filter(Number.isFinite),
    );
  }
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const pad = Math.max((high - low) * 0.07, Math.abs(high) * 0.01, 0.5);

  return scaleLinear()
    .domain([low - pad, high + pad])
    .nice(4)
    .domain();
}

function trace(series, value, x, y, step = false) {
  let path = "";
  let last = null;
  series.forEach((s, i) => {
    const v = value(s);
    if (v == null) {
      last = null;

      return;
    }
    path += last == null ? `M${x(i)},${y(v)} ` : step ? `H${x(i)} V${y(v)} ` : `L${x(i)},${y(v)} `;
    last = i;
  });

  return path.trim();
}

function area(series, value, x, y, baseline, step = false) {
  let path = "";
  let run = [];

  const finish = () => {
    if (run.length > 1) {
      path += `M${x(run[0].i)},${baseline} L${x(run[0].i)},${y(run[0].v)} `;
      run.slice(1).forEach((p) => {
        path += step ? `H${x(p.i)} V${y(p.v)} ` : `L${x(p.i)},${y(p.v)} `;
      });
      path += `L${x(run.at(-1).i)},${baseline} Z `;
    }
    run = [];
  };

  series.forEach((s, i) => {
    const v = value(s);
    if (v == null) {
      finish();
    } else {
      run.push({ i, v });
    }
  });
  finish();

  return path.trim();
}

export function StockSentimentLineChart({
  data,
  granularity,
  showStock,
  showSentiment,
  scrollRef,
  onScroll,
  onReadMessage,
}) {
  const [extra, setExtra] = useState(false);
  const [scale, setScale] = useState("focus");
  const [picked, setPicked] = useState(null);
  const [hover, setHover] = useState(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const returnFocus = useRef(null);
  const panel = useRef(null);
  const buckets = data?.time_buckets || [];
  const series = data?.series || [];
  useEffect(() => {
    setPicked(null);
    setHover(null);
  }, [data, granularity]);
  const cell = CELL[granularity];
  const plotW = buckets.length * cell.w;
  const width = LABEL_COL + plotW + 55;
  const priceTop = 48;
  const priceBottom = 208;
  const sentTop = showStock ? 274 : 46;
  const sentBottom = sentTop + 100;
  const height = showSentiment ? sentBottom + 36 : showStock ? 264 : 64;
  const [pMin, pMax] = priceDomain(series, extra, scale);
  const y = scaleLinear().domain([pMin, pMax]).range([priceBottom, priceTop]);
  const x = (i) => LABEL_COL + (i + 0.5) * cell.w;
  const within = (v) => v != null && v >= pMin && v <= pMax;
  const raw = (s) => (within(s.stock_price) ? s.stock_price : null);
  const path = trace(series, raw, x, y);
  const fill = area(series, raw, x, y, priceBottom);
  const outside = series.filter((s) => s.stock_price != null && !within(s.stock_price));
  const outsideValues = [...new Set(outside.map((s) => s.stock_price))].map(money).join("、");

  const allLevels = [
    { keys: ["positive"], label: "正面" },
    { keys: ["recovering", "optimistic"], label: "回升 / 乐观" },
    { keys: ["neutral"], label: "中性" },
    { keys: ["cautious"], label: "谨慎" },
    { keys: ["low"], label: "低迷" },
    { keys: ["negative"], label: "负面" },
    { keys: ["critical"], label: "危急" },
  ];

  const levels = allLevels;

  const level = (s) => {
    const i = levels.findIndex((l) => l.keys.includes(s.market_sentiment_label?.toLowerCase()));

    return i < 0 ? null : i;
  };

  const sy = (i) =>
    sentTop + (levels.length > 1 ? i / (levels.length - 1) : 0.5) * (sentBottom - sentTop);

  const sentimentPath = trace(series, level, x, sy, true);
  const sentimentFill = area(series, level, x, sy, sentBottom, true);

  const events = EVENT_MARKERS.reduce((list, m) => {
    const i = buckets.indexOf(timeToBucket(m.time, granularity));
    if (i >= 0) {
      const existing = list.find((e) => e.i === i);
      if (existing) {
        existing.short += ` / ${m.short}`;
      } else {
        list.push({ ...m, i });
      }
    }

    return list;
  }, []);

  const selected = series.find((s) => s.time_bucket === picked);
  const hovered = series.find((s) => s.time_bucket === hover);

  const choose = (bucket, el) => {
    returnFocus.current = el;
    setPicked(bucket);
    requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
  };

  const close = () => {
    setPicked(null);
    returnFocus.current?.focus({ preventScroll: true });
  };

  const markerProps = (s, label) => ({
    role: "button",
    tabIndex: 0,
    "aria-label": `${s.time_bucket} ${label}`,
    "aria-pressed": picked === s.time_bucket,
    onClick: (e) => choose(s.time_bucket, e.currentTarget),
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose(s.time_bucket, e.currentTarget);
      }
    },
    onMouseEnter: () => setHover(s.time_bucket),
    onFocus: () => setHover(s.time_bucket),
  });

  const timeLabelWidth = granularity === "hourly" ? 106 : 40;
  const timeLabelEvery = Math.ceil((timeLabelWidth + 14) / cell.w);

  return (
    <div
      className="linechart-card market-chart"
      onKeyDown={(e) => {
        if (e.key === "Escape" && picked) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="lc-head">
        <h3>
          股价与市场情绪{" "}
          <span
            className="scope-badge"
            title="跟随时间范围；关键词、渠道等内容筛选不重新计算环境快照。"
          >
            环境记录 · 按时间显示
          </span>
        </h3>
        <div className="market-controls">
          <span>同一时间轴 · 按时间桶等距排列</span>
          <div className="market-display-controls">
            {showStock && (
              <div
                className="market-scale"
                role="group"
                aria-label="股价纵轴范围"
              >
                <button
                  aria-pressed={scale === "focus"}
                  onClick={() => setScale("focus")}
                >
                  走势放大
                </button>
                <button
                  aria-pressed={scale === "all"}
                  onClick={() => setScale("all")}
                >
                  全部原值
                </button>
              </div>
            )}
            <label>
              <input
                type="checkbox"
                checked={extra}
                onChange={(e) => setExtra(e.target.checked)}
              />
              显示推导与引述
            </label>
          </div>
        </div>
        <div className="market-legend">
          {showStock && (
            <>
              <span>
                <i className="market-line-key" />
                原始价格
              </span>
              <span>外圈：存在不同口径</span>
              <span>— 缺失</span>
            </>
          )}
          {showSentiment && (
            <span>
              <i className="market-line-key sentiment" />
              情绪类别阶梯线
            </span>
          )}
          {showStock && extra && (
            <>
              <span>◇ 百分比推导</span>
              <span>□ 文本引述</span>
              <span>━ 模型基准</span>
              <span>┬┴ 条件预测范围</span>
            </>
          )}
        </div>
        {showStock && (
          <p
            className="market-scale-note"
            data-testid="market-scale-note"
          >
            {scale === "focus"
              ? `当前纵轴 ${money(pMin)}～${money(pMax)}。${outside.length ? `${outside.length} 条不同口径原值（${outsideValues}）以边界箭头标出；可切换“全部原值”查看实际高度。` : "所有原始价格均在当前范围内。"}`
              : "完整纵轴包含全部原始价格；不同口径值保留外圈。"}
          </p>
        )}
      </div>
      <div className="market-plot-frame">
        <div
          className="lc-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            setScrollLeft(e.currentTarget.scrollLeft);
            onScroll?.(e);
          }}
        >
          <svg
            width={width}
            height={height}
            className="lc-svg market-svg"
            aria-label="股价走势与市场情绪阶梯线"
            role="group"
            onMouseLeave={() => setHover(null)}
          >
            {showStock && (
              <>
                <rect
                  x={LABEL_COL}
                  y={priceTop}
                  width={plotW}
                  height={priceBottom - priceTop}
                  fill="light-dark(#f7fbfc, var(--surface-subtle))"
                />
                {y.ticks(4).map((v) => (
                  <line
                    key={v}
                    x1={LABEL_COL}
                    x2={LABEL_COL + plotW}
                    y1={y(v)}
                    y2={y(v)}
                    stroke="light-dark(#dce7ec, var(--border-default))"
                  />
                ))}
                <path
                  d={fill}
                  fill="light-dark(#14778a, var(--chart-market-price))"
                  fillOpacity=".09"
                />
                <path
                  data-testid="raw-stock-path"
                  d={path}
                  fill="none"
                  stroke="light-dark(#14778a, var(--chart-market-price))"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                />
              </>
            )}
            {showSentiment && (
              <>
                <rect
                  x={LABEL_COL}
                  y={sentTop - 10}
                  width={plotW}
                  height={sentBottom - sentTop + 20}
                  fill="light-dark(#fffcf6, var(--status-warning-surface))"
                />
                {levels.map((l, i) => (
                  <line
                    key={l.label}
                    x1={LABEL_COL}
                    x2={LABEL_COL + plotW}
                    y1={sy(i)}
                    y2={sy(i)}
                    stroke="light-dark(#ece5d8, var(--border-default))"
                    strokeDasharray="3 4"
                  />
                ))}
                <path
                  d={sentimentFill}
                  fill="light-dark(#ad761c, var(--chart-market-sentiment))"
                  fillOpacity=".10"
                />
                <path
                  data-testid="market-sentiment-path"
                  d={sentimentPath}
                  fill="none"
                  stroke="light-dark(#98621a, var(--chart-market-sentiment))"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                />
              </>
            )}
            {events.map((e) => (
              <g
                key={e.id}
                data-testid="market-event-marker"
              >
                <line
                  x1={x(e.i)}
                  x2={x(e.i)}
                  y1={showStock ? priceTop : sentTop}
                  y2={showSentiment ? sentBottom : priceBottom}
                  stroke="light-dark(#b56843, var(--text-market-event))"
                  strokeDasharray="4 4"
                />
                <text
                  x={x(e.i)}
                  y={showStock ? 18 : 20}
                  textAnchor="middle"
                >
                  {e.short}
                </text>
              </g>
            ))}
            {series.map((s, i) => (
              <g key={s.time_bucket}>
                <g
                  {...markerProps(s, "查看该桶记录与来源")}
                  data-market-bucket={s.time_bucket}
                >
                  <title>
                    {s.time_bucket} · 原始价格 {money(s.stock_price)} · 市场情绪{" "}
                    {sentimentLabel(s.market_sentiment_label) || "未记录"}
                  </title>
                  <rect
                    x={LABEL_COL + i * cell.w}
                    y={26}
                    width={cell.w}
                    height={height - 56}
                    fill={
                      picked === s.time_bucket
                        ? "light-dark(#2469b514, var(--surface-selection))"
                        : hover === s.time_bucket
                          ? "light-dark(#2469b509, var(--surface-hover))"
                          : "transparent"
                    }
                  />
                  {showStock &&
                    s.stock_price != null &&
                    (within(s.stock_price) ? (
                      <>
                        <circle
                          cx={x(i)}
                          cy={y(s.stock_price)}
                          r={13}
                          fill="transparent"
                        />
                        <circle
                          data-raw-price={s.stock_price}
                          cx={x(i)}
                          cy={y(s.stock_price)}
                          r={hover === s.time_bucket ? 5 : 3.5}
                          fill="light-dark(#14778a, var(--chart-market-price))"
                        />
                        {s.price_disputed && (
                          <circle
                            cx={x(i)}
                            cy={y(s.stock_price)}
                            r={8}
                            fill="none"
                            stroke="light-dark(#92631b, var(--status-warning-text))"
                            strokeWidth={2}
                          />
                        )}
                      </>
                    ) : (
                      <g
                        data-outside-price={s.stock_price}
                        transform={`translate(${x(i)} ${s.stock_price > pMax ? priceTop - 15 : priceBottom + 19})`}
                      >
                        <rect
                          x={-23}
                          y={-10}
                          width={46}
                          height={20}
                          rx={4}
                          fill="light-dark(#fff6e6, var(--status-warning-surface))"
                          stroke="light-dark(#ab782c, var(--status-warning-border))"
                        />
                        <text
                          y={4}
                          textAnchor="middle"
                        >
                          {s.stock_price > pMax ? "↑" : "↓"}
                          {money(s.stock_price)}
                        </text>
                      </g>
                    ))}
                  {showStock && s.stock_price == null && (
                    <text
                      data-missing-price
                      x={x(i)}
                      y={priceBottom + 23}
                      textAnchor="middle"
                    >
                      —
                    </text>
                  )}
                  {showSentiment && level(s) != null && (
                    <circle
                      cx={x(i)}
                      cy={sy(level(s))}
                      r={hover === s.time_bucket ? 5 : 3.5}
                      fill="light-dark(#98621a, var(--chart-market-sentiment))"
                    />
                  )}
                </g>
                {showStock &&
                  extra &&
                  (s.price_evidence || []).map((e, j) => (
                    <g
                      key={`${e.source_pointer}:${j}`}
                      data-evidence-kind={e.kind}
                      {...markerProps(
                        s,
                        `${labels[e.kind]} ${e.range ? e.range.join("～") : e.value}`,
                      )}
                    >
                      <title>
                        {labels[e.kind]} · {e.recorded_time} ·{" "}
                        {e.range ? e.range.join("～") : e.value} · 位置代表证据所属时间桶
                      </title>
                      {e.range && (
                        <rect
                          x={x(i) - 12}
                          y={y(e.range[1])}
                          width={24}
                          height={y(e.range[0]) - y(e.range[1])}
                          fill="light-dark(#b07a22, var(--status-warning-text))"
                          fillOpacity=".12"
                        />
                      )}
                      <circle
                        cx={x(i)}
                        cy={y(e.range ? (e.range[0] + e.range[1]) / 2 : e.value)}
                        r={13}
                        fill="transparent"
                      />
                      <EvidenceMark
                        e={e}
                        x={x(i)}
                        y={y}
                      />
                    </g>
                  ))}
                {i % timeLabelEvery === 0 &&
                  (i === 0
                    ? scrollLeft === 0
                    : x(i) - scrollLeft >= LABEL_COL + timeLabelWidth / 2) && (
                    <text
                      data-market-time-label
                      x={i === 0 ? LABEL_COL + 6 : x(i)}
                      y={height - 8}
                      textAnchor={i === 0 ? "start" : "middle"}
                    >
                      {shortBucket(s.time_bucket, granularity)}
                    </text>
                  )}
              </g>
            ))}
            {!showStock && !showSentiment && (
              <text
                x={LABEL_COL}
                y={25}
              >
                请选择股价或情绪轨道
              </text>
            )}
          </svg>
        </div>
        <svg
          className="market-fixed-axis"
          width="100%"
          height={height}
          aria-label="固定纵轴"
        >
          <rect
            width={LABEL_COL}
            height={height}
            fill="light-dark(white, var(--surface-subtle))"
          />
          {showStock && (
            <>
              <text
                x={16}
                y={20}
                className="market-axis-title"
              >
                股价（美元）
              </text>
              {y.ticks(4).map((v) => (
                <g key={v}>
                  <text
                    data-price-tick={v}
                    x={LABEL_COL - 16}
                    y={y(v) + 4}
                    textAnchor="end"
                  >
                    {money(v)}
                  </text>
                  <line
                    x1={LABEL_COL - 8}
                    x2={LABEL_COL}
                    y1={y(v)}
                    y2={y(v)}
                    stroke="light-dark(#9bb5c1, var(--border-control-strong))"
                  />
                </g>
              ))}
            </>
          )}
          {showSentiment && (
            <>
              <text
                x={16}
                y={sentTop - 22}
                className="market-axis-title"
              >
                市场情绪
              </text>
              <text
                x={LABEL_COL + 8}
                y={sentTop - 22}
              >
                类别等距排列 · 连线仅表示状态变化
              </text>
              {levels.map((l, i) => (
                <text
                  key={l.label}
                  x={LABEL_COL - 16}
                  y={sy(i) + 4}
                  textAnchor="end"
                >
                  {l.label}
                </text>
              ))}
            </>
          )}
          <line
            x1={LABEL_COL - 0.5}
            x2={LABEL_COL - 0.5}
            y1={26}
            y2={height - 27}
            stroke="light-dark(#d5e0ea, var(--border-details))"
          />
        </svg>
      </div>
      <div
        className="market-hover"
        aria-live="polite"
      >
        {hovered
          ? `${hovered.time_bucket} · 原始价格 ${money(hovered.stock_price)} · ${sentimentLabel(hovered.market_sentiment_label) || "情绪未记录"}${hovered.price_disputed ? " · 存在不同口径" : ""}`
          : "选择时间桶查看原值、来源与含义；缺失保留断点，预测不作为观测。"}
      </div>
      {selected && (
        <section
          className="market-details"
          ref={panel}
          tabIndex={-1}
          aria-label="市场记录来源详情"
        >
          <div className="market-detail-head">
            <h4>
              {selected.time_bucket} · {granularity === "daily" ? "日桶" : "小时桶"}
            </h4>
            <button onClick={close}>关闭详情</button>
          </div>
          <div className="market-detail-grid">
            <div>
              <b>原始价格快照：{money(selected.stock_price)}</b>
              {selected.price_disputed && <p>存在不同口径，尚未裁定真值。</p>}
              <p>
                原字段：{selected.raw_stock_price ?? "null"}
                <br />
                <Source source={selected.price_source} />
              </p>
            </div>
            <div>
              <b>环境情绪：{sentimentLabel(selected.market_sentiment_label) || "未记录"}</b>
              <p>
                类别映射值：{selected.market_sentiment_value ?? "未记录"}
                ，不代表连续测量或消息情绪均值。
                <br />
                <Source source={selected.sentiment_source} />
              </p>
            </div>
          </div>
          <div className="market-changes">
            <p>
              原文报告涨跌幅：<b>{pct(selected.reported_percent_change)}</b>
              （属于该来源快照，不自动解释为日收益）
              <br />
              <Source source={selected.reported_change_source} />
            </p>
            <p>
              相邻原始快照的记录值变化：
              <b>
                {selected.computed_change?.value == null
                  ? `不计算：${selected.computed_change?.reason || "缺失"}`
                  : pct(selected.computed_change.value)}
              </b>
              {selected.computed_change?.value != null && (
                <>
                  {" "}
                  · 基准 {money(selected.computed_change.basis.value)} /{" "}
                  {selected.computed_change.basis.time_bucket}
                  <br />
                  公式：（{money(selected.stock_price)} −{" "}
                  {money(selected.computed_change.basis.value)}）÷ |
                  {money(selected.computed_change.basis.value)}| × 100%
                  <br />
                  <Source source={selected.computed_change.basis.source} />
                </>
              )}
            </p>
          </div>
          {(selected.price_evidence || []).length > 0 && (
            <details open={extra}>
              <summary>附加来源 · {selected.price_evidence.length} 项（不替换原值）</summary>
              {selected.price_evidence.map((e, i) => (
                <article key={i}>
                  <b>
                    {labels[e.kind]}：
                    {e.range ? `${money(e.range[0])}～${money(e.range[1])}` : money(e.value)}
                  </b>
                  <p>
                    <Source source={e} />
                    {e.claimed_time && (
                      <>
                        <br />
                        文本声称时间：{e.claimed_time}
                      </>
                    )}
                    {e.time_conflict && (
                      <>
                        <br />
                        {e.time_conflict}
                      </>
                    )}
                  </p>
                  {e.condition && <p>前提与替代情景：{e.condition}</p>}
                  {e.assumptions?.map((a) => (
                    <p key={a}>{a}</p>
                  ))}
                  {e.basis && (
                    <p>
                      推导基准 {money(e.basis.value)} · {e.basis.recorded_time} ·{" "}
                      {e.basis.kind === "derived" ? "推导值" : "原始快照"}
                      <br />
                      <code>{e.basis.source_pointer}</code>
                      {e.basis.basis && (
                        <>
                          <br />
                          上游基准 {money(e.basis.basis.value)} · {e.basis.basis.recorded_time}
                        </>
                      )}
                      <br />
                      报告 {pct(e.reported_percent_change)}；计算 {money(e.basis.value)} × (1 +{" "}
                      {e.reported_percent_change}/100)
                    </p>
                  )}
                  {e.text && <blockquote>{e.text}</blockquote>}
                  {e.message_id && onReadMessage && (
                    <button onClick={() => onReadMessage(e.message_id)}>
                      阅读依据消息 · {e.message_id}
                    </button>
                  )}
                </article>
              ))}
            </details>
          )}
        </section>
      )}
    </div>
  );
}
