
import React, { useMemo, useState } from 'react';
import { CELL, LABEL_COL, SEQ_EVENTS, SEQ_EDGES, SEQ_KINDS, agentLabelOf } from '../constants.js';
import { timeToBucket, shortBucket } from '../utils.js';
import { MessageList } from './messagePanels.jsx';

import { AgentIcon } from '../agentIcons.jsx';

function trianglePoints(cx, cy, r) {
  return [-90, 150, 30].map(deg => {
    const rad = (deg * Math.PI) / 180;
    return `${cx + r * Math.cos(rad)},${cy + r * Math.sin(rad)}`;
  }).join(' ');
}

function KindIcon({ kind, size = 12 }) {
  const c = size / 2;
  const r = size * 0.42;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ verticalAlign: -1, flexShrink: 0 }}>
      {kind.shape === 'circle' && <circle cx={c} cy={c} r={r} fill={kind.color} />}
      {kind.shape === 'triangle' && <polygon points={trianglePoints(c, c, r * 1.15)} fill={kind.color} />}
      {kind.shape === 'cross' && (
        <g stroke={kind.color} strokeWidth={Math.max(2, size * 0.22)} strokeLinecap="round">
          <line x1={c - r * 0.75} y1={c - r * 0.75} x2={c + r * 0.75} y2={c + r * 0.75} />
          <line x1={c - r * 0.75} y1={c + r * 0.75} x2={c + r * 0.75} y2={c - r * 0.75} />
        </g>
      )}
    </svg>
  );
}

export function SequentialFlow({
  granularity, buckets, scrollRef, onScroll,
  selectedEventId, onSelectEvent,
  eventMessages, eventMessagesStatus, selectedMessageId, onSelectMessage,
}) {
  const cell = CELL[granularity];
  const cols = buckets?.length || 0;
  const plotW = cols * cell.w;
  const xAt = (i) => LABEL_COL + i * cell.w + cell.w / 2;

  const [hoveredId, setHoveredId] = useState(null);

  const [hiddenKinds, setHiddenKinds] = useState(() => new Set());

  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState(() => new Set());

  const [alwaysShowLabels, setAlwaysShowLabels] = useState(false);

  const toggleKind = (k) => setHiddenKinds(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const toggleEdgeType = (t) => setHiddenEdgeTypes(prev => {
    const next = new Set(prev);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });

  const R = 9;

  const placed = useMemo(() => {
    const arr = [];
    for (const ev of SEQ_EVENTS) {
      if (hiddenKinds.has(ev.kind)) continue;
      const bi = (buckets || []).indexOf(timeToBucket(ev.time, granularity));
      if (bi < 0) continue;
      const x = xAt(bi);
      const w = alwaysShowLabels
        ? Math.max(2 * R + 6, ev.title.length * 6.2 + 14)
        : 2 * R + 6;
      arr.push({ ...ev, bi, x, left: x - w / 2, right: x + w / 2, stack: 0 });
    }
    arr.sort((a, b) => a.left - b.left || a.bi - b.bi);
    const laneRight = [];
    for (const p of arr) {
      let lane = 0;
      for (; lane < laneRight.length; lane++) {
        if (laneRight[lane] <= p.left - 4) break;
      }
      p.stack = lane;
      laneRight[lane] = p.right;
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, granularity, hiddenKinds, alwaysShowLabels]);

  const posById = useMemo(() => {
    const m = new Map();
    placed.forEach(p => m.set(p.id, p));
    return m;
  }, [placed]);

  const arcs = useMemo(() => {
    const es = [];
    for (const e of SEQ_EDGES) {
      if (hiddenEdgeTypes.has(e.type)) continue;
      const a = posById.get(e.from), b = posById.get(e.to);
      if (!a || !b) continue;
      es.push({ ...e, a, b, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x) });
    }
    es.sort((p, q) => p.x1 - q.x1);
    const tierEnd = [];
    for (const arc of es) {
      let t = 0;
      for (; t < tierEnd.length; t++) if (tierEnd[t] <= arc.x1 - 4) break;
      arc.tier = t;
      tierEnd[t] = arc.x2;
    }

    const inBy = new Map();
    const outBy = new Map();
    for (const arc of es) {
      if (!outBy.has(arc.from)) outBy.set(arc.from, []);
      outBy.get(arc.from).push(arc);
      if (!inBy.has(arc.to)) inBy.set(arc.to, []);
      inBy.get(arc.to).push(arc);
    }
    const SPREAD = 3.6;
    const fan = (list, key) => {

      list.sort((p, q) => (key === 'in' ? p.a.x - q.a.x : p.b.x - q.b.x));
      const n = list.length;
      list.forEach((arc, i) => {
        const off = (i - (n - 1) / 2) * SPREAD;
        if (key === 'in') arc.dxIn = off; else arc.dxOut = off;
      });
    };
    for (const list of inBy.values()) fan(list, 'in');
    for (const list of outBy.values()) fan(list, 'out');
    for (const arc of es) {
      arc.dxIn = arc.dxIn || 0;
      arc.dxOut = arc.dxOut || 0;
    }
    return es;
  }, [posById, hiddenEdgeTypes]);

  const maxTier = arcs.reduce((mx, a) => Math.max(mx, a.tier), -1);
  const tierH = 12;
  const arcRegionH = (maxTier + 1) * tierH + 10;

  const stackGap = alwaysShowLabels ? 2 * R + 26 : 2 * R + 6;
  const nodeBaseY = arcRegionH + R + 4;
  const maxStack = placed.reduce((mx, p) => Math.max(mx, p.stack || 0), 0);

  const dayLabelPad = granularity === 'hourly' ? 16 : 4;

  const labelPad = alwaysShowLabels ? 22 : 0;
  const axisTop = nodeBaseY + R + maxStack * stackGap + labelPad + dayLabelPad;
  const axisH = 22;
  const svgH = axisTop + axisH;
  const nodeY = (p) => nodeBaseY + (p.stack || 0) * stackGap;

  const rightPad = 12;

  const selEventRaw = selectedEventId
    ? (posById.get(selectedEventId) || SEQ_EVENTS.find(e => e.id === selectedEventId))
    : null;

  const selEvent = selEventRaw && hiddenKinds.has(selEventRaw.kind) ? null : selEventRaw;
  const selKind = selEvent ? (SEQ_KINDS[selEvent.kind] || SEQ_KINDS.decision) : null;

  const involvedAgents = useMemo(() => {
    const seen = new Map();
    for (const m of eventMessages || []) {
      if (m.agent_id && !seen.has(m.agent_id)) seen.set(m.agent_id, m.agent_label || m.agent_id);
    }
    return [...seen.entries()].map(([agent_id, agent_label]) => ({ agent_id, agent_label }));
  }, [eventMessages]);

  return (
    <div className="seqflow-card">
      <div className="seqflow-head">
        <h3>事件序列 → 绕过禁运管控的那次发布（人工分析）</h3>
        <span className="muted small seqflow-hint"
          title="节点 = 关键事件，位置与下方热力图使用同一时间桶。连线为参考工程的人工分析标记，不代表系统已验证的因果。">
          {alwaysShowLabels ? '点击节点查看详情' : '悬停查看事件名 · 点击查看详情'}
        </span>
      </div>

      <div className="seqflow-scroll" ref={scrollRef} onScroll={onScroll}>
        <svg width={LABEL_COL + plotW + rightPad} height={svgH} className="seqflow-svg">
          <defs>
            <marker id="seq-arrow-direct" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M1 1 L9 5 L1 9 Z" fill="#6286ad" />
            </marker>
            <marker id="seq-arrow-enabling" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M1 1 L9 5 L1 9 Z" fill="#a78bfa" />
            </marker>
          </defs>

          <text x={10} y={nodeBaseY + 4} fontSize="11" fill="#7a8aa0">事件流</text>

          {arcs.map((arc, i) => {
            const focusId = hoveredId || selectedEventId;
            const isFocus = focusId && (arc.from === focusId || arc.to === focusId);
            const dimmed = focusId && !isFocus;

            const topY = arcRegionH - (arc.tier + 1) * tierH;
            const dash = arc.type === 'enabling' ? '5 4' : undefined;
            const color = arc.type === 'enabling' ? '#a78bfa' : '#6286ad';

            const x1 = arc.a.x + arc.dxOut;
            const y1 = nodeY(arc.a) - R;

            const GAP = 4;
            const x2 = arc.b.x + arc.dxIn;
            const y2 = nodeY(arc.b) - R - GAP;

            const d = `M ${x1} ${y1} C ${x1} ${topY}, ${x2} ${topY}, ${x2} ${y2}`;
            return (
              <path key={i} d={d} fill="none" stroke={color}
                strokeWidth={isFocus ? 2.4 : 1.6}
                strokeDasharray={dash}
                markerEnd={`url(#${arc.type === 'enabling' ? 'seq-arrow-enabling' : 'seq-arrow-direct'})`}
                opacity={dimmed ? 0.18 : (isFocus ? 1 : 0.8)} />
            );
          })}

          {placed.map(p => {
            const y = nodeY(p);
            const kind = SEQ_KINDS[p.kind] || SEQ_KINDS.decision;
            const sel = selectedEventId === p.id;
            const hov = hoveredId === p.id;
            const focusId = hoveredId || selectedEventId;

            const connected = focusId && arcs.some(a =>
              (a.from === focusId && a.to === p.id) || (a.to === focusId && a.from === p.id));
            const dimmed = focusId && !connected && focusId !== p.id;
            const active = sel || hov;
            const rr = active ? R + 2 : R;

            const glyphStroke = active ? '#ffffff' : (connected ? '#45617f' : 'none');
            const glyphStrokeW = active ? 1.5 : (connected ? 1 : 0);
            return (
              <g key={p.id} style={{ cursor: 'pointer' }}
                opacity={dimmed ? 0.28 : 1}
                onClick={() => onSelectEvent(p.id)}
                onMouseEnter={() => setHoveredId(p.id)}
                onMouseLeave={() => setHoveredId(cur => (cur === p.id ? null : cur))}>
                <title>{p.title}</title>
                <circle cx={p.x} cy={y} r={R + 4} fill="transparent" stroke="none" />
                {kind.shape === 'circle' && (
                  <circle cx={p.x} cy={y} r={rr} fill={kind.color}
                    stroke={active ? '#ffffff' : (connected ? '#45617f' : '#f5f8fc')}
                    strokeWidth={active ? 2 : (connected ? 1.5 : 1)} />
                )}
                {kind.shape === 'triangle' && (
                  <polygon points={trianglePoints(p.x, y, rr * 0.95)} fill={kind.color}
                    stroke={glyphStroke} strokeWidth={glyphStrokeW} strokeLinejoin="round" />
                )}
                {kind.shape === 'cross' && (
                  <g stroke={kind.color} strokeWidth={active ? 3.6 : 3} strokeLinecap="round">
                    <line x1={p.x - rr * 0.72} y1={y - rr * 0.72} x2={p.x + rr * 0.72} y2={y + rr * 0.72} />
                    <line x1={p.x - rr * 0.72} y1={y + rr * 0.72} x2={p.x + rr * 0.72} y2={y - rr * 0.72} />
                  </g>
                )}
              </g>
            );
          })}

          <g className="sf-axis">
            <line x1={LABEL_COL} y1={axisTop} x2={LABEL_COL + plotW} y2={axisTop}
              stroke="#c9d6e6" strokeWidth="1" />
            <text x={10} y={axisTop + 14} fontSize="11" fill="#7a8aa0">时间</text>
            {(buckets || []).map((b, i) => {
              const x = xAt(i);
              const hasEvent = placed.some(p => p.bi === i);

              const isHourly = granularity === 'hourly';
              const label = isHourly ? shortBucket(b, granularity).slice(6) : shortBucket(b, granularity);
              const dayOf = (s) => (s || '').slice(0, 10);
              const isDayStart = isHourly && (i === 0 || dayOf(buckets[i - 1]) !== dayOf(b));

              const approxLabelW = isHourly ? 34 : 30;
              const step = Math.max(1, Math.ceil(approxLabelW / cell.w));
              const show = i % step === 0;
              return (
                <g key={b}>
                  <line x1={x} y1={axisTop} x2={x} y2={axisTop + (hasEvent ? 6 : 3)}
                    stroke={hasEvent ? '#6286ad' : '#c9d6e6'} strokeWidth={hasEvent ? 1.5 : 1} />
                  {(show || hasEvent) && (
                    <text x={x} y={axisTop + 18} textAnchor="middle" fontSize="10"
                      fill={hasEvent ? '#45617f' : '#7a8aa0'} fontWeight={hasEvent ? '700' : '400'}>
                      {label}
                    </text>
                  )}
                  {isDayStart && (
                    <text x={x} y={axisTop - 4} textAnchor="middle" fontSize="10" fill="#526e8b" fontWeight="700">
                      {b.slice(5, 10)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>

          {(() => {
            const rightEdge = LABEL_COL + plotW + rightPad;

            if (alwaysShowLabels) {
              return (
                <g pointerEvents="none">
                  {placed.map(p => {
                    const focusId = hoveredId || selectedEventId;
                    const isFocus = focusId === p.id;
                    const w = Math.max(40, p.title.length * 6.2 + 14);
                    let bx = p.x - w / 2;
                    if (bx + w > rightEdge) bx = rightEdge - w;
                    if (bx < 2) bx = 2;
                    const by = nodeY(p) + R + 4;
                    return (
                      <g key={p.id}>
                        <rect x={bx} y={by} width={w} height={20} rx={5}
                          fill="#f5f8fc" stroke={isFocus ? '#7d93ad' : '#3b4d68'}
                          strokeWidth="1" opacity={isFocus ? 0.98 : 0.92} />
                        <text x={bx + w / 2} y={by + 14} textAnchor="middle" fontSize="11"
                          fill={isFocus ? '#294d76' : '#50657d'}
                          fontWeight={isFocus ? '700' : '400'}>{p.title}</text>
                      </g>
                    );
                  })}
                </g>
              );
            }

            const focusId = hoveredId || selectedEventId;
            if (!focusId) return null;
            const ids = new Set([focusId]);
            for (const a of arcs) {
              if (a.from === focusId) ids.add(a.to);
              if (a.to === focusId) ids.add(a.from);
            }
            const drawn = [];
            const boxes = [];

            const order = [focusId, ...[...ids].filter(i => i !== focusId)];
            for (const id of order) {
              const p = posById.get(id);
              if (!p) continue;
              const isFocus = id === focusId;
              const y = nodeY(p);
              const w = Math.max(40, p.title.length * 6.2 + 14);
              let bx = p.x - w / 2;
              if (bx + w > rightEdge) bx = rightEdge - w;
              if (bx < 2) bx = 2;

              const cands = [y - R - 24, y + R + 6, y - R - 46, y + R + 28, y - R - 68];
              let by = cands[0];
              for (const c of cands) {
                if (c < 2) continue;
                const hit = drawn.some(d =>
                  !(bx + w < d.x || bx > d.x + d.w || c + 20 < d.y || c > d.y + 20));
                if (!hit) { by = c; break; }
              }
              drawn.push({ x: bx, y: by, w });
              boxes.push({ id, bx, by, w, title: p.title, isFocus });
            }
            return (
              <g pointerEvents="none">
                {boxes.map(b => (
                  <g key={b.id}>
                    <rect x={b.bx} y={b.by} width={b.w} height={20} rx={5}
                      fill="#f5f8fc" stroke={b.isFocus ? '#7d93ad' : '#3b4d68'}
                      strokeWidth="1" opacity={b.isFocus ? 0.98 : 0.92} />
                    <text x={b.bx + b.w / 2} y={b.by + 14} textAnchor="middle" fontSize="11"
                      fill={b.isFocus ? '#294d76' : '#50657d'}
                      fontWeight={b.isFocus ? '700' : '400'}>{b.title}</text>
                  </g>
                ))}
              </g>
            );
          })()}
        </svg>
      </div>

      <div className="seqflow-legend">
        {Object.entries(SEQ_KINDS).map(([k, v]) => (
          <label key={k} className="sf-key sf-check" title={`显示 / 隐藏「${v.label}」节点`}>
            <input type="checkbox" checked={!hiddenKinds.has(k)} onChange={() => toggleKind(k)} />
            <KindIcon kind={v} size={12} /> {v.label}
          </label>
        ))}
        <label className="sf-key sf-check" title="显示 / 隐藏人工分析中的直接关联">
          <input type="checkbox" checked={!hiddenEdgeTypes.has('direct')}
            onChange={() => toggleEdgeType('direct')} />
          <span className="sf-line" /> 人工分析关联
        </label>
        <label className="sf-key sf-check" title="显示 / 隐藏促成条件、监控盲区连线">
          <input type="checkbox" checked={!hiddenEdgeTypes.has('enabling')}
            onChange={() => toggleEdgeType('enabling')} />
          <span className="sf-line dashed" /> 促成条件 / 盲区
        </label>
        <label className="sf-key sf-check" title="始终显示所有事件名称，而不是悬停时才显示">
          <input type="checkbox" checked={alwaysShowLabels}
            onChange={e => setAlwaysShowLabels(e.target.checked)} />
          事件名称
        </label>
      </div>

      {selEvent && (
        <div className="seqflow-detail">
          <div className="sf-detail-head">
            <span className="sf-badge"><KindIcon kind={selKind} size={20} /></span>
            <b>{selEvent.title}</b>
            <span className="sf-kind" style={{ color: selKind.color, borderColor: selKind.color }}>{selKind.label}</span>
            {involvedAgents.length > 0 && (
              <span className="sf-agents">
                {involvedAgents.map(a => (
                  <span key={a.agent_id} className="sf-agent-chip" title={agentLabelOf(a.agent_id, a.agent_label)}>
                    <AgentIcon id={a.agent_id} size={14} /> {agentLabelOf(a.agent_id, a.agent_label)}
                  </span>
                ))}
              </span>
            )}
            <span className="muted small">{selEvent.time.replace('T', ' ')}</span>
            <span className="sf-close" role="button" title="关闭" onClick={() => onSelectEvent(selEvent.id)}>✕</span>
          </div>
          <p className="sf-detail-text">{selEvent.detail}</p>
          <div className="sf-msgs-title">
            与之直接相关的消息（{(selEvent.related || []).length}）
          </div>
          {eventMessagesStatus === 'loading' && <span className="muted small">加载中…</span>}
          {eventMessagesStatus === 'error' && <span className="muted small">无法加载消息（后端是否正在运行？）</span>}
          {eventMessagesStatus === '' && (
            <MessageList messages={eventMessages} selectedMessageId={selectedMessageId} onSelectMessage={onSelectMessage} />
          )}
        </div>
      )}
    </div>
  );
}
