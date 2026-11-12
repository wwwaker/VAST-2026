// Stock Price / BERT Sentiment Line Chart

import React, { useState } from 'react';
import { CELL, LABEL_COL, EVENT_MARKERS, sentimentLabelOf } from '../constants.js';
import { shortBucket, pctClass, fmtPct, fmtSigned, timeToBucket } from '../utils.js';

//   substring(r.hour,0,13) + ':00:00'

const PRICE_CORRECTIONS = {

  '2046-06-05T09:00:00': {
    price: 28.98,

    reason:
      '原始 stock_price 缺失（null）。依据 percent_change 字段的 -8% 反推：'
      + '$31.50 × (1 - 0.08) = $28.98（$31.50 为 6 月 4 日 09:00 最后一次确认的收盘价）。',
  },

  '2046-06-05T10:00:00': {
    price: 25.5024,

    reason:
      '原始 stock_price 缺失（null）。依据 percent_change 字段的 -12% 反推：'
      + '$28.98 × (1 - 0.12) = $25.5024（基于已修正的 9:00 价格）。',
  },

  '2046-06-05T11:00:00': {
    price: 27.80,

    reason:
      '原始值为“$180”——这是 1.8 亿美元收购估值串到了价格字段。'
      + '事件叙述明确写着“$27.80，下跌 4.2%”，percent_change 字段也独立印证了 -4.2%。'
      + '$27.80 与前后价格也吻合（10:00 的 $25.50 → 12:00 的 $27.20），'
      + '而 $180 相当于不可能出现的 6 倍暴涨。叙述标注的时间是“上午 10 点”，但这个标签本身也标错了'
      + '（它实际指向一条 10:30 的评论请求）。综合叙述内容以及与其他消息的一致性，判定 $27.80 为正确价格。',
  },

  '2046-06-05T14:00:00': {
    price: 26.40,

    reason:
      '原始值为 $18.0，与内部数据不符。消息 20460605_18_005 直接给出了确切数字——'
      + '“股价 $26.40，MAC 滚动均值 $27.10”——因此该小时采用 $26.40。',
  },

  '2046-06-05T15:00:00': {
    price: 25.80,

    reason:
      '原始值为 $18.0，没有反映更新后的模型。消息 20460605_19_030 明确说明模型已按“$25.80 基准”重建，'
      + '因此该小时的修正价格采用 $25.80。',
  },

  '2046-06-05T16:00:00': {
    price: 35.5,

    reason:
      '原始 stock_price 缺失（null）。消息 20460605_20_019 预测：若 TenantThread 在 4:30 获得 CivicLoom 同意后自行公布，'
      + '盘后价格将重新定价至 $33–$38。由于公布确实发生，取该区间中值作为估计：($33 + $38) / 2 = $35.5。',
  },

  '2046-06-05T17:00:00': {
    price: 35,

    reason:
      '原始 stock_price 缺失（null）。消息 20460605_21_003 给出两种情形——约 5:15 自行公布，或推迟到 6:00。'
      + '实际公布发生在 5:19–5:27，因此以“公布情形”的预测（$33–$37）为参照取中值：'
      + '($33 + $37) / 2 = $35。',
  },

  '2046-06-05T18:00:00': {
    price: 33.05,

    reason:
      '原始 stock_price 缺失（null）。当日最终总结（消息 20460605_22_056）给出的盘后 $TTHR 为'
      + '“中值 $33.05，较 $31.20 开盘上涨 5.9%”，因此该小时采用 $33.05。',
  },
};

export function StockSentimentLineChart({
  data, granularity, showStock, showSentiment, scrollRef, onScroll,
}) {
  const [hover, setHover] = useState(null);

  const [picked, setPicked] = useState(null); // index | null

  const buckets = data?.time_buckets || [];
  const rawSeries = data?.series || [];

  const series = React.useMemo(() => {
    const s = rawSeries.map((row) => {
      const corr = PRICE_CORRECTIONS[row.time_bucket];
      return corr
        ? { ...row, stock_price: corr.price, correction_reason: corr.reason }
        : { ...row, correction_reason: null };
    });

    let prev = null;
    for (const row of s) {
      if (row.stock_price != null) {
        row.stock_price_change_pct =
          prev != null && prev !== 0
            ? Math.round(((row.stock_price - prev) / Math.abs(prev)) * 10000) / 100
            : null;
        prev = row.stock_price;
      }
    }
    return s;
  }, [rawSeries]);

  const cell = CELL[granularity];
  const plotW = buckets.length * cell.w;

  const RIGHT_PAD = 48;
  const height = 200;
  const padTop = 16, padBottom = 28;
  const innerH = height - padTop - padBottom;

  const xAt = (i) => LABEL_COL + i * cell.w + cell.w / 2;

  const PRICE_AXIS_MAX = 38.70;
  const PRICE_AXIS_MIN = 18.00;

  const prices = series.map(s => s.stock_price).filter(v => v !== null && v !== undefined);
  const pMax = PRICE_AXIS_MAX;
  const pMin = PRICE_AXIS_MIN;
  const yPrice = (v) => padTop + innerH - ((v - pMin) / (pMax - pMin)) * innerH;

  const ySent = (v) => padTop + innerH - ((v + 1) / 2) * innerH;

  function buildPath(accessor, yFn) {
    let d = '';
    let pen = false;
    series.forEach((s, i) => {
      const v = accessor(s);
      if (v === null || v === undefined) { pen = false; return; }
      const cmd = pen ? 'L' : 'M';
      d += `${cmd}${xAt(i)},${yFn(v)} `;
      pen = true;
    });
    return d.trim();
  }

  const stockPath = buildPath(s => s.stock_price, yPrice);
  const sentPath = buildPath(s => s.market_sentiment_value, ySent);

  const nothing = !showStock && !showSentiment;

  const CORRECTED_COLOR = '#3b82f6';

  const pickedRow = picked !== null ? series[picked] : null;

  return (
    <div className="linechart-card">
      <div className="lc-head">
        <h3>股价与市场情绪</h3>
        <div className="lc-legend">
          <span className="lc-key"><span className="lc-swatch" style={{ background: '#148a9c' }} /> 股价（美元）</span>
          <span className="lc-key"><span className="lc-swatch" style={{ background: '#f59e0b' }} /> 市场情绪（−1…+1）</span>
          <span className="lc-key"><span className="lc-swatch" style={{ background: CORRECTED_COLOR }} /> 修正 / 估计值（点击查看依据）</span>
        </div>
        <span className="muted small">环境快照 + 参考工程人工修正；含预测区间中值估计，点击蓝点查看依据 · 非全部为实测股价</span>
      </div>
      <div className="lc-scroll" ref={scrollRef} onScroll={onScroll}>
        <svg width={LABEL_COL + plotW + RIGHT_PAD} height={height} className="lc-svg"
          onMouseLeave={() => setHover(null)}>
          {/* baseline */}
          <line x1={LABEL_COL} y1={padTop + innerH} x2={LABEL_COL + plotW} y2={padTop + innerH}
            stroke="#263244" strokeWidth="1" />
          {/* sentiment 0 line */}
          {showSentiment && (
            <line x1={LABEL_COL} y1={ySent(0)} x2={LABEL_COL + plotW} y2={ySent(0)}
              stroke="#33405580" strokeDasharray="3 3" strokeWidth="1" />
          )}

          {/* y-axis labels: left = stock price (cyan), right = sentiment scale (amber) */}
          {showStock && prices.length > 0 && (
            <g>
              <text x={LABEL_COL - 6} y={yPrice(pMax) + 3} textAnchor="end" fontSize="9" fill="#22d3ee">${pMax.toFixed(2)}</text>
              <text x={LABEL_COL - 6} y={yPrice(pMin) + 3} textAnchor="end" fontSize="9" fill="#22d3ee">${pMin.toFixed(2)}</text>
            </g>
          )}
          {showSentiment && (
            <g>
              <text x={LABEL_COL + plotW + 2} y={ySent(1) + 3} fontSize="9" fill="#f59e0b">+1 正面</text>
              <text x={LABEL_COL + plotW + 2} y={ySent(0) + 3} fontSize="9" fill="#f59e0b">0 中性</text>
              <text x={LABEL_COL + plotW + 2} y={ySent(-1) + 3} fontSize="9" fill="#f59e0b">-1 危急</text>
            </g>
          )}

          {/* olay işaretleri (leak / embargo): dikey kesikli çizgi + etiket */}
          {EVENT_MARKERS.map((mk, mi) => {
            const i = buckets.indexOf(timeToBucket(mk.time, granularity));
            if (i < 0) return null;
            return (
              <g key={mk.id}>
                <line x1={xAt(i)} y1={padTop - 4} x2={xAt(i)} y2={padTop + innerH}
                  stroke={mk.color} strokeDasharray="4 3" strokeWidth="1.5" />
                <text x={xAt(i) + 4} y={padTop + 7 + mi * 11} fontSize="9"
                  fill={mk.color} fontWeight="700">{mk.short}</text>
              </g>
            );
          })}

          {/* hover guide + column hit areas */}
          {buckets.map((b, i) => (
            <rect key={b} x={LABEL_COL + i * cell.w} y={padTop} width={cell.w} height={innerH}
              fill={hover === i ? 'rgba(96,165,250,0.08)' : 'transparent'}
              onMouseEnter={() => setHover(i)} />
          ))}

          {nothing && (
            <text x={LABEL_COL + plotW / 2} y={height / 2} textAnchor="middle"
              fill="#5a7a9a" fontSize="13">未选择任何曲线</text>
          )}

          {/* lines */}
          {showStock && stockPath && (
            <path d={stockPath} fill="none" stroke="#22d3ee" strokeWidth="2" />
          )}
          {showSentiment && sentPath && (
            <path d={sentPath} fill="none" stroke="#f59e0b" strokeWidth="2" />
          )}

          {showStock && series.map((s, i) => {
            if (s.stock_price == null) return null;
            const corrected = !!s.correction_reason;
            const isPicked = picked === i;
            return (
              <g key={`p${i}`}>
                {corrected && (
                  <circle
                    cx={xAt(i)} cy={yPrice(s.stock_price)} r={12}
                    fill="transparent" style={{ cursor: 'pointer' }}
                    onClick={() => setPicked(isPicked ? null : i)}
                  />
                )}
                {corrected && (
                  <circle
                    cx={xAt(i)} cy={yPrice(s.stock_price)} r={isPicked ? 7 : 5.5}
                    fill="none" stroke={CORRECTED_COLOR} strokeWidth={isPicked ? 2.5 : 1.5}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setPicked(isPicked ? null : i)}
                  />
                )}
                <circle
                  cx={xAt(i)} cy={yPrice(s.stock_price)}
                  r={corrected ? 3 : (hover === i ? 4 : 2.5)}
                  fill={corrected ? CORRECTED_COLOR : '#148a9c'}
                  style={corrected ? { cursor: 'pointer' } : undefined}
                  onClick={corrected ? () => setPicked(isPicked ? null : i) : undefined}
                />
              </g>
            );
          })}
          {/* points (sentiment) */}
          {showSentiment && series.map((s, i) => s.market_sentiment_value != null && (
            <circle key={`s${i}`} cx={xAt(i)} cy={ySent(s.market_sentiment_value)} r={hover === i ? 4 : 2.5}
              fill="#f59e0b" />
          ))}

          {/* x labels */}
          {buckets.map((b, i) => (
            <text key={`x${b}`} x={xAt(i)} y={height - 8} textAnchor="middle"
              fontSize="9" fill="#7a8aa0" fontFamily="monospace">
              {shortBucket(b, granularity)}
            </text>
          ))}
        </svg>
      </div>

      {pickedRow && pickedRow.correction_reason && (
        <div
          className="lc-correction-note"
          style={{
            margin: '6px 0 2px', padding: '8px 10px',
            border: `1px solid ${CORRECTED_COLOR}`,
            borderRadius: 6, background: 'rgba(59,130,246,0.10)',
            fontSize: 12, lineHeight: 1.5,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <b style={{ color: CORRECTED_COLOR }}>
              已修正 · {pickedRow.time_bucket} → ${parseFloat(pickedRow.stock_price.toFixed(4))}
            </b>
            <span
              style={{ cursor: 'pointer', color: '#7a8aa0' }}
              onClick={() => setPicked(null)}
            >✕</span>
          </div>
          <div style={{ marginTop: 4, color: '#38516b' }}>{pickedRow.correction_reason}</div>
        </div>
      )}

      {/* tooltip-like summary */}
      <div className="lc-summary">
        {hover === null && !pickedRow && <span className="muted small">将鼠标悬停在任意列上，即可查看该时间桶的股价与市场情绪。点击高亮的圆点可查看该数值被修正的原因。</span>}
        {hover !== null && series[hover] && (
          <div className="lc-readout">
            <b>{series[hover].time_bucket}</b>
            {showStock && (
              <span>股价：<b>{series[hover].stock_price != null ? `$${series[hover].stock_price.toFixed(2)}` : '—'}</b>
                {' '}（<span className={pctClass(series[hover].stock_price_change_pct)}>
                  {fmtPct(series[hover].stock_price_change_pct)}</span>）
                {series[hover].correction_reason ? <span style={{ color: CORRECTED_COLOR }}> · 已修正</span> : ''}</span>
            )}
            {showSentiment && (
              <span>市场情绪：<b>{sentimentLabelOf(series[hover].market_sentiment_label) || '—'}</b>
                {series[hover].market_sentiment_value != null
                  ? ` (${fmtSigned(series[hover].market_sentiment_value)})`
                  : ''}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
