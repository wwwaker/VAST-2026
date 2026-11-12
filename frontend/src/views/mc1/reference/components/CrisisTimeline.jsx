
import React, { useEffect } from 'react';
import { Play, Pause } from 'lucide-react';
import { fmtRoundLabel } from '../utils.js';
import { EVENT_MARKERS } from '../constants.js';

export function CrisisTimeline({ timeline, idx, setIdx, startIdx = 0, setStartIdx, playing, onTogglePlay, granularity, setGranularity }) {
  const total = timeline ? timeline.length : 0;

  // ---- Klavye kısayolları ----
  //   ← / →            : bitiş round'unu geri/ileri al
  //   Shift + ← / →    : başlangıç round'unu geri/ileri al
  //   Space            : Play / Pause
  // Bir input/textarea/select odaktayken (ör. keyword arama) devreye girmez.
  useEffect(() => {
    if (!total) return;
    const onKeyDown = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.composedPath()[0];
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      if (t?.closest?.('button,a,summary,[role="button"],[role="dialog"]')) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) setStartIdx && setStartIdx(s => Math.min(s + 1, idx));
        else setIdx(i => Math.min(i + 1, total - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) setStartIdx && setStartIdx(s => Math.max(s - 1, 0));
        else setIdx(i => Math.max(i - 1, startIdx));
      } else if (e.key === ' ') {
        e.preventDefault(); // sayfanın scroll olmasını engelle
        onTogglePlay && onTogglePlay();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [total, idx, startIdx, setIdx, setStartIdx, onTogglePlay]);

  if (!timeline || timeline.length === 0) return null;
  const cur = timeline[idx] || {};
  const startCur = timeline[startIdx] || {};
  const maxTotal = Math.max(1, ...timeline.map(r => r.total_msgs || 0));

  const maxMergRatio = Math.max(0.0001, ...timeline.map(r => (r.total_msgs ? (r.merger_msgs || 0) / r.total_msgs : 0)));
  const n = timeline.length;
  const denom = Math.max(1, n - 1);

  const onStart = (v) => { setStartIdx && setStartIdx(Math.min(Number(v), idx)); };
  const onEnd = (v) => { setIdx(Math.max(Number(v), startIdx)); };

  // Olay işaretlerini (leak / embargo) round index'ine çevir:
  // önce saat bazında tam eşleşme ara, yoksa marker'dan önceki son round'a düşür.
  const markers = EVENT_MARKERS.map(mk => {
    let mIdx = null;
    for (let i = 0; i < n; i++) {
      const h = timeline[i].hour || '';
      if (h.slice(0, 13) === mk.time.slice(0, 13)) { mIdx = i; break; }
      if (h <= mk.time) mIdx = i;
    }
    return { ...mk, idx: mIdx };
  });

  const fillLeft = (startIdx / denom) * 100;
  const fillWidth = ((idx - startIdx) / denom) * 100;

  return (
    <section className="timeline-bar">
      <div className="tl-row">
        <button className={`tl-play ${playing ? 'playing' : ''}`} onClick={onTogglePlay} title={playing ? '暂停' : '播放危机（从起始手柄开始逐步扩展窗口）'}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
          {playing ? '暂停' : '播放'}
        </button>

        <div className="tl-slider-wrap">
          {/* olay işaretleri (leak / embargo): tick + track üzerinde dikey çizgi */}
          {markers.map(mk => mk.idx != null && (
            <div key={mk.id} className="tl-event-marker"
              style={{ left: `${(mk.idx / denom) * 100}%`, background: mk.color }}
              title={mk.label} />
          ))}
          <div className="tl-ticks">
            {timeline.map((r, i) => {
              const inRange = i >= startIdx && i <= idx;
              const h = 3 + 9 * Math.sqrt((r.total_msgs || 0) / maxTotal);
              const merg = (r.total_msgs ? (r.merger_msgs || 0) / r.total_msgs : 0);

              const t = Math.pow(Math.min(1, merg / maxMergRatio), 0.7);
              const cr = Math.round(255 + (0x8b - 255) * t);
              const cg = Math.round(255 + (0x00 - 255) * t);
              const cb = Math.round(255 + (0x00 - 255) * t);
              const bg = `rgb(${cr},${cg},${cb})`;
              return (
                <button key={i}
                  className={`tl-tick ${i === idx ? 'current' : ''} ${i === startIdx ? 'start' : ''} ${inRange ? 'in-range' : ''}`}
                  style={{ height: `${h}px`, background: inRange ? bg : '#1b2a3f' }}
                  title={`第 ${i + 1}/${n} 轮 · ${fmtRoundLabel(r.hour)} · ${r.total_msgs} 条消息，${r.merger_msgs} 条含合并关键词`}
                  onClick={() => onEnd(i)} />
              );
            })}
          </div>
          <div className="tl-range-multi">
            <div className="tl-track" />
            <div className="tl-track-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }} />
            <input className="tl-range tl-range-start" type="range" min={0} max={n - 1} step={1}
              value={startIdx} onChange={e => onStart(e.target.value)}
              aria-label="窗口起点" />
            <input className="tl-range tl-range-end" type="range" min={0} max={n - 1} step={1}
              value={idx} onChange={e => onEnd(e.target.value)}
              aria-label="窗口终点" />
          </div>
        </div>

        {setGranularity && (
          <label className="tl-scale" title="热力图 / 折线图横轴的时间粒度">
            粒度
            <select value={granularity} onChange={e => setGranularity(e.target.value)}>
              <option value="daily">按日</option>
              <option value="hourly">按小时</option>
            </select>
          </label>
        )}
      </div>

      <div className="tl-meta">
        <span className="tl-round">轮次 {startIdx + 1}–{idx + 1} / {n}</span>
        <span className="tl-date">{fmtRoundLabel(startCur.hour)} → {fmtRoundLabel(cur.hour)}</span>
        <span className="tl-merger">{cur.merger_msgs || 0} 条含合并关键词 · {cur.total_msgs || 0} 条消息（结束轮次）</span>
        {markers.filter(mk => mk.idx != null).map(mk => (
          <span key={mk.id} className="tl-event-key" style={{ color: mk.color }} title={mk.label}>
            ▍{mk.short} {mk.time.slice(11, 16)}
          </span>
        ))}
      </div>
    </section>
  );
}
