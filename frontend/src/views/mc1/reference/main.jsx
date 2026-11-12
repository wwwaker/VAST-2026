
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';

import { RefreshCcw, Play, Pause } from 'lucide-react';
import NetworkVisualization, { AGENTS, channelColor } from './network.jsx';

import { AgentIcon } from './agentIcons.jsx';


import {
  API, TEXT_SOURCE_LABELS, visibilityGroupOf, CELL, LABEL_COL, EVENT_MARKERS,
  agentLabelOf, channelLabelOf, messageTypeLabelOf,
} from './constants.js';
import {
  shortBucket, countColor, sentimentCellColor,
  fmtSigned, fmtRoundLabel, timeToBucket,
} from './utils.js';
import { Collapsible } from './components/Collapsible.jsx';
import { CrisisTimeline } from './components/CrisisTimeline.jsx';
import { StockSentimentLineChart } from './components/StockSentimentLineChart.jsx';
import { SequentialFlow } from './components/SequentialFlow.jsx';
import { SEQ_EVENTS, MERGER_KEYWORDS } from './constants.js';
import { loadCommIdMap } from './commIdMap.js';
import {
  MessageDetailPanel, EdgeMessagesPanel, NodeMessagesPanel, ConversationFlowModal,
} from './components/messagePanels.jsx';

export default function ReferenceMc1({ onDatasetChange }) {

  const requests = useRef({});
  const nextRequest = (key) => (requests.current[key] = (requests.current[key] || 0) + 1);
  const isCurrent = (key, token) => requests.current[key] === token;

  const [granularity, setGranularity] = useState('hourly');
  const [mergerOnly, setMergerOnly] = useState(false);
  const [selectedCombos, setSelectedCombos] = useState([]);
  const [selectedTextSources, setSelectedTextSources] = useState([]);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [agentFilter, setAgentFilter] = useState([]);

  const [heatmapMode, setHeatmapMode] = useState('count'); // count | sentiment
  const [heatmapSort, setHeatmapSort] = useState({ key: 'agent_id', dir: 'asc' }); // key: agent_id|total|sentiment

  const [networkLayout, setNetworkLayout] = useState('force'); // force | circle
  const [networkSort, setNetworkSort] = useState({ nodeSize: 'messages' });

  const [colorBySentiment, setColorBySentiment] = useState(false);

  const [netMirrorsHeatmap, setNetMirrorsHeatmap] = useState(false);
  const [selectedNetworkNode, setSelectedNetworkNode] = useState(null);
  // ---- node click → Node Messages Panel (broadcast/root mesajlar dahil) ----
  const [nodeMessages, setNodeMessages] = useState([]);
  const [isNodeDetailCollapsed, setIsNodeDetailCollapsed] = useState(false);
  // ---- network edge click → Edge Messages Panel ----
  const [selectedEdge, setSelectedEdge] = useState(null); // { key, source, target, sourceLabel, targetLabel, channel, mention }
  const [edgeMessages, setEdgeMessages] = useState([]);
  const [isEdgeDetailCollapsed, setIsEdgeDetailCollapsed] = useState(false);

  const [netCombos, setNetCombos] = useState([]);
  const [netMergerOnly, setNetMergerOnly] = useState(false);
  const [netAgentFilter, setNetAgentFilter] = useState([]);

  const [filtersOpen, setFiltersOpen] = useState(true);

  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showLineChart, setShowLineChart] = useState(true);
  const [showNetwork, setShowNetwork] = useState(true);
  const [showSeqFlow, setShowSeqFlow] = useState(true);

  const [sideBySide, setSideBySide] = useState(false);
  const [showStockPriceLine, setShowStockPriceLine] = useState(true);

  const effFiltersOpen = filtersOpen && !sideBySide;
  const effShowLineChart = showLineChart && !sideBySide;

  const effShowSeqFlow = showSeqFlow && !sideBySide;
  const [showBertSentimentLine, setShowBertSentimentLine] = useState(true);

  const [timeline, setTimeline] = useState([]);          // [{idx,hour,cutoff,event_headline,total_msgs,merger_msgs,...}]
  const [timelineStartIdx, setTimelineStartIdx] = useState(0);
  const [timelineIdx, setTimelineIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [options, setOptions] = useState({
    message_types: [], channels: [], channel_types: [], text_sources: ['content', 'reacting', 'rationalizing', 'deliberating'],
    agents: [], merger_count: 0, internal_merger_count: 0, combined_merger_count: 0,
    total_count: 0, min_time: '', max_time: '', merger_keywords: [],
  });
  const [heatmap, setHeatmap] = useState({ agents: [], buckets: [], time_buckets: [], cells: [], max_count: 0 });
  const [lineChart, setLineChart] = useState({ time_buckets: [], series: [] });
  const [network, setNetwork] = useState({ nodes: [], edges: [] });

  // ---- detail ----
  const [selected, setSelected] = useState(null); // { agent, bucket }
  const [messages, setMessages] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [keywords, setKeywords] = useState({ close_keywords: [], far_keywords: [] });
  const [isMessageDetailCollapsed, setIsMessageDetailCollapsed] = useState(false);

  // ---- single message context / related messages ----
  const [selectedMessageId, setSelectedMessageId] = useState(null);
  const [messageContext, setMessageContext] = useState(null);
  const [contextStatus, setContextStatus] = useState(''); // '', 'loading', 'error'
  const [flowOpen, setFlowOpen] = useState(false); // Conversation Flow modal

  const [seqEventId, setSeqEventId] = useState(null);
  const [seqEventMessages, setSeqEventMessages] = useState([]);
  const [seqMsgStatus, setSeqMsgStatus] = useState(''); // '', 'loading', 'error'

  const [cellStatus, setCellStatus] = useState('');
  const [nodeStatus, setNodeStatus] = useState('');
  const [edgeStatus, setEdgeStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  const timelineEnd = (timeline.length && timeline[timelineIdx])
    ? (timeline[timelineIdx].cutoff || timeline[timelineIdx].hour || '')
    : '';
  const timelineStart = (timeline.length && timelineStartIdx > 0 && timeline[timelineStartIdx])
    ? (timeline[timelineStartIdx].hour || '')
    : '';

  const commonQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('granularity', granularity);
    p.set('merger_only', mergerOnly ? 'true' : 'false');
    selectedCombos.forEach(t => p.append('message_types', t));
    selectedTextSources.forEach(s => p.append('text_sources', s));

    if (timelineStart) p.set('start_time', timelineStart);
    if (timelineEnd) p.set('end_time', timelineEnd);
    if (searchKeyword.trim()) p.set('keyword', searchKeyword.trim());
    return p.toString();
  }, [granularity, mergerOnly, selectedCombos, selectedTextSources, searchKeyword, timelineStart, timelineEnd]);

  const networkQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('granularity', granularity);

    // --- filter context ---
    if (netMirrorsHeatmap) {

      p.set('merger_only', mergerOnly ? 'true' : 'false');
      selectedCombos.forEach(t => p.append('message_types', t));
      selectedTextSources.forEach(s => p.append('text_sources', s));
      if (searchKeyword.trim()) p.set('keyword', searchKeyword.trim());
    } else {

      p.set('merger_only', netMergerOnly ? 'true' : 'false');
      netCombos.forEach(t => p.append('message_types', t));
    }

    if (timelineStart) p.set('start_time', timelineStart);
    if (timelineEnd) p.set('end_time', timelineEnd);
    return p.toString();
  }, [granularity, netMirrorsHeatmap,
      mergerOnly, selectedCombos, selectedTextSources, searchKeyword,
      netMergerOnly, netCombos,
      timelineStart, timelineEnd]);

  async function loadOptions() {
    try {
      const res = await fetch(`${API}/api/options`);
      if (!res.ok) throw new Error(`options ${res.status}`);
      setOptions(await res.json());
    } catch (e) {
      setStatus('无法加载筛选选项（后端是否正在运行？）');
    }
  }

  async function loadTimeline() {
    try {
      const res = await fetch(`${API}/api/timeline`);
      if (!res.ok) throw new Error(`timeline ${res.status}`);
      const data = await res.json();
      const rounds = data.rounds || [];
      setTimeline(rounds);

      if (rounds.length) setTimelineIdx(rounds.length - 1);
    } catch (e) {
      setTimeline([]);
    }
  }

  const loadHeatmap = useCallback(async () => {
    const token = nextRequest('heatmap');
    nextRequest('cell'); nextRequest('context');
    setLoading(true);
    setSelected(null); setMessages([]); setRounds([]);
    setSelectedMessageId(null); setMessageContext(null); setFlowOpen(false);
    setKeywords({ close_keywords: [], far_keywords: [] });
    try {
      const res = await fetch(`${API}/api/heatmap?${commonQuery}&mode=${heatmapMode}`);
      if (!res.ok) throw new Error(`heatmap ${res.status}`);
      const data = await res.json();
      if (isCurrent('heatmap', token)) { setHeatmap(data); setStatus(''); }
    } catch (e) {
      if (isCurrent('heatmap', token)) setStatus('热力图刷新失败，仍显示上次结果。请刷新重试。');
    } finally {
      if (isCurrent('heatmap', token)) setLoading(false);
    }
  }, [commonQuery, heatmapMode]);

  const loadLineChart = useCallback(async () => {
    const token = nextRequest('line');
    try {
      const res = await fetch(`${API}/api/line-chart?${commonQuery}`);
      if (!res.ok) throw new Error(`line-chart ${res.status}`);
      const data = await res.json();
      if (isCurrent('line', token)) setLineChart(data);
    } catch (e) {
      if (isCurrent('line', token)) setStatus('折线图刷新失败，仍显示上次结果。请刷新重试。');
    }
  }, [commonQuery]);

  const loadNetwork = useCallback(async () => {
    const token = nextRequest('network');
    nextRequest('edge');
    setSelectedEdge(null); setEdgeMessages([]); setSelectedNetworkNode(null);
    try {
      const res = await fetch(`${API}/api/network?${networkQuery}`);
      if (!res.ok) throw new Error(`network ${res.status}`);
      const data = await res.json();
      if (isCurrent('network', token)) setNetwork(data);
    } catch (e) {
      if (isCurrent('network', token)) setStatus('网络图刷新失败，仍显示上次结果。请刷新重试。');
    }
  }, [networkQuery]);

  useEffect(() => { loadOptions(); }, []);
  useEffect(() => { loadTimeline(); }, []);

  useEffect(() => {
    fetch(`${API}/api/message-id-map`)
      .then(r => (r.ok ? r.json() : {}))
      .then(loadCommIdMap)
      .catch(() => {});
  }, []);
  useEffect(() => { loadHeatmap(); }, [loadHeatmap]);
  useEffect(() => { loadLineChart(); }, [loadLineChart]);
  useEffect(() => { loadNetwork(); }, [loadNetwork]);

  // Seçili node'un tüm gönderdiği mesajları getir (edge'i olmayan broadcast/root
  // mesajlar dahil — bunlar edge tıklamasıyla görülemiyordu).
  useEffect(() => {
    if (!selectedNetworkNode) { setNodeMessages([]); return; }
    let cancelled = false;
    setNodeMessages([]); setNodeStatus('loading');
    (async () => {
      try {
        const p = new URLSearchParams(networkQuery);
        p.set('agent_id', selectedNetworkNode);
        const res = await fetch(`${API}/api/node-messages?${p.toString()}`);
        if (!res.ok) throw new Error('node messages failed');
        const rows = await res.json();
        if (!cancelled) { setNodeMessages(rows); setNodeStatus(''); setIsNodeDetailCollapsed(false); }
      } catch (e) {
        if (!cancelled) { setNodeMessages([]); setNodeStatus('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedNetworkNode, networkQuery]);

  // ---- crisis timeline playback (Play/Pause) ----
  useEffect(() => {
    if (!playing || timeline.length === 0) return;
    const t = setInterval(() => {
      setTimelineIdx(i => (i >= timeline.length - 1 ? i : i + 1));
    }, 1000);
    return () => clearInterval(t);
  }, [playing, timeline.length]);

  useEffect(() => {

    if (playing && timeline.length && timelineIdx >= timeline.length - 1) setPlaying(false);
  }, [timelineIdx, playing, timeline.length]);

  const togglePlay = () => {
    if (!timeline.length) return;

    if (!playing && timelineIdx >= timeline.length - 1) setTimelineIdx(timelineStartIdx);
    setPlaying(p => !p);
  };

  // cellMap (agent|bucket -> cell)
  const cellMap = useMemo(() => {
    const map = new Map();
    for (const c of heatmap.cells || []) map.set(`${c.agent_id}|${c.bucket}`, c);
    return map;
  }, [heatmap]);

  const sortedAgents = useMemo(() => {
    let agents = (heatmap.agents || []).slice();

    if (agentFilter.length > 0) {
      agents = agents.filter(a => agentFilter.includes(a.agent_id));
    }

    const agg = {};
    for (const a of agents) {
      let total = 0, sentSum = 0, sentN = 0;
      for (const b of (heatmap.time_buckets || [])) {
        const c = cellMap.get(`${a.agent_id}|${b}`);
        if (c) {
          total += c.message_count || 0;
          if (c.bert_sentiment_score !== null && c.bert_sentiment_score !== undefined) {
            sentSum += c.bert_sentiment_score; sentN += 1;
          }
        }
      }
      agg[a.agent_id] = { total, sentiment: sentN ? sentSum / sentN : -Infinity };
    }

    const { key, dir } = heatmapSort;
    agents.sort((x, y) => {
      let cmp = 0;
      if (key === 'agent_id') cmp = x.agent_id.localeCompare(y.agent_id);
      else if (key === 'total') cmp = agg[x.agent_id].total - agg[y.agent_id].total;
      else if (key === 'sentiment') cmp = agg[x.agent_id].sentiment - agg[y.agent_id].sentiment;
      return dir === 'asc' ? cmp : -cmp;
    });
    return agents;
  }, [heatmap, cellMap, heatmapSort, agentFilter]);

  // toggles

  const isInSet = (selection, item) => selection.length === 0 || selection.includes(item);
  const toggleInSet = (setter, allItems, item) => setter(prev => {
    const base = prev.length === 0 ? allItems.slice() : prev.filter(x => x !== '__none__');
    let next = base.includes(item) ? base.filter(x => x !== item) : [...base, item];
    if (allItems.length && allItems.every(x => next.includes(x))) return [];
    return next.length ? next : ['__none__'];
  });
  const agentIds = () => (options.agents || []).map(a => a.agent_id);

  const comboOptions = useMemo(() => {
    const list = options.channel_types || [];
    const typesPerChannel = {};
    list.forEach(o => {
      (typesPerChannel[o.channel] = typesPerChannel[o.channel] || new Set()).add(o.message_type);
    });
    return list.map(o => ({
      key: o.key || `${o.channel}|${o.message_type}`,
      channel: o.channel,
      message_type: o.message_type,
      count: o.count,
      group: visibilityGroupOf(o.channel),
      label: typesPerChannel[o.channel].size > 1
        ? `${channelLabelOf(o.channel)}（${messageTypeLabelOf(o.message_type)}）`
        : channelLabelOf(o.channel),
    }));
  }, [options.channel_types]);
  const allComboKeys = comboOptions.map(c => c.key);
  const comboLabel = (key) => key === '__none__' ? '未选择渠道' : (comboOptions.find(c => c.key === key)?.label) || key;

  const toggleCombo = (t) => toggleInSet(setSelectedCombos, allComboKeys, t);
  const toggleTextSource = (s) => toggleInSet(setSelectedTextSources, options.text_sources || Object.keys(TEXT_SOURCE_LABELS), s);

  const INNER_THOUGHT_SOURCES = ['reacting', 'rationalizing', 'deliberating'];
  const isInnerAllActive = INNER_THOUGHT_SOURCES.every(s => isInSet(selectedTextSources, s));
  const toggleInnerThoughts = () => {
    const allSources = options.text_sources || Object.keys(TEXT_SOURCE_LABELS);
    setSelectedTextSources(prev => {
      const base = prev.length === 0 ? allSources.slice() : prev.filter(x => x !== '__none__');
      const allOn = INNER_THOUGHT_SOURCES.every(s => base.includes(s));
      let next = allOn
        ? base.filter(s => !INNER_THOUGHT_SOURCES.includes(s))
        : Array.from(new Set([...base, ...INNER_THOUGHT_SOURCES]));
      if (allSources.length && allSources.every(s => next.includes(s))) return [];
      return next.length ? next : ['__none__'];
    });
  };

  const combosByGroup = useMemo(() => ({
    external: comboOptions.filter(c => c.group === 'external'),
    internal: comboOptions.filter(c => c.group === 'internal'),
  }), [comboOptions]);

  const isComboActive = (key) => selectedCombos.length === 0 || selectedCombos.includes(key);

  const isGroupAllActive = (groupCombos) => groupCombos.length > 0 && groupCombos.every(c => isComboActive(c.key));

  const toggleGroup = (groupCombos) => {
    const groupKeys = groupCombos.map(c => c.key);
    setSelectedCombos(prev => {
      const base = prev.length === 0 ? allComboKeys.slice() : prev.filter(x => x !== '__none__');
      const allOn = groupKeys.every(k => base.includes(k));
      let next = allOn
        ? base.filter(k => !groupKeys.includes(k))
        : Array.from(new Set([...base, ...groupKeys]));

      if (allComboKeys.length && allComboKeys.every(k => next.includes(k))) return [];
      return next.length ? next : ['__none__'];
    });
  };
  const toggleAgent = (id) => toggleInSet(setAgentFilter, agentIds(), id);

  const heatmapScrollRef = useRef(null);
  const lineScrollRef = useRef(null);
  const seqScrollRef = useRef(null);
  const scrollGuardRef = useRef(false);
  const syncScroll = (srcEl) => {
    if (scrollGuardRef.current || !srcEl) return;
    const panes = [heatmapScrollRef.current, lineScrollRef.current, seqScrollRef.current];
    scrollGuardRef.current = true;
    for (const el of panes) {
      if (el && el !== srcEl && el.scrollLeft !== srcEl.scrollLeft) el.scrollLeft = srcEl.scrollLeft;
    }
    requestAnimationFrame(() => { scrollGuardRef.current = false; });
  };
  const handleHeatmapScroll = () => syncScroll(heatmapScrollRef.current);
  const handleLineScroll = () => syncScroll(lineScrollRef.current);
  const handleSeqScroll = () => syncScroll(seqScrollRef.current);

  const toggleNetCombo = (t) => toggleInSet(setNetCombos, allComboKeys, t);

  const isNetComboActive = (key) => netCombos.length === 0 || netCombos.includes(key);
  const isNetGroupAllActive = (groupCombos) => groupCombos.length > 0 && groupCombos.every(c => isNetComboActive(c.key));
  const toggleNetGroup = (groupCombos) => {
    const groupKeys = groupCombos.map(c => c.key);
    setNetCombos(prev => {
      const base = prev.length === 0 ? allComboKeys.slice() : prev.filter(x => x !== '__none__');
      const allOn = groupKeys.every(k => base.includes(k));
      let next = allOn
        ? base.filter(k => !groupKeys.includes(k))
        : Array.from(new Set([...base, ...groupKeys]));
      if (allComboKeys.length && allComboKeys.every(k => next.includes(k))) return [];
      return next.length ? next : ['__none__'];
    });
  };
  const toggleNetAgent = (id) => toggleInSet(setNetAgentFilter, agentIds(), id);

  const clearAllFilters = () => {
    // heatmap filters
    setSearchKeyword('');
    setMergerOnly(false);
    setSelectedCombos([]);
    setSelectedTextSources([]);
    setAgentFilter([]);
    setHeatmapSort({ key: 'agent_id', dir: 'asc' });
    // network filters
    setNetMirrorsHeatmap(false);
    setNetworkSort({ nodeSize: 'messages' });
    setColorBySentiment(false);
    setNetMergerOnly(false);
    setNetCombos([]);
    setNetAgentFilter([]);

    setPlaying(false);
    setTimelineStartIdx(0);
    if (timeline.length) setTimelineIdx(timeline.length - 1);
  };

  // heatmap cell click → message detail
  async function selectCell(agent, bucket) {
    const token = nextRequest('cell');
    setCellStatus('loading');
    nextRequest('context');
    setMessages([]); setRounds([]); setFlowOpen(false);
    setSelected({ agent, bucket });
    setIsMessageDetailCollapsed(false);

    setSelectedMessageId(null);
    setMessageContext(null);
    setContextStatus('');

    const p = new URLSearchParams(commonQuery);
    p.set('agent_id', agent.agent_id);
    p.set('bucket', bucket);
    p.set('mode', 'both');
    p.set('top_n', '10');

    try {
      const [msgRes, roundRes, keywordRes] = await Promise.all([
        fetch(`${API}/api/messages?${p.toString()}`),
        fetch(`${API}/api/rounds?bucket=${encodeURIComponent(bucket)}&granularity=${granularity}`),
        fetch(`${API}/api/keywords?${p.toString()}`),
      ]);
      if (!msgRes.ok || !roundRes.ok || !keywordRes.ok) throw new Error('detail request failed');
      const [msgs, rnds, kw] = await Promise.all([msgRes.json(), roundRes.json(), keywordRes.json()]);
      if (!isCurrent('cell', token)) return;
      setMessages(msgs); setRounds(rnds); setCellStatus('');
      setKeywords({ close_keywords: kw.close_keywords || [], far_keywords: kw.far_keywords || [] });
    } catch (e) {
      if (!isCurrent('cell', token)) return;
      setCellStatus('error');
      setMessages([]);
      setRounds([]);
      setKeywords({ close_keywords: [], far_keywords: [] });
      setStatus('无法加载消息详情（后端是否正在运行？）');
    }
  }

  const handleSelectNode = useCallback((id) => {
    setSelectedNetworkNode(prev => (prev === id ? null : id));
  }, []);

  const selectEdge = useCallback(async (edge) => {
    const token = nextRequest('edge');
    setEdgeStatus('loading');
    nextRequest('context');
    setEdgeMessages([]); setFlowOpen(false);
    const sourceLabel = AGENTS[edge.source]?.label || edge.source;
    const targetLabel = AGENTS[edge.target]?.label || edge.target;
    // comms_huddle broadcast/action ayrı edge'ler olduğundan message_type,
    // mention edge'ler channel başına bölündüğü için via_channel da key'e girer.
    const key = `${edge.source}>${edge.target}>${edge.channel}${edge.message_type ? '>' + edge.message_type : ''}${edge.via_channel ? '>' + edge.via_channel : ''}`;
    setSelectedEdge({
      key,
      source: edge.source,
      target: edge.target,
      channel: edge.channel,
      message_type: edge.message_type || '',
      via_channel: edge.via_channel || '',
      mention: edge.channel === 'mention',
      sourceLabel,
      targetLabel,
    });
    setIsEdgeDetailCollapsed(false);

    setSelectedMessageId(null);
    setMessageContext(null);
    setContextStatus('');

    const p = new URLSearchParams(networkQuery);
    p.set('source', edge.source);
    p.set('target', edge.target);
    p.set('channel', edge.channel || '');
    if (edge.message_type) p.set('edge_message_type', edge.message_type);
    if (edge.via_channel) p.set('via_channel', edge.via_channel);

    try {
      const res = await fetch(`${API}/api/edge-messages?${p.toString()}`);
      if (!res.ok) throw new Error('edge request failed');
      const rows = await res.json();
      if (isCurrent('edge', token)) { setEdgeMessages(rows); setEdgeStatus(''); }
    } catch (e) {
      if (!isCurrent('edge', token)) return;
      setEdgeStatus('error');
      setEdgeMessages([]);
      setStatus('无法加载连线消息（后端是否正在运行？）');
    }
  }, [networkQuery]);

  async function selectMessage(messageId) {
    if (!messageId) return;
    const token = nextRequest('context');
    setMessageContext(null);
    setSelectedMessageId(messageId);
    setContextStatus('loading');
    setFlowOpen(true); // open the related-messages chat popup immediately
    try {
      const res = await fetch(`${API}/api/messages/${encodeURIComponent(messageId)}/context`);
      if (!res.ok) throw new Error(`context ${res.status}`);
      const data = await res.json();
      if (!isCurrent('context', token)) return;
      setMessageContext(data);
      setContextStatus('');
    } catch (e) {
      if (!isCurrent('context', token)) return;
      setMessageContext(null);
      setContextStatus('error');
    }
  }

  const handleSelectSeqEvent = useCallback((id) => {
    setSeqEventId(cur => (cur === id ? null : id));
  }, []);

  useEffect(() => {
    if (!seqEventId) { setSeqEventMessages([]); setSeqMsgStatus(''); return; }
    const ev = SEQ_EVENTS.find(e => e.id === seqEventId);
    const ids = (ev && ev.related) || [];
    if (!ids.length) { setSeqEventMessages([]); setSeqMsgStatus(''); return; }
    let cancelled = false;
    setSeqMsgStatus('loading');
    (async () => {
      try {
        const p = new URLSearchParams();
        ids.forEach(i => p.append('ids', i));
        const res = await fetch(`${API}/api/messages-by-ids?${p.toString()}`);
        if (!res.ok) throw new Error(`messages-by-ids ${res.status}`);
        const rows = await res.json();
        if (!cancelled) { setSeqEventMessages(rows); setSeqMsgStatus(''); }
      } catch (e) {
        if (!cancelled) { setSeqEventMessages([]); setSeqMsgStatus('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [seqEventId]);

  const onKeywordClick = (kw) => {
    setSearchKeyword(kw);
  };

  async function reloadDb() {
    setStatus('正在刷新数据…');
    await Promise.all([loadOptions(), loadTimeline(), loadHeatmap(), loadLineChart(), loadNetwork()]);
    setStatus('已刷新当前数据。');
  }

  const effectiveNetworkSize = netMirrorsHeatmap
    ? ({ agent_id: 'messages', total: 'messages', sentiment: 'sentiment' }[heatmapSort.key] || 'messages')
    : networkSort.nodeSize;

const HELP_SENTIMENT_SCALE = [
  '情绪使用当前数据附带的词典命中分值，不是 BERT 模型推断；仅作探索线索。',
  '每个格子显示该 Agent 在该时间桶内所有消息的平均分值。',
  '-1 = 最负面，约 0 = 中性，+1 = 最正面。',
  '空格子表示该 Agent 在这段时间没有发送消息。',
].join(' ');

const HELP_NETWORK_FILTER = '这些筛选只作用于网络图，不会改变热力图的统计结果。';

const HELP_EXTERNAL_CHANNEL = '公开动态没有接收者，因此不会形成连线，也不会出现在连线配色里。';

  const heatmapOrder = useMemo(
    () => (sortedAgents || []).map(a => a.agent_id),
    [sortedAgents]
  );

  const displayNetwork = useMemo(() => {
    const filter = netMirrorsHeatmap ? agentFilter : netAgentFilter;
    if (!filter.length) return network;
    const keep = new Set(filter);
    const nodes = (network.nodes || []).filter(n => keep.has(n.id));
    const keepIds = new Set(nodes.map(n => n.id));
    const edges = (network.edges || []).filter(e => keepIds.has(e.source) && keepIds.has(e.target));
    return { ...network, nodes, edges };
  }, [network, netAgentFilter, netMirrorsHeatmap, agentFilter]);

  const cell = CELL[granularity];
  const buckets = heatmap.time_buckets || [];

  // Olay işaretleri (leak / embargo) → bucket eşlemesi. Heatmap kolon başlığında
  // nokta + kolon hücrelerinde renkli sol kenar olarak gösterilir.
  const markersByBucket = useMemo(() => {
    const map = new Map();
    EVENT_MARKERS.forEach(mk => {
      const b = timeToBucket(mk.time, granularity);
      if (!map.has(b)) map.set(b, []);
      map.get(b).push(mk);
    });
    return map;
  }, [granularity]);

  const selectedCellData = selected ? cellMap.get(`${selected.agent.agent_id}|${selected.bucket}`) : null;

  return (
    <div className="app">
      <header className="compact-header">
        <h1>VAST MC1 — Agent 沟通分析</h1>
        <nav className="workspace-nav" aria-label="工作区导航">
          <span className="nav-current">MC1</span>
          <button onClick={() => onDatasetChange('MC2')}>MC2</button>
          <button onClick={() => onDatasetChange('CUSTOM')}>自建数据</button>
          <a href="?mc1=legacy">旧版 MC1 / 扩展工具</a>
          <button className="reload" onClick={reloadDb}><RefreshCcw size={16} /> 刷新数据</button>
        </nav>
      </header>

      <section className="global-controls">
        <span className="gc-label">显示视图：</span>
        <label className="check"><input type="checkbox" checked={showHeatmap} onChange={e => setShowHeatmap(e.target.checked)} /> 热力图</label>
        <label className="check"><input type="checkbox" checked={showSeqFlow} onChange={e => setShowSeqFlow(e.target.checked)} disabled={sideBySide} /> 事件流</label>
        <label className="check"><input type="checkbox" checked={showLineChart} onChange={e => setShowLineChart(e.target.checked)} disabled={sideBySide} /> 折线图</label>
        <label className="check"><input type="checkbox" checked={showNetwork} onChange={e => setShowNetwork(e.target.checked)} /> 网络图</label>
        <button type="button" className={`fp-toggle gc-compare-toggle ${sideBySide ? 'on' : ''}`}
          onClick={() => setSideBySide(v => !v)}
          title="将热力图与网络图并排显示以便对比（开启时会隐藏筛选面板与折线图）。">
          {sideBySide ? '◧ 并排对比：已开启' : '◧ 并排对比'}
        </button>
        <button type="button" className="fp-toggle gc-filters-toggle" disabled={sideBySide} onClick={() => setFiltersOpen(o => !o)}>
          {effFiltersOpen ? '隐藏筛选' : '显示筛选'}
        </button>
        <button type="button" className="fp-toggle gc-clear-filters" onClick={clearAllFilters}
          title="将所有筛选（热力图 + 网络图 + 危机时间轴）恢复默认。日/小时等视图模式保持不变。">
          清空全部筛选
        </button>
        <div className="gc-counts">
          全库含合并关键词：<b>{options.combined_merger_count}</b> / {options.total_count}
          {' · '}内容：{options.merger_count} {' · '}内心想法：{options.internal_merger_count}
        </div>
      </section>

      {/* ============================================
          Crisis timeline slider (drives all three views)
          ============================================ */}
      <CrisisTimeline
        timeline={timeline}
        idx={timelineIdx}
        setIdx={setTimelineIdx}
        startIdx={timelineStartIdx}
        setStartIdx={setTimelineStartIdx}
        playing={playing}
        onTogglePlay={togglePlay}
        granularity={granularity}
        setGranularity={setGranularity}
      />

      <div className="request-status" role="status">{loading ? '正在更新图表…' : status}</div>

      <div className={sideBySide ? 'compare-row' : ''}>
      {(showHeatmap || effShowLineChart || effShowSeqFlow) && (
        <section className={`section heatmap-section ${effFiltersOpen ? '' : 'filters-hidden'}`}>
          {effFiltersOpen && (
          <aside className="filter-panel">
            <div className="fp-title">
              <span>热力图筛选</span>
              <button type="button" className="fp-toggle" onClick={() => setFiltersOpen(false)}>
                收起
              </button>
            </div>

            {(
              <div className="fp-body">
                <div className="control-block">
                  <label>搜索关键词
                    <input type="text" value={searchKeyword} onChange={e => setSearchKeyword(e.target.value)}
                      placeholder="例如 merger、embargo、lawsuit" />
                  </label>
                </div>

                <Collapsible title="热力图模式" defaultOpen={true}>
                  <div className="seg seg-stack">
                    {[['count', '数量热力图'], ['sentiment', '情绪热力图']].map(([v, l]) => (
                      <button key={v} className={`seg-btn ${heatmapMode === v ? 'on' : ''}`} onClick={() => setHeatmapMode(v)}>{l}</button>
                    ))}
                  </div>
                </Collapsible>

                <Collapsible title="消息渠道" defaultOpen={false}>
                  <label className="check select-all-row"><input type="checkbox" checked={selectedCombos.length === 0} onChange={() => setSelectedCombos([])} /> 全部</label>

                  {combosByGroup.external.length > 0 && (
                    <div className="type-group">
                      <label className="check group-head">
                        <input
                          type="checkbox"
                          checked={isGroupAllActive(combosByGroup.external)}
                          onChange={() => toggleGroup(combosByGroup.external)}
                        />
                        外部 <span className="muted small">（面向公众）</span>
                      </label>
                      <div className="type-grid indent">
                        {combosByGroup.external.map(c => (
                          <label className="check" key={c.key}><input type="checkbox" checked={isComboActive(c.key)} onChange={() => toggleCombo(c.key)} /> {c.label}</label>
                        ))}
                      </div>
                    </div>
                  )}

                  {combosByGroup.internal.length > 0 && (
                    <div className="type-group">
                      <label className="check group-head">
                        <input
                          type="checkbox"
                          checked={isGroupAllActive(combosByGroup.internal)}
                          onChange={() => toggleGroup(combosByGroup.internal)}
                        />
                        内部 <span className="muted small">（组织内沟通）</span>
                      </label>
                      <div className="type-grid indent">
                        {combosByGroup.internal.map(c => (
                          <label className="check" key={c.key}><input type="checkbox" checked={isComboActive(c.key)} onChange={() => toggleCombo(c.key)} /> {c.label}</label>
                        ))}
                      </div>
                    </div>
                  )}
                </Collapsible>

                <Collapsible title="文本来源" defaultOpen={false}>
                  <label className="check select-all-row"><input type="checkbox" checked={selectedTextSources.length === 0} onChange={() => setSelectedTextSources([])} /> 全部</label>
                  <div className="type-grid">
                    <label className="check"><input type="checkbox" checked={isInSet(selectedTextSources, 'content')} onChange={() => toggleTextSource('content')} /> {TEXT_SOURCE_LABELS['content']}</label>
                  </div>
                  <div className="type-group">
                    <label className="check group-head">
                      <input type="checkbox" checked={isInnerAllActive} onChange={toggleInnerThoughts} />
                      内心想法 <span className="muted small">（全部 3 类）</span>
                    </label>
                    <div className="type-grid indent">
                      {INNER_THOUGHT_SOURCES.map(s => (
                        <label className="check" key={s}><input type="checkbox" checked={isInSet(selectedTextSources, s)} onChange={() => toggleTextSource(s)} /> {TEXT_SOURCE_LABELS[s] || (s === '__none__' ? '未选择文本来源' : s)}</label>
                      ))}
                    </div>
                  </div>
                </Collapsible>

                <div className="control-block">
                  <div className="merger-check-row">
                    <label className="check merger-check">
                      <input type="checkbox" checked={mergerOnly} onChange={e => setMergerOnly(e.target.checked)} />
                      仅限所选文本来源中含合并关键词的消息
                    </label>
                    <span className="kw-help" tabIndex={0}
                      title={`合并相关关键词：${MERGER_KEYWORDS.join(', ')}`}
                      aria-label={`合并相关关键词：${MERGER_KEYWORDS.join(', ')}`}>?</span>
                  </div>
                </div>

                <Collapsible title="Agent 类型" defaultOpen={false}>
                  <label className="check select-all-row"><input type="checkbox" checked={agentFilter.length === 0} onChange={() => setAgentFilter([])} /> 全部</label>
                  <div className="type-grid">
                    {(options.agents || []).map(a => (
                      <label className="check" key={a.agent_id}>
                        <input type="checkbox" checked={isInSet(agentFilter, a.agent_id)} onChange={() => toggleAgent(a.agent_id)} />
                        <AgentIcon id={a.agent_id} size={15} /> {agentLabelOf(a.agent_id, a.agent_label)}
                      </label>
                    ))}
                  </div>
                </Collapsible>

                <Collapsible title="文本关键词" defaultOpen={true}>
                  {!selected && <div className="muted small">点击热力图单元格，即可从其消息中提取关键词。</div>}
                  {keywords.close_keywords?.length > 0 && (
                    <>
                      <div className="kw-group-label">高频词</div>
                      <div className="chips clickable">
                        {keywords.close_keywords.map(k => (
                          <button key={`c-${k.keyword}`} className="kw-chip" onClick={() => onKeywordClick(k.keyword)} title="搜索该关键词">
                            {k.keyword} <span className="kw-score">{k.count} 次</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </Collapsible>
              </div>
            )}
          </aside>
          )}

          <div className="viz-col">
            {showHeatmap && (
            <div className="heatmap-card">
              <div className="heatmap-title">
                <div>
                  <h2>{granularity === 'daily' ? '按日' : '按小时'} · {heatmapMode === 'count' ? '消息数量' : '情绪热力图'}</h2>
                  <p className="muted small">
                    {selectedCombos.length === 0 ? '全部渠道' : selectedCombos.map(comboLabel).join('、')}
                    {' / '}{selectedTextSources.length === 0 ? '全部文本' : selectedTextSources.map(s => TEXT_SOURCE_LABELS[s] || (s === '__none__' ? '未选择文本来源' : s)).join('、')}
                    {searchKeyword.trim() ? ` / 关键词：${searchKeyword.trim()}` : ''}
                  </p>
                </div>
                {loading && <span className="muted">加载中…</span>}
              </div>

              {/* legend */}
              <div className="legend">
                {heatmapMode === 'count' && <span className="muted small">较少 <span className="lg-swatch" style={{ background: '#e3eefb' }} /><span className="lg-swatch" style={{ background: '#93beec' }} /><span className="lg-swatch" style={{ background: '#558fd8' }} /><span className="lg-swatch" style={{ background: '#1a5cc0' }} /> 较多消息 · 对数刻度 · <span className="lg-swatch" style={{ background: '#edf2f8' }} /> 无数据</span>}
                {heatmapMode === 'sentiment' && <span className="muted small"><span className="lg-swatch" style={{ background: '#e24b4a' }} /> −1 负面 <span className="lg-swatch" style={{ background: '#9aa7b5' }} /> 0 中性 <span className="lg-swatch" style={{ background: '#378ADD' }} /> +1 正面<span className="kw-help" tabIndex={0} title={HELP_SENTIMENT_SCALE} aria-label={HELP_SENTIMENT_SCALE}>?</span></span>}
              </div>

              <div className="heatmap-scroll" ref={heatmapScrollRef} onScroll={handleHeatmapScroll}>
                <div className="heatmap-grid" style={{ gridTemplateColumns: `${LABEL_COL}px repeat(${buckets.length || 1}, ${cell.w}px)`, gridAutoRows: `${cell.h}px` }}>
                  <div className="corner">Agent \ 时间</div>
                  {buckets.map(b => {
                    const mks = markersByBucket.get(b);
                    return (
                      <button key={b}
                        className={`bucket-head ${mks ? 'has-marker' : ''}`}
                        style={mks ? { '--mk-color': mks[0].color } : undefined}
                        title={mks ? `${b} — ${mks.map(m => m.label).join(' · ')}` : b}
                        onClick={() => selectCell({ agent_id: 'ALL', agent_label: '全部 Agent' }, b)}>
                        {shortBucket(b, granularity)}{mks && <span className="mk-dot" />}
                      </button>
                    );
                  })}

                  {sortedAgents.map(agent => (
                    <React.Fragment key={agent.agent_id}>
                      {/* Görünümler arası bağlantı (brushing): satır etiketine tıklayınca
                          network'te aynı agent'ın node'u seçilir; network'te node seçilince
                          de bu satır vurgulanır. Tekrar tıklama seçimi kaldırır. */}
                      <div
                        className={`agent-label ${selectedNetworkNode === agent.agent_id ? 'row-selected' : ''}`}
                        onClick={() => handleSelectNode(agent.agent_id)}
                        title="点击可在网络图中高亮该 Agent（再次点击取消）"
                        role="button" tabIndex={0}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleSelectNode(agent.agent_id); }}>
                        <AgentIcon id={agent.agent_id} size={15} />
                        {agentLabelOf(agent.agent_id, agent.agent_label)}
                      </div>
                      {buckets.map(b => {
                        const c = cellMap.get(`${agent.agent_id}|${b}`);
                        const count = c?.message_count || 0;
                        let style;
                        let title;
                        let cellValue = '';
                        const isSel = selected && selected.agent.agent_id === agent.agent_id && selected.bucket === b;
                        if (heatmapMode === 'count') {
                          const cc = countColor(count, heatmap.max_count);
                          style = { background: cc.bg, opacity: cc.opacity, color: cc.fg };
                          title = `${agentLabelOf(agent.agent_id, agent.agent_label)} ${b}：${count}${searchKeyword.trim() ? ' 条匹配' : ' 条消息'}`;
                        } else {
                          const s = c?.bert_sentiment_score;
                          const cc = sentimentCellColor(count > 0 ? s : null);
                          style = { background: cc.bg, opacity: cc.opacity };
                          title = count === 0 ? `${agentLabelOf(agent.agent_id, agent.agent_label)} ${b}：无消息`
                            : `${agentLabelOf(agent.agent_id, agent.agent_label)} ${b}：情绪 ${s == null ? '—' : s.toFixed(2)}（${count} 条消息）`;
                          cellValue = (count > 0 && s != null) ? fmtSigned(s) : '';
                        }
                        const mks = markersByBucket.get(b);
                        return (
                          <button key={`${agent.agent_id}-${b}`}
                            className={`cell ${heatmapMode !== 'count' ? 'cell-num' : ''} ${isSel ? 'cell-selected' : ''} ${mks ? 'cell-marked' : ''}`}
                            style={mks ? { ...style, '--mk-color': mks[0].color } : style} title={title}
                            onClick={() => selectCell(agent, b)}>
                            {heatmapMode === 'count' ? (count || '') : cellValue}
                          </button>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
            )}

            {/* ---- Message Detail Panel (collapsible, directly under heatmap) ---- */}
            {showHeatmap && (
            <MessageDetailPanel
              selected={selected}
              requestStatus={cellStatus}
              onRetry={() => selected && selectCell(selected.agent, selected.bucket)}
              selectedCellData={selectedCellData}
              collapsed={isMessageDetailCollapsed}
              setCollapsed={setIsMessageDetailCollapsed}
              messages={messages}
              rounds={rounds}
              selectedMessageId={selectedMessageId}
              messageContext={messageContext}
              contextStatus={contextStatus}
              onSelectMessage={selectMessage}
              onOpenFlow={() => setFlowOpen(true)}
            />
            )}

            {effShowSeqFlow && (
              <SequentialFlow
                granularity={granularity}
                buckets={buckets}
                scrollRef={seqScrollRef}
                onScroll={handleSeqScroll}
                selectedEventId={seqEventId}
                onSelectEvent={handleSelectSeqEvent}
                eventMessages={seqEventMessages}
                eventMessagesStatus={seqMsgStatus}
                selectedMessageId={selectedMessageId}
                onSelectMessage={selectMessage}
              />
            )}

            {/* ---- Line Chart (under the detail panel, x-axis aligned with heatmap) ---- */}
            {effShowLineChart && (
              <>
                <div className="lc-series-controls">
                  <span className="control-title">折线图序列：</span>
                  <label className="check"><input type="checkbox" checked={showStockPriceLine} onChange={e => setShowStockPriceLine(e.target.checked)} /> <span className="lg-swatch" style={{ background: '#22d3ee' }} /> 股价</label>
                  <label className="check"><input type="checkbox" checked={showBertSentimentLine} onChange={e => setShowBertSentimentLine(e.target.checked)} /> <span className="lg-swatch" style={{ background: '#f59e0b' }} /> 市场情绪</label>
                </div>
                <StockSentimentLineChart data={lineChart} granularity={granularity}
                  showStock={showStockPriceLine} showSentiment={showBertSentimentLine}
                  scrollRef={lineScrollRef} onScroll={handleLineScroll} />
              </>
            )}
          </div>
        </section>
      )}

      {showNetwork && (
        <section className={`section network-section ${effFiltersOpen ? '' : 'filters-hidden'}`}>
          {effFiltersOpen && (
          <aside className="filter-panel">
            <div className="fp-title">
              <span>网络图筛选<span className="kw-help" tabIndex={0} title={HELP_NETWORK_FILTER} aria-label={HELP_NETWORK_FILTER}>?</span></span>
              <button type="button" className="fp-toggle" onClick={() => setFiltersOpen(false)}>
                收起
              </button>
            </div>

            {(
              <div className="fp-body">
                {/* 与热力图筛选面板结构一致：每个筛选都在自己的折叠标题下，点击展开。 */}
                <Collapsible title="消息渠道" defaultOpen={false}>
                  {netMirrorsHeatmap && <div className="muted small">正在镜像热力图——这些网络筛选直接取自热力图。</div>}
                  <div className={netMirrorsHeatmap ? 'disabled' : ''}>
                  <label className="check select-all-row"><input type="checkbox" checked={netCombos.length === 0} onChange={() => setNetCombos([])} /> 全部</label>
                  {combosByGroup.external.length > 0 && (
                    <div className="type-group">
                      <div className="merger-check-row">
                        <label className="check group-head">
                          <input type="checkbox" checked={isNetGroupAllActive(combosByGroup.external)} onChange={() => toggleNetGroup(combosByGroup.external)} />
                          外部 <span className="muted small">（面向公众）</span>
                        </label>
                        <span className="kw-help" tabIndex={0} title={HELP_EXTERNAL_CHANNEL} aria-label={HELP_EXTERNAL_CHANNEL}>?</span>
                      </div>
                      <div className="type-grid indent">
                        {combosByGroup.external.map(c => (
                          <label className="check" key={`net-${c.key}`}>
                            <input type="checkbox" checked={isNetComboActive(c.key)} onChange={() => toggleNetCombo(c.key)} />
                            {c.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  {combosByGroup.internal.length > 0 && (
                    <div className="type-group">
                      <label className="check group-head">
                        <input type="checkbox" checked={isNetGroupAllActive(combosByGroup.internal)} onChange={() => toggleNetGroup(combosByGroup.internal)} />
                        内部 <span className="muted small">（组织内沟通）</span>
                      </label>
                      <div className="type-grid indent">
                        {combosByGroup.internal.map(c => (
                          <label className="check" key={`net-${c.key}`}>
                            <input type="checkbox" checked={isNetComboActive(c.key)} onChange={() => toggleNetCombo(c.key)} />
                            <span className="edge-swatch" style={{ background: channelColor(c.channel, c.message_type) }} /> {c.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  </div>
                </Collapsible>

                <Collapsible title="Agent 类型" defaultOpen={false}>
                  {netMirrorsHeatmap && <div className="muted small">正在镜像热力图——直接取自热力图。</div>}
                  <div className={netMirrorsHeatmap ? 'disabled' : ''}>
                  <label className="check select-all-row"><input type="checkbox" checked={netAgentFilter.length === 0} onChange={() => setNetAgentFilter([])} /> 全部</label>
                  <div className="type-grid">
                    {(options.agents || []).map(a => (
                      <label className="check" key={`net-a-${a.agent_id}`}>
                        <input type="checkbox" checked={isInSet(netAgentFilter, a.agent_id)} onChange={() => toggleNetAgent(a.agent_id)} />
                        <AgentIcon id={a.agent_id} size={15} /> {agentLabelOf(a.agent_id, a.agent_label)}
                      </label>
                    ))}
                  </div>
                  </div>
                </Collapsible>

                <div className="control-block">
                  {netMirrorsHeatmap && <div className="muted small">正在镜像热力图——直接取自热力图。</div>}
                  <div className="merger-check-row">
                    <label className={`check merger-check ${netMirrorsHeatmap ? 'disabled' : ''}`}>
                      <input type="checkbox" checked={netMergerOnly} disabled={netMirrorsHeatmap}
                        onChange={e => setNetMergerOnly(e.target.checked)} />
                      仅含合并关键词
                    </label>
                    <span className="kw-help" tabIndex={0}
                      title={`合并相关关键词：${MERGER_KEYWORDS.join(', ')}`}
                      aria-label={`合并相关关键词：${MERGER_KEYWORDS.join(', ')}`}>?</span>
                  </div>
                </div>

                <Collapsible title="布局与度量" defaultOpen={false}>
                  <div className="control-title">布局</div>
                  <div className="seg">
                    {[['force', '默认'], ['circle', '环形']].map(([v, l]) => (
                      <button key={v} className={`seg-btn ${networkLayout === v ? 'on' : ''}`}
                        onClick={() => setNetworkLayout(v)}>{l}</button>
                    ))}
                  </div>
                  {netMirrorsHeatmap && <div className="muted small">正在镜像热力图——节点大小 / 连线粗细 / 配色都跟随热力图。</div>}
                  <div className="control-title">节点大小</div>
                  <div className={`seg seg-stack ${netMirrorsHeatmap ? 'disabled' : ''}`}>
                    {[['messages', '消息数量'], ['merger', '含合并关键词数量'], ['sentiment', '情绪分值']].map(([v, l]) => (
                      <button key={v} className={`seg-btn ${networkSort.nodeSize === v ? 'on' : ''}`} disabled={netMirrorsHeatmap}
                        onClick={() => setNetworkSort(s => ({ ...s, nodeSize: v }))}>{l}</button>
                    ))}
                  </div>
                </Collapsible>

                {netMirrorsHeatmap && (
                  <div className="follow-note">网络图镜像热力图的筛选与排序（{heatmapSort.key}，{heatmapSort.dir}）。节点编号 #1…#N 与热力图行序一致。</div>
                )}

                <Collapsible title="选中节点" defaultOpen={true}>
                  {!selectedNetworkNode && <div className="muted small">点击节点可查看其统计信息。</div>}
                  {selectedNetworkNode && (() => {
                    const n = (displayNetwork.nodes || []).find(x => x.id === selectedNetworkNode);
                    if (!n) return <div className="muted small">暂无数据。</div>;
                    return (
                      <div className="node-detail">
                        <div className="nd-name">{agentLabelOf(n.id, n.label)}</div>
                        <div className="nd-row"><span>消息数</span><b>{n.message_count}</b></div>
                        <div className="nd-row"><span>含合并关键词</span><b>{n.merger_related_count}</b></div>
                        <div className="nd-row"><span>情绪分值</span><b>{n.bert_sentiment_score == null ? '—' : n.bert_sentiment_score.toFixed(2)}</b></div>
                      </div>
                    );
                  })()}
                </Collapsible>
              </div>
            )}
          </aside>
          )}

          <div className="viz-col">
            <div className="network-card">
              <div className="heatmap-title">
                <div className="nv-head-left">
                  <h2>沟通网络（回复关系图）</h2>
                  <span className="muted small">{(displayNetwork.nodes || []).length} 个 Agent · {displayNetwork.edges?.length || 0} 条连线</span>
                </div>
                <div className="nv-head-right">
                  <div className="netmode-toggles" role="group" aria-label="网络图模式">
                    <label className="check netmode-toggle" title="筛选条件、排序与节点大小都改用热力图自身的设置，而不是网络图自己的筛选。">
                      <input type="checkbox" checked={netMirrorsHeatmap} onChange={e => setNetMirrorsHeatmap(e.target.checked)} />
                      镜像热力图筛选
                    </label>
                  </div>
                </div>
              </div>
              {/* 网络图始终跟随危机时间轴：小型播放 HUD 让轮次 / 日期 / 标题与播放控制
                  直接显示在网络图上方。 */}
              <p className="provenance-note">实线仅包含明确且时间有效的回复，虚线为正文点名；未来引用保留在消息原文中。</p>
              <div className="net-vis-stack">
                {timeline.length > 0 && (
                  <div className="net-time-hud">
                    <button className={`tl-play ${playing ? 'playing' : ''}`} onClick={togglePlay}
                      title={playing ? '暂停' : '播放危机时间轴'}>
                      {playing ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                    <input type="range" className="nth-range" min={0} max={timeline.length - 1} step={1}
                      value={timelineIdx}
                      onChange={e => setTimelineIdx(Math.max(Number(e.target.value), timelineStartIdx))}
                      aria-label="时间轴轮次（网络图 HUD）" />
                    <div className="nth-info">
                      <span className="nth-round">
                        轮次 {timelineStartIdx + 1}–{timelineIdx + 1} / {timeline.length}
                        <span className="nth-date">{' '}· {fmtRoundLabel(timeline[timelineIdx]?.hour)}</span>
                      </span>
                      {timeline[timelineIdx]?.event_headline && (
                        <span className="nth-headline">{timeline[timelineIdx].event_headline}</span>
                      )}
                    </div>
                  </div>
                )}
              <NetworkVisualization
                data={displayNetwork}
                layout={networkLayout}
                sizeMetric={effectiveNetworkSize}
                edgeMetric="weight"
                colorBySentiment={netMirrorsHeatmap ? heatmapSort.key === 'sentiment' : colorBySentiment}
                selectedNode={selectedNetworkNode}
                onSelectNode={handleSelectNode}
                selectedEdge={selectedEdge?.key}
                onSelectEdge={selectEdge}
                followingHeatmapSort={netMirrorsHeatmap}
                heatmapOrder={heatmapOrder}
                heatmapSortKey={heatmapSort.key}
                heatmapSortDir={heatmapSort.dir}
              />
              </div>
              {netMirrorsHeatmap && (
                <div className="muted small net-follow-note">
                  镜像热力图：筛选已同步 · 节点大小 = {effectiveNetworkSize} ·
                  {' '}按 {{ agent_id: 'Agent 名称', total: '消息总数', sentiment: '平均情绪' }[heatmapSort.key]} 编号 #1…#{heatmapOrder.length}（{heatmapSort.dir}）
                  {' '}· 时间窗口跟随危机时间轴
                </div>
              )}

              {/* ---- Node Messages Panel: seçili node'un TÜM mesajları
                   (broadcast/root dahil — edge tıklamasıyla erişilemeyenler) ---- */}
              {selectedNetworkNode && (
                <NodeMessagesPanel
                  node={{ id: selectedNetworkNode, label: AGENTS[selectedNetworkNode]?.label || selectedNetworkNode }}
                  messages={nodeMessages}
                  requestStatus={nodeStatus}
                  collapsed={isNodeDetailCollapsed}
                  setCollapsed={setIsNodeDetailCollapsed}
                  selectedMessageId={selectedMessageId}
                  contextStatus={contextStatus}
                  onSelectMessage={selectMessage}
                  onOpenFlow={() => setFlowOpen(true)}
                />
              )}

              {/* ---- Edge Messages Panel (collapsible, directly under the network graph) ---- */}
              <EdgeMessagesPanel
                selectedEdge={selectedEdge}
                requestStatus={edgeStatus}
                messages={edgeMessages}
                collapsed={isEdgeDetailCollapsed}
                setCollapsed={setIsEdgeDetailCollapsed}
                selectedMessageId={selectedMessageId}
                messageContext={messageContext}
                contextStatus={contextStatus}
                onSelectMessage={selectMessage}
                onOpenFlow={() => setFlowOpen(true)}
              />
            </div>
          </div>
        </section>
      )}
      </div>

      <ConversationFlowModal
        open={flowOpen}
        context={messageContext}
        status={contextStatus}
        selectedMessageId={selectedMessageId}
        onClose={() => setFlowOpen(false)}
        onSelectMessage={selectMessage}
      />
    </div>
  );
}
