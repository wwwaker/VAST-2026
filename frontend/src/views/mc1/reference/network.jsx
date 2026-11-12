// NetworkVisualization — CrisisNet-style reply graph

import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';

import { AGENT_ICONS } from './agentIcons.jsx';
import { agentLabelOf, channelLabelOf } from './constants.js';

// Agent config. Node'lar tek renk (gri) çizilir — tutor önerisi: agent'lar
// renkle değil, konum + kısaltma + etiketle ayırt edilsin, renk kanalı
// edge'lere (message channel) kalsın. color/fill artık NODE_COLOR/NODE_FILL.
export const NODE_COLOR = '#8b95a5'; // tüm node'lar için ortak gri (ring / badge / abbr)
export const NODE_FILL  = '#e2e7ee'; // ortak açık gri dolgu
export const AGENTS = {
  legal_agent:        { label: '法务 Agent',      abbr: 'LA', color: NODE_COLOR, fill: NODE_FILL, seniority: '资深' },
  quality_agent:      { label: '平台信任 Agent',  abbr: 'PT', color: NODE_COLOR, fill: NODE_FILL, seniority: '资深' },
  social_media_agent: { label: '社媒经理 Agent',  abbr: 'SM', color: NODE_COLOR, fill: NODE_FILL, seniority: '资深' },
  judge_agent:        { label: '合规监察 Agent',  abbr: 'J',  color: NODE_COLOR, fill: NODE_FILL, seniority: '合规' },
  pr_agent:           { label: '公关 Agent',      abbr: 'PR', color: NODE_COLOR, fill: NODE_FILL, seniority: '资深' },
  pr_intern_agent:    { label: '公关实习生 Agent', abbr: 'PI', color: NODE_COLOR, fill: NODE_FILL, seniority: '初级' },
  intern_agent:       { label: '实习生 Agent',    abbr: 'IN', color: NODE_COLOR, fill: NODE_FILL, seniority: '初级' },
};

// Edge (channel) renkleri.
// External post channel'ları (official/personal/anonymous_post) hiçbir zaman
// direct edge üretmez (recipients boş, responding_to yok — veride doğrulandı),
// bu yüzden onlara renk ayırmıyoruz. Boşalan belirgin renkler gerçekten edge
// üreten channel'lara dağıtıldı ve comms_huddle, message_type'a göre
// broadcast / action olarak iki ayrı renge bölündü.
const CHANNELS = {
  'comms_huddle|broadcast': { label: '内部通讯频道（广播）', color: '#378ADD' }, // 蓝
  'comms_huddle|action':    { label: '内部通讯频道（行动）', color: '#BA7517' }, // 橙
  one_on_one_chat:          { label: '一对一私聊',           color: '#E24B4A' }, // 红（最醒目）
  side_huddle:              { label: '私下小群',             color: '#1D9E75' }, // 青绿

  mention:                  { label: '点名提及',             color: '#8aa0bc' },
};

// via_channel 没有 message_type → 统一按 broadcast 的蓝色处理。
const colorKeyOf = (ch, mt) => (ch === 'comms_huddle' ? `comms_huddle|${mt || 'broadcast'}` : ch);
export const channelColor = (ch, mt) => CHANNELS[colorKeyOf(ch, mt)]?.color || '#5A7A9A';
const channelLabel = (ch, mt) => CHANNELS[colorKeyOf(ch, mt)]?.label || channelLabelOf(ch) || '其他';

const edgeColor = (e) => (e.channel === 'mention'
  ? channelColor(e.via_channel || 'unknown')
  : channelColor(e.channel, e.message_type));

const NP = {
  legal_agent:        { x: 220, y: 132 },
  quality_agent:      { x: 490, y: 110 },
  social_media_agent: { x: 595, y: 238 },
  judge_agent:        { x: 378, y: 232 },
  pr_agent:           { x: 525, y: 345 },
  pr_intern_agent:    { x: 298, y: 366 },
  intern_agent:       { x: 135, y: 268 },
};

const W = 720;
const H = 430;

function nodeRadius(value, maxValue) {
  const v = Math.max(0, value || 0);
  const norm = maxValue > 0 ? v / maxValue : 0;
  return 13 + Math.sqrt(norm) * 21;
}

function edgeWidth(w, maxW) {
  const norm = maxW > 0 ? w / maxW : 0;
  return Math.max(1.4, 1.4 + norm * 7);
}

function sentimentColor(s) {
  if (s === null || s === undefined) return '#3a4a5e';
  if (s >= 0) {
    const t = Math.min(1, s);
    return d3.interpolateRgb('#9aa7b5', '#378ADD')(t);
  }
  const t = Math.min(1, -s);
  return d3.interpolateRgb('#9aa7b5', '#e24b4a')(t);
}

export default function NetworkVisualization({
  data,
  layout = 'force',
  sizeMetric = 'messages',
  edgeMetric = 'weight',
  colorBySentiment = false,
  selectedNode,
  onSelectNode,
  selectedEdge,
  onSelectEdge,
  followingHeatmapSort = false,
  heatmapOrder = [],
  heatmapSortKey = 'agent_id',
  heatmapSortDir = 'asc',
}) {
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);
  const simRef = useRef(null);

  const posRef = useRef({});

  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;
  // İlk render'da tüm edge'ler "yeni" olduğundan pulse'ı ilk çizimde tetiklemeyiz.
  const firstDataRef = useRef(true);

  useEffect(() => {
    const nodes = (data?.nodes || []).map(n => ({ ...n }));
    const rawEdges = data?.edges || [];

    const DUR = 480;

    const svg = d3.select(svgRef.current);

    let gMain = svg.select('g.net-main');
    if (gMain.empty()) {
      gMain = svg.append('g').attr('class', 'net-main');
      const gGrid = gMain.append('g').attr('class', 'net-grid');
      gMain.append('g').attr('class', 'net-edges');
      gMain.append('g').attr('class', 'net-nodes');
      gMain.append('text').attr('class', 'net-empty')
        .attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle')
        .attr('fill', '#5a7a9a').attr('font-size', 14)
        .style('display', 'none').text('没有 Agent 符合当前筛选条件。');
      const dots = [];
      for (let x = 20; x < W; x += 32) for (let y = 14; y < H; y += 32) dots.push({ x, y });
      gGrid.selectAll('circle').data(dots).enter().append('circle')
        .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', 1).attr('fill', '#151F2E');
      const zoom = d3.zoom().scaleExtent([0.3, 4]).on('zoom', ev => gMain.attr('transform', ev.transform));
      svg.call(zoom);
    }
    const gEdges = gMain.select('g.net-edges');
    const gNodes = gMain.select('g.net-nodes');
    gMain.select('text.net-empty').style('display', nodes.length ? 'none' : null);

    const sizeValue = (n) => {
      if (sizeMetric === 'merger') return n.merger_related_count || 0;
      if (sizeMetric === 'sentiment') return Math.abs(n.bert_sentiment_score || 0);
      return n.message_count || 0;
    };
    const maxSize = d3.max(nodes, sizeValue) || 1;
    nodes.forEach(n => {
      n.r = nodeRadius(sizeValue(n), maxSize);

      const init = posRef.current[n.id] || NP[n.id] || { x: W / 2, y: H / 2 };
      n.x = init.x; n.y = init.y;
    });

    if (layout === 'circle') {
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 65;
      nodes.forEach((n, i) => {
        const ang = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
        n.x = cx + Math.cos(ang) * R; n.y = cy + Math.sin(ang) * R;
      });
    }
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    const edgeValue = (e) => edgeMetric === 'merger' ? (e.merger_related_count || 0) : (e.weight || 0);
    const links = rawEdges
      .filter(e => nodeById.has(e.source) && nodeById.has(e.target))
      .map(e => ({ ...e, source: e.source, target: e.target, channel: e.channel || 'unknown', val: edgeValue(e) }))
      .filter(e => edgeMetric !== 'merger' || e.val > 0);
    const maxW = d3.max(links, e => e.val) || 1;

    // ── mesajların ayrıştırılması: edge olarak görünen reply / partneri gizli reply / non-reply ──
    // Badge = gönderilen toplam mesaj; edge = başka bir agent'ın mesajına yanıt.
    // İki ayrı "görünmezlik" sebebi var ve ikisini karıştırmamak gerekir:
    //   1. Mesaj gerçekten reply değil (broadcast/root)                     → ◌ chip
    //   2. Mesaj reply AMA partner agent mevcut filtrede graftan düşmüş
    //      (ör. merger-only'de hiç merger mesajı olmayan agent görünmez)    → ↩ chip
    // Bu yüzden reply sayısını görünen link'lerden değil, backend'in döndürdüğü
    // HAM edge listesinden (rawEdges) hesaplıyoruz.
    // mention edge (channel='mention') reply değildir; reply sayımına katılmaz.
    const repliesVisibleBySource = {};
    links.forEach(e => {
      if (e.channel !== 'mention') repliesVisibleBySource[e.source] = (repliesVisibleBySource[e.source] || 0) + (e.weight || 0);
    });
    const repliesAllBySource = {};
    rawEdges.forEach(e => {
      if (e.channel !== 'mention') repliesAllBySource[e.source] = (repliesAllBySource[e.source] || 0) + (e.weight || 0);
    });
    nodes.forEach(n => {
      const all = repliesAllBySource[n.id] || 0;
      const vis = repliesVisibleBySource[n.id] || 0;
      n.replies_sent = vis;                                            // edge olarak çizilen reply'lar
      n.hidden_replies = Math.max(0, all - vis);                       // reply ama partner görünmüyor
      n.broadcast_count = Math.max(0, (n.message_count || 0) - all);   // gerçek non-reply
    });

    nodes.forEach(n => {
      n.has_unanswered_mentions = (n.unanswered_mention_count || 0) > 0;
      n.silent = n.has_unanswered_mentions;
    });

    const dirTotal = {};
    links.forEach(e => {
      const k = `${e.source}>${e.target}`;
      dirTotal[k] = (dirTotal[k] || 0) + 1;
    });
    const dirSeen = {};
    links.forEach(e => {
      const k = `${e.source}>${e.target}`;
      const i = dirSeen[k] || 0;
      dirSeen[k] = i + 1;
      const n = dirTotal[k];
      const center = (n - 1) / 2;
      const base = 24;
      e._off = base + (i - center) * 15;
    });

    // ── tooltip ──
    const tt = d3.select(tooltipRef.current);
    const showTT = (ev, html) => { tt.style('display', 'block').html(html); moveTT(ev); };
    const moveTT = (ev) => {
      const rect = svgRef.current.getBoundingClientRect();
      tt.style('left', (ev.clientX - rect.left + 14) + 'px')
        .style('top', (ev.clientY - rect.top + 14) + 'px');
    };
    const hideTT = () => tt.style('display', 'none');

    // ── highlight ──
    function highlightNode(id) {
      const connected = new Set([id]);
      links.forEach(e => { if (e.source === id) connected.add(e.target); if (e.target === id) connected.add(e.source); });
      nodeSel.classed('dimmed', d => !connected.has(d.id));
      edgeSel.classed('dimmed', e => !(e.source === id || e.target === id))
        .classed('highlighted', e => e.source === id || e.target === id);
    }
    function clearHighlight() {
      nodeSel.classed('dimmed', false);
      edgeSel.classed('dimmed', false).classed('highlighted', false);
    }

    // comms_huddle broadcast/action ayrı edge'ler olduğundan message_type da key'e girer;

    const edgeKey = e => `${e.source}>${e.target}>${e.channel}${e.message_type ? '>' + e.message_type : ''}${e.via_channel ? '>' + e.via_channel : ''}`;
    const edgeData = gEdges.selectAll('g.net-edge').data(links, edgeKey);
    edgeData.exit().interrupt().transition().duration(DUR).style('opacity', 0).remove();
    const edgeEnter = edgeData.enter().append('g').attr('class', 'net-edge').style('opacity', 0);
    edgeEnter.append('path').attr('class', 'edge-glow').style('fill', 'none').style('stroke-linecap', 'round');
    edgeEnter.append('path').attr('class', 'edge-path').style('fill', 'none').style('stroke-linecap', 'round');
    edgeEnter.append('path').attr('class', 'edge-arrow').style('stroke', 'none');
    edgeEnter.append('path').attr('class', 'edge-hit').style('fill', 'none').style('stroke', 'transparent').style('stroke-width', 16).style('cursor', 'pointer');
    const edgeLblEnter = edgeEnter.append('g').attr('class', 'net-edge-lbl');
    edgeLblEnter.append('rect').attr('rx', 4).attr('height', 14).attr('fill', '#08111E').attr('fill-opacity', 0.92);
    edgeLblEnter.append('text').attr('text-anchor', 'middle').attr('font-family', 'monospace').attr('font-size', 9.5).attr('font-weight', 700);

    const edgeSel = edgeEnter.merge(edgeData);
    edgeSel.classed('selected', e => selectedEdge === edgeKey(e));
    edgeSel.select('.edge-glow').style('stroke', e => edgeColor(e))
      .transition().duration(DUR).style('stroke-width', e => edgeWidth(e.val, maxW) + 6).style('stroke-opacity', 0.07);

    edgeSel.select('.edge-path').style('stroke', e => edgeColor(e))
      .style('stroke-dasharray', e => e.channel === 'mention' ? '6 4' : null)
      .transition().duration(DUR).style('stroke-width', e => edgeWidth(e.val, maxW)).style('stroke-opacity', 0.6);
    edgeSel.select('.edge-arrow').style('fill', e => edgeColor(e));
    edgeSel.select('.edge-hit')
      .on('click', function (ev, e) {
        ev.stopPropagation();
        onSelectEdge && onSelectEdge(e);
      })
      .on('mouseenter', function (ev, e) {
        const fa = AGENTS[e.source]?.label || e.source;
        const ta = AGENTS[e.target]?.label || e.target;
        if (e.channel === 'mention') {
          showTT(ev, `<div class="tt-name" style="color:${edgeColor(e)}">${fa} &rarr; ${ta}</div>
            <div class="tt-row"><span class="tt-k">类型</span><span class="tt-v">点名提及（"${ta} — ..."）</span></div>
            <div class="tt-row"><span class="tt-k">渠道</span><span class="tt-v">${channelLabel(e.via_channel || 'unknown')}</span></div>
            <div class="tt-row"><span class="tt-k">提及次数</span><span class="tt-v">${e.weight}</span></div>
            <div class="tt-row"><span class="tt-k">含合并关键词</span><span class="tt-v">${e.merger_related_count}</span></div>`);
          return;
        }
        showTT(ev, `<div class="tt-name" style="color:${edgeColor(e)}">${fa} &rarr; ${ta}</div>
          <div class="tt-row"><span class="tt-k">渠道</span><span class="tt-v">${channelLabel(e.channel, e.message_type)}</span></div>
          <div class="tt-row"><span class="tt-k">回复数</span><span class="tt-v">${e.weight}</span></div>
          <div class="tt-row"><span class="tt-k">含合并关键词</span><span class="tt-v">${e.merger_related_count}</span></div>`);
      })
      .on('mousemove', moveTT)
      .on('mouseleave', hideTT);

    edgeEnter.transition().duration(DUR).style('opacity', 1)
      .on('end', function () { d3.select(this).style('opacity', null); });

    // ── "yeni beliren edge" pulse vurgusu ──
    // Timeline Play sırasında büyüyen grafikte yeni edge'i gözle yakalamak zordur.
    // İlk render hariç, bu güncellemede ilk kez ortaya çıkan edge'leri birkaç
    // saniye pulse ettirip ağırlık etiketini de geçici olarak göster.
    if (!firstDataRef.current && !edgeEnter.empty()) {
      edgeEnter.classed('edge-new', true);
      const entered = edgeEnter;
      setTimeout(() => entered.classed('edge-new', false), 4000);
    }

    // ── NODES ──
    const isSentiment = colorBySentiment;
    // silent node: içi boş (koyu) bırakılır — "burada olması gerekirdi ama ses yok" hissi
    // Tüm node'lar tek renk (gri): ring/badge = NODE_COLOR, dolgu = NODE_FILL.
    // abbr açık gri dolgu üzerinde okunaklı olsun diye koyu.
    const nodeFill = (d) => d.silent ? '#161d2b' : (isSentiment ? sentimentColor(d.bert_sentiment_score) : NODE_FILL);
    const nodeStroke = () => NODE_COLOR;
    const abbrColor = (d) => d.silent ? NODE_COLOR : (isSentiment ? '#0a0f16' : '#3a4452');

    const rankById = {};
    (heatmapOrder || []).forEach((id, i) => { rankById[id] = i + 1; });
    const showRank = followingHeatmapSort && (heatmapOrder || []).length > 0;

    const nodeData = gNodes.selectAll('g.net-node').data(nodes, d => d.id);
    nodeData.exit().interrupt().transition().duration(DUR).style('opacity', 0).remove();
    const nodeEnter = nodeData.enter().append('g').attr('class', 'net-node').style('cursor', 'pointer').style('opacity', 0);
    nodeEnter.append('circle').attr('class', 'n-ring').attr('fill', 'none').attr('stroke-width', 1.2).attr('stroke-opacity', 0.18).attr('stroke-dasharray', '4 3');
    nodeEnter.append('circle').attr('class', 'n-glow').attr('fill-opacity', 0.09);
    nodeEnter.append('circle').attr('class', 'n-circle').attr('stroke-width', 2.5);
    nodeEnter.append('circle').attr('class', 'n-inner').attr('fill-opacity', 0.18);
    nodeEnter.append('text').attr('class', 'n-abbr').attr('text-anchor', 'middle').attr('font-family', 'monospace').attr('font-weight', 700).attr('pointer-events', 'none');

    nodeEnter.append('circle').attr('class', 'n-icon-bg').attr('fill', '#f2f5f9').attr('fill-opacity', 0.88).attr('pointer-events', 'none');
    nodeEnter.append('image').attr('class', 'n-icon').attr('pointer-events', 'none')
      .attr('preserveAspectRatio', 'xMidYMid meet');
    nodeEnter.append('text').attr('class', 'n-label').attr('text-anchor', 'middle').attr('font-family', 'sans-serif').attr('font-size', 11).attr('font-weight', 600).attr('fill', '#cfe0f2').attr('pointer-events', 'none').attr('opacity', 1);
    nodeEnter.append('rect').attr('class', 'n-badge-rect').attr('rx', 6.5).attr('height', 13).attr('pointer-events', 'none');
    nodeEnter.append('text').attr('class', 'n-badge-txt').attr('text-anchor', 'middle').attr('font-family', 'monospace').attr('font-size', 9).attr('fill', '#fff').attr('font-weight', 700).attr('pointer-events', 'none');
    // "yanıt olmayan mesaj" chip'i (node'un sağ altı, kesikli çerçeve = edge'i olmayan mesajlar)
    nodeEnter.append('rect').attr('class', 'n-bc-rect').attr('rx', 6.5).attr('height', 13)
      .attr('fill', '#f0f4f9').attr('stroke-width', 1).attr('stroke-dasharray', '3 2').attr('pointer-events', 'none');
    nodeEnter.append('text').attr('class', 'n-bc-txt').attr('text-anchor', 'middle').attr('font-family', 'monospace')
      .attr('font-size', 9).attr('font-weight', 700).attr('pointer-events', 'none');
    // "partneri gizli reply" chip'i (node'un sol altı: reply var ama karşı agent filtreyle gizlenmiş)
    nodeEnter.append('rect').attr('class', 'n-hr-rect').attr('rx', 6.5).attr('height', 13)
      .attr('fill', '#f0f4f9').attr('stroke-width', 1).attr('stroke-dasharray', '3 2').attr('pointer-events', 'none');
    nodeEnter.append('text').attr('class', 'n-hr-txt').attr('text-anchor', 'middle').attr('font-family', 'monospace')
      .attr('font-size', 9).attr('font-weight', 700).attr('pointer-events', 'none');

    nodeEnter.append('circle').attr('class', 'n-silent-ring').attr('fill', 'none')
      .attr('stroke', '#e24b4a').attr('stroke-width', 2).attr('pointer-events', 'none');
    nodeEnter.append('rect').attr('class', 'n-silent-rect').attr('rx', 6.5).attr('height', 13)
      .attr('fill', '#fff1ee').attr('stroke', '#e24b4a').attr('stroke-width', 1).attr('pointer-events', 'none');
    nodeEnter.append('text').attr('class', 'n-silent-txt').attr('text-anchor', 'middle').attr('font-family', 'monospace')
      .attr('font-size', 9).attr('font-weight', 700).attr('fill', '#ff8a80').attr('pointer-events', 'none');
    nodeEnter.append('circle').attr('class', 'n-rank-bg').attr('r', 9).attr('fill', '#f0f4f9').attr('stroke-width', 1.5).attr('pointer-events', 'none');
    nodeEnter.append('text').attr('class', 'n-rank-txt').attr('text-anchor', 'middle').attr('font-family', 'monospace').attr('font-size', 9.5).attr('font-weight', 800).attr('fill', '#dbe7f5').attr('pointer-events', 'none');

    const nodeSel = nodeEnter.merge(nodeData);

    nodeSel.classed('silent', d => d.has_unanswered_mentions);
    nodeSel.select('.n-silent-ring').style('display', d => d.has_unanswered_mentions ? null : 'none');
    nodeSel.select('.n-silent-rect').style('display', d => d.has_unanswered_mentions ? null : 'none');
    nodeSel.select('.n-silent-txt').style('display', d => d.has_unanswered_mentions ? null : 'none')
      .text(d => {
        const u = d.unanswered_mention_count || 0;
        return d.has_unanswered_mentions ? `⚠ ${u} 条未回复的点名` : '';
      });
    nodeSel.select('.n-ring').attr('stroke', nodeStroke);
    nodeSel.select('.n-glow').attr('fill', nodeStroke).style('display', d => d.silent ? 'none' : null);
    nodeSel.select('.n-circle').attr('stroke', nodeStroke)
      .transition().duration(DUR).attr('fill', nodeFill);
    nodeSel.select('.n-inner').attr('fill', nodeStroke).style('display', d => d.silent ? 'none' : null);

    const hasIcon = (d) => !!AGENT_ICONS[d.id];
    nodeSel.select('.n-abbr').attr('fill', abbrColor)
      .style('display', d => hasIcon(d) ? 'none' : null)
      .text(d => AGENTS[d.id]?.abbr || d.id.slice(0, 2).toUpperCase());
    nodeSel.select('.n-icon')
      .style('display', d => hasIcon(d) ? null : 'none')
      .attr('href', d => AGENT_ICONS[d.id]?.uri || null)

      .attr('opacity', d => d.silent ? 0.55 : 1);
    nodeSel.select('.n-icon-bg')
      .style('display', d => (hasIcon(d) && (isSentiment || d.silent)) ? null : 'none');
    nodeSel.select('.n-label').text(d => agentLabelOf(d.id, d.label));

    nodeSel.select('.n-label').attr('opacity', 1);
    nodeSel.select('.n-badge-rect').attr('fill', nodeStroke);
    nodeSel.select('.n-badge-txt').text(d => d.message_count);
    nodeSel.select('.n-bc-rect').attr('stroke', nodeStroke)
      .style('display', d => d.broadcast_count > 0 ? null : 'none');
    nodeSel.select('.n-bc-txt').attr('fill', nodeStroke)
      .text(d => d.broadcast_count > 0 ? `◌${d.broadcast_count}` : '')
      .style('display', d => d.broadcast_count > 0 ? null : 'none');
    nodeSel.select('.n-hr-rect').attr('stroke', nodeStroke)
      .style('display', d => d.hidden_replies > 0 ? null : 'none');
    nodeSel.select('.n-hr-txt').attr('fill', nodeStroke)
      .text(d => d.hidden_replies > 0 ? `↩${d.hidden_replies}` : '')
      .style('display', d => d.hidden_replies > 0 ? null : 'none');
    nodeSel.select('.n-rank-bg').attr('stroke', nodeStroke).style('display', showRank ? null : 'none');
    nodeSel.select('.n-rank-txt').style('display', showRank ? null : 'none')
      .text(d => (showRank && rankById[d.id] != null) ? `#${rankById[d.id]}` : '');
    nodeSel.select('.n-ring').transition().duration(DUR).attr('r', d => d.r + 8);
    nodeSel.select('.n-silent-ring').transition().duration(DUR).attr('r', d => d.r + 5.5);
    nodeSel.select('.n-glow').transition().duration(DUR).attr('r', d => d.r + 3);
    nodeSel.select('.n-circle').transition().duration(DUR).attr('r', d => d.r);
    nodeSel.select('.n-inner').transition().duration(DUR).attr('r', d => Math.max(2, d.r - 4));
    nodeSel.select('.n-abbr').transition().duration(DUR).attr('font-size', d => Math.max(9, Math.round(d.r * 0.56)));

    const iconSize = (d) => Math.min(30, Math.max(15, Math.round(d.r * 1.05)));
    nodeSel.select('.n-icon').transition().duration(DUR)
      .attr('width', iconSize).attr('height', iconSize)
      .attr('x', d => -iconSize(d) / 2).attr('y', d => -iconSize(d) / 2);
    nodeSel.select('.n-icon-bg').transition().duration(DUR)
      .attr('r', d => iconSize(d) * 0.66);
    nodeSel
      .on('click', (ev, n) => { ev.stopPropagation(); onSelectNode && onSelectNode(n.id); })
      .on('mouseenter', function (ev, n) {
        showTT(ev, `<div class="tt-name" style="color:#dfe7f0">${agentLabelOf(n.id, n.label)}</div>
          ${n.has_unanswered_mentions ? `<div class="tt-row"><span class="tt-k" style="color:#e24b4a">⚠ ${n.unanswered_mention_count || 0} 条未回复的点名</span><span class="tt-v" style="color:#ff8a80">被点名但未直接回复</span></div>` : ''}
          <div class="tt-row"><span class="tt-k">发出消息</span><span class="tt-v">${n.message_count}</span></div>
          <div class="tt-row"><span class="tt-k">收到消息（被点名/被回复）</span><span class="tt-v">${n.received_count ?? 0}</span></div>
          <div class="tt-row"><span class="tt-k">&nbsp;&nbsp;回复，已画成连线</span><span class="tt-v">${n.replies_sent ?? 0}</span></div>
          <div class="tt-row"><span class="tt-k">&nbsp;&nbsp;\u21a9 回复，对方被筛选隐藏</span><span class="tt-v">${n.hidden_replies ?? 0}</span></div>
          <div class="tt-row"><span class="tt-k">&nbsp;&nbsp;\u25cc 非回复（广播/主题起点）</span><span class="tt-v">${n.broadcast_count ?? 0}</span></div>
          <div class="tt-row"><span class="tt-k">显式点名</span><span class="tt-v">${n.mention_count ?? 0}</span></div>
          <div class="tt-row"><span class="tt-k">&nbsp;&nbsp;已回应的点名</span><span class="tt-v">${n.answered_mention_count ?? 0}</span></div>
          <div class="tt-row"><span class="tt-k">&nbsp;&nbsp;未回应的点名</span><span class="tt-v">${n.unanswered_mention_count ?? 0}</span></div>
          <div class="tt-row"><span class="tt-k">含合并关键词</span><span class="tt-v">${n.merger_related_count}</span></div>
          <div class="tt-row"><span class="tt-k">情绪分值</span><span class="tt-v">${n.bert_sentiment_score == null ? '\u2014' : n.bert_sentiment_score.toFixed(2)}</span></div>`);
        highlightNode(n.id);
        d3.select(this).select('.n-label').transition().duration(120).attr('opacity', 1);
      })
      .on('mousemove', moveTT)
      .on('mouseleave', function (ev, d) {
        hideTT();

        const selNow = selectedNodeRef.current;
        if (!selNow) clearHighlight(); else highlightNode(selNow);

        d3.select(this).select('.n-label').attr('opacity', 1);
      });

    nodeEnter.transition().duration(DUR).style('opacity', 1)
      .on('end', function () { d3.select(this).style('opacity', null); });

    function edgeGeom(a, b, off) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y;
      const l = Math.sqrt(dx * dx + dy * dy) || 1;
      const cx = mx + (-dy / l) * off, cy = my + (dx / l) * off;

      let tx = b.x - cx, ty = b.y - cy;
      const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
      const br = b.r || 13;
      const ex = b.x - tx * (br + 9), ey = b.y - ty * (br + 9);
      const tipx = b.x - tx * (br + 2), tipy = b.y - ty * (br + 2);
      const aw = 4.5, alen = 8;
      const bx = tipx - tx * alen, by = tipy - ty * alen;
      const px = -ty, py = tx;
      const arrow = `M${tipx},${tipy} L${bx + px * aw},${by + py * aw} L${bx - px * aw},${by - py * aw} Z`;
      const path = `M${a.x},${a.y} Q${cx},${cy} ${ex},${ey}`;
      const lx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x, ly = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
      return { path, arrow, lx, ly };
    }

    function ticked() {
      edgeSel.each(function (e) {
        const a = nodeById.get(e.source);
        const b = nodeById.get(e.target);
        if (!a || !b) return;
        const gm = edgeGeom(a, b, e._off);
        const g = d3.select(this);
        g.select('.edge-glow').attr('d', gm.path);
        g.select('.edge-path').attr('d', gm.path);
        g.select('.edge-hit').attr('d', gm.path);
        g.select('.edge-arrow').attr('d', gm.arrow);
        const txt = String(e.weight);
        const rw = txt.length * 7 + 8;
        const col = edgeColor(e);
        const lbl = g.select('.net-edge-lbl');
        lbl.select('rect').attr('x', gm.lx - rw / 2).attr('y', gm.ly - 7).attr('width', rw)
          .attr('stroke', col).attr('stroke-opacity', 0.3).attr('stroke-width', 0.5);
        lbl.select('text').attr('x', gm.lx).attr('y', gm.ly + 4).attr('fill', col).text(txt);
      });
      nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
      nodeSel.select('.n-label').attr('y', d => d.y > H - 160 ? -d.r - 9 : d.r + 16);
      nodeSel.select('.n-badge-rect').each(function (d) {
        const bw = String(d.message_count).length * 7 + 12;
        d3.select(this).attr('width', bw).attr('x', d.r - 2).attr('y', -d.r + 2 - 9);
      });
      nodeSel.select('.n-badge-txt').each(function (d) {
        const bw = String(d.message_count).length * 7 + 12;
        d3.select(this).attr('x', d.r - 2 + bw / 2).attr('y', -d.r + 2 + 1.5);
      });
      // "yanıt olmayan mesaj" chip'i: node'un sağ altı (badge'in çaprazı)
      nodeSel.select('.n-bc-rect').each(function (d) {
        const t = `◌${d.broadcast_count}`;
        const bw = t.length * 6.5 + 10;
        d3.select(this).attr('width', bw).attr('x', d.r - 2).attr('y', d.r - 6);
      });
      nodeSel.select('.n-bc-txt').each(function (d) {
        const t = `◌${d.broadcast_count}`;
        const bw = t.length * 6.5 + 10;
        d3.select(this).attr('x', d.r - 2 + bw / 2).attr('y', d.r + 4.5);
      });
      // "partneri gizli reply" chip'i: node'un sol altı
      nodeSel.select('.n-hr-rect').each(function (d) {
        const t = `↩${d.hidden_replies}`;
        const bw = t.length * 6.5 + 10;
        d3.select(this).attr('width', bw).attr('x', -(d.r - 2) - bw).attr('y', d.r - 6);
      });
      nodeSel.select('.n-hr-txt').each(function (d) {
        const t = `↩${d.hidden_replies}`;
        const bw = t.length * 6.5 + 10;
        d3.select(this).attr('x', -(d.r - 2) - bw / 2).attr('y', d.r + 4.5);
      });

      nodeSel.select('.n-silent-rect').each(function (d) {
        if (!d.has_unanswered_mentions) return;
        const u = d.unanswered_mention_count || 0;
        const t = `⚠ ${u} 条未回复的点名`;
        const bw = t.length * 6.5 + 10;
        const top = d.y > H - 160 ? d.r + 8 : d.r + 21; // label üstteyse chip node'a yakın durabilir
        d3.select(this).attr('width', bw).attr('x', -bw / 2).attr('y', top);
      });
      nodeSel.select('.n-silent-txt').each(function (d) {
        if (!d.has_unanswered_mentions) return;
        const top = d.y > H - 160 ? d.r + 8 : d.r + 21;
        d3.select(this).attr('x', 0).attr('y', top + 10.5);
      });
      nodeSel.select('.n-abbr').attr('y', d => Math.max(9, Math.round(d.r * 0.56)) * 0.4);

      nodeSel.select('.n-rank-bg').attr('cx', d => -d.r + 1).attr('cy', d => -d.r + 1);
      nodeSel.select('.n-rank-txt').attr('x', d => -d.r + 1).attr('y', d => -d.r + 1 + 3.3);
    }

    ticked();

    nodeSel.call(d3.drag()
      .on('start', function () { d3.select(this).raise(); })
      .on('drag', (ev, d) => {
        d.x = ev.x; d.y = ev.y;
        posRef.current[d.id] = { x: ev.x, y: ev.y };
        ticked();
      }));

    if (selectedNode) highlightNode(selectedNode);

    firstDataRef.current = false;
    return () => {};
  }, [data, layout, sizeMetric, edgeMetric, colorBySentiment, onSelectNode, onSelectEdge, followingHeatmapSort, heatmapOrder, heatmapSortKey, heatmapSortDir]);

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    const nodeSel = svg.selectAll('g.net-node');
    const edgeSel = svg.selectAll('g.net-edge');
    nodeSel
      .classed('selected', d => d.id === selectedNode)
      .each(function (d) {

        d3.select(this).select('.n-label').attr('opacity', 1);
      });

    if (selectedNode) {
      const connected = new Set([selectedNode]);
      (data?.edges || []).forEach(e => {
        if (e.source === selectedNode) connected.add(e.target);
        if (e.target === selectedNode) connected.add(e.source);
      });
      nodeSel.classed('dimmed', d => !connected.has(d.id));
      edgeSel.classed('dimmed', e => !(e.source === selectedNode || e.target === selectedNode))
        .classed('highlighted', e => e.source === selectedNode || e.target === selectedNode);
    } else {
      nodeSel.classed('dimmed', false);
      edgeSel.classed('dimmed', false).classed('highlighted', false);
    }
  }, [selectedNode, data]);

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll('g.net-edge')
      .classed('selected', d => `${d.source}>${d.target}>${d.channel}${d.message_type ? '>' + d.message_type : ''}${d.via_channel ? '>' + d.via_channel : ''}` === selectedEdge);
  }, [selectedEdge, data]);

  const channelTotals = {};
  (data?.edges || []).forEach(e => {
    const key = e.channel === 'mention' ? 'mention' : colorKeyOf(e.channel || 'unknown', e.message_type);
    channelTotals[key] = (channelTotals[key] || 0) + (e.weight || 0);
  });
  const legendChannels = Object.keys(CHANNELS).filter(ch => channelTotals[ch] > 0);
  const hasSilent = (data?.nodes || []).some(n => (n.unanswered_mention_count || 0) > 0);

  return (
    <div className="net-wrap">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="net-svg" />
      <div ref={tooltipRef} className="net-tt" style={{ display: 'none' }} />
      <div className="net-legend">
        <span className="nl-item nl-dir">▸ 箭头 = 回复方向（发送者 → 接收者）</span>
        <span className="nl-item nl-dir" title="右上角的实心徽标统计该 Agent 在当前筛选下发出的全部消息。◌（右下）= 非回复类消息（广播 / 开启话题的帖子）。↩（左下）= 属于回复、但对方 Agent 被当前筛选隐藏（例如“仅含合并关键词”会隐藏没有匹配消息的 Agent），因此无法画出连线。">
          ● 徽标 = 发出消息 · ◌ = 非回复 · ↩ = 回复但对方被隐藏
        </span>
        {legendChannels.length > 0 ? legendChannels.map(ch => (
          <span className="nl-item" key={ch}
            title={ch === 'mention' ? '虚线：发送者在消息开头点名致意该 Agent（“Judge — ...”、“@pr-intern: ...”），但它并不是一条回复。虚线 = 点名；颜色跟随消息所使用的渠道。' : undefined}>
            {ch === 'mention'
              ? <span className="nl-line nl-dash" style={{ color: channelColor(ch) }} />
              : <span className="nl-line" style={{ background: channelColor(ch) }} />} {ch === 'mention' ? '点名提及（颜色 = 渠道）' : channelLabel(ch)}
            <span className="nl-cnt">{channelTotals[ch]}</span>
          </span>
        )) : <span className="nl-item">连线颜色 = 渠道 · 节点大小 = 消息数 · 悬停查看名称</span>}
        {hasSilent && (
          <span className="nl-item nl-silent" title="红色警示标记的是在所选窗口内被明确点名、但未对其中一条或多条消息做出直接回复的 Agent。红色脉冲圆环用于标识，⚠ 徽标显示未回复点名的数量。">
            <span className="nl-dot" style={{ borderColor: '#e24b4a' }} /> ⚠ 未回复的点名 = 被点名但未直接回复
          </span>
        )}
      </div>
    </div>
  );
}
