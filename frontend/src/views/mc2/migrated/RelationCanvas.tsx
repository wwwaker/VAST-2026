import { ZoomIn, ZoomOut, Search } from "lucide-react";
import { barShade } from "../../shared/MetricBars";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import cytoscape from "cytoscape";
import type { Edge, RelationData } from "./workspaceApi";
import { relationName } from "./workspaceApi";
import { EntityLabel, EntityLegend, entityName } from "./EntityLabel";
import { number } from "./shared";
import { arrange, edgeVisual, edgeWidth, familyNames, oneHop, type GraphView } from "./relationLayout";

export const edgeKey = (e: Edge) => JSON.stringify([e.source, e.target, e.relation, e.action]);
export function RelationOverview({ data, choose }: { data: RelationData; choose: (role: string) => void }) {
  return <div className="w-relation-overview"><p className="mc2-note">选择一种关系，查看具体对象。每项按不同事件计数，同一事件可以出现在多项中。</p><div className="w-relation-categories">{data.relation_counts.map(role => {
    const edges = data.edges.filter(e => e.relation === role.relation);
    const pairs = [...new Set(edges.map(e => `${entityName(e.source, data.nodes.find(n => n.id === e.source)?.label).split(" · ")[0]} → ${entityName(e.target, data.nodes.find(n => n.id === e.target)?.label).split(" · ")[0]}`))];
    return <button key={role.relation} style={{ "--relation-color": edgeVisual(edges[0]).color } as CSSProperties} onClick={() => choose(role.relation)}><span className="w-relation-category-title">{role.label}<b>{number(role.count)} 条 →</b></span><span>{pairs.join("；")}</span></button>;
  })}</div></div>;
}

export function RelationCanvas({ data, selected, onEdge, onNode, focused = "", viewKey, cache }: {
  data: RelationData; selected?: Edge; onEdge: (e: Edge) => void; onNode: (id: string) => void;
  focused?: string; viewKey: string; cache: Map<string, GraphView>;
}) {
  const host = useRef<HTMLDivElement>(null), cy = useRef<cytoscape.Core>();
  const callbacks = useRef({ onEdge, onNode }); callbacks.current = { onEdge, onNode };
  const activeView = useRef(viewKey);
  const [hover, setHover] = useState<Edge | null>(null);
  const [expanded, setExpanded] = useState(false);
  const actualFocus = data.nodes.some(n => n.id === focused) ? focused : "";
  // Dense networks open as an explicitly labelled one-hop view, with full matrix
  // and full graph still available. No sampled edges are presented as complete.
  const dense = data.nodes.length > 20 && data.edges.length > data.nodes.length * 4;
  const center = actualFocus || (dense && !expanded ? selected?.source ?? data.edges[0]?.source : "");
  const shown = center ? oneHop(data, center) : data;
  const current = useRef({ data: shown, viewKey }); current.current = { data: shown, viewKey };
  useEffect(() => { setExpanded(false); setHover(null); }, [viewKey]);
  useEffect(() => {
    if (!host.current) return;
    const graph = cytoscape({ container: host.current, elements: [], layout: { name: "preset" }, minZoom: .15, maxZoom: 3,
      userZoomingEnabled: true, boxSelectionEnabled: false,
      style: [
        { selector: "node", style: { label: "data(label)", "background-color": "#e6eff8", "border-color": "#608cb8", "border-width": 1.5, width: 36, height: 36, color: "#294c70", "font-size": 11, "text-valign": "bottom", "text-margin-y": 9, "text-wrap": "wrap", "text-max-width": "125px" } },
        { selector: 'node[kind="person"]', style: { shape: "ellipse", "background-color": "#e4f2ee", "border-color": "#478d7b" } },
        { selector: 'node[kind="agent"]', style: { shape: "round-rectangle", "background-color": "#eee6f6", "border-color": "#8862b4" } },
        { selector: 'node[kind="file_path"]', style: { shape: "rectangle", width: 46, "background-color": "#fff1dc", "border-color": "#c98e3e" } },
        { selector: 'node[kind="missing"], node[kind="unknown"]', style: { shape: "diamond", "border-style": "dashed", "background-color": "#f2f3f5" } },
        { selector: "edge", style: { width: "data(weight)", "line-color": "data(color)", "line-style": (edge: cytoscape.EdgeSingular) => edge.data("lineStyle") as "solid" | "dashed", "target-arrow-color": "data(color)", "target-arrow-shape": "triangle", "arrow-scale": .75, "curve-style": "bezier", "control-point-step-size": 38, "loop-direction": "data(loopDirection)", "loop-sweep": "48deg", opacity: .65, "overlay-padding": 7 } },
        { selector: "edge:selected, edge.hover", style: { opacity: 1, label: "data(label)", "font-size": 11, "text-rotation": "autorotate", "text-background-color": "#fff", "text-background-opacity": 1, "text-background-padding": "3px", color: "#294c70", "underlay-color": "data(color)", "underlay-opacity": .12, "underlay-padding": 4 } },
        { selector: "node:selected, node.focused", style: { "border-color": "#d58c27", "border-width": 3 } },
      ] });
    cy.current = graph;
    graph.on("tap", "edge", event => callbacks.current.onEdge(event.target.data("raw")));
    graph.on("tap", "node", event => callbacks.current.onNode(event.target.id()));
    graph.on("tap", event => { if (event.target === graph) callbacks.current.onNode(""); });
    graph.on("mouseover", "edge", event => { event.target.addClass("hover"); setHover(event.target.data("raw")); });
    graph.on("mouseout", "edge", event => { event.target.removeClass("hover"); setHover(null); });
    const save = () => cache.set(activeView.current, { positions: new Map([...(cache.get(activeView.current)?.positions ?? []), ...graph.nodes().map(n => [n.id(), { ...n.position() }] as const)]), zoom: graph.zoom(), pan: { ...graph.pan() } });
    graph.on("dragfree pan zoom", save);
    const resize = new ResizeObserver(() => graph.resize()); resize.observe(host.current);
    const refreshCoordinates = () => graph.resize();
    const element = host.current;
    window.addEventListener("scroll", refreshCoordinates, true);
    element.addEventListener("mousedown", refreshCoordinates, true);
    element.addEventListener("wheel", refreshCoordinates, { capture: true, passive: true });
    return () => { save(); window.removeEventListener("scroll", refreshCoordinates, true); element.removeEventListener("mousedown", refreshCoordinates, true); element.removeEventListener("wheel", refreshCoordinates, true); resize.disconnect(); graph.destroy(); cy.current = undefined; };
  }, [cache]);
  useEffect(() => {
    const graph = cy.current; if (!graph) return;
    const changedView = activeView.current !== viewKey;
    const saved = cache.get(viewKey);
    const existing = changedView ? new Map() : new Map(graph.nodes().map(n => [n.id(), { ...n.position() }]));
    const positions = arrange(shown, new Map([...(saved?.positions ?? []), ...existing]));
    const max = Math.max(1, ...data.edges.map(e => e.count));
    const loops = new Map<string, number>();
    const elements = [...shown.nodes.map(n => ({ data: { id: n.id, label: entityName(n.id, n.label), kind: n.entity_type }, position: positions.get(n.id) })), ...shown.edges.map(e => {
      const visual = edgeVisual(e), loop = loops.get(e.source) ?? 0; if (e.source === e.target) loops.set(e.source, loop + 1);
      return { data: { id: edgeKey(e), source: e.source, target: e.target, label: `${relationName[e.relation] ?? e.relation} · ${e.action} · ${e.count}`, color: visual.color, lineStyle: visual.dashed ? "dashed" : "solid", weight: edgeWidth(e.count, max), loopDirection: `${-45 + loop * 55}deg`, raw: e } };
    })];
    const ids = new Set(elements.map(e => e.data.id));
    graph.batch(() => {
      graph.elements().filter(e => !ids.has(e.id())).remove();
      for (const element of elements) {
        const old = graph.getElementById(element.data.id);
        if (old.length) old.data(element.data); else graph.add(element);
      }
      graph.nodes().forEach(n => { const position = positions.get(n.id()); if (position) n.position(position); });
    });
    activeView.current = viewKey;
    graph.resize();
    if (changedView && saved?.zoom && saved.pan) { graph.zoom(saved.zoom); graph.pan(saved.pan); }
    else if (changedView || !existing.size || center) graph.fit(undefined, 55);
    cache.set(viewKey, { positions: new Map([...(saved?.positions ?? []), ...positions]), zoom: graph.zoom(), pan: { ...graph.pan() } });
  }, [data, viewKey, cache, center, expanded]);
  useEffect(() => {
    const graph = cy.current; if (!graph) return;
    graph.elements().unselect().removeClass("focused");
    if (selected) graph.getElementById(edgeKey(selected)).select();
    if (actualFocus) graph.getElementById(actualFocus).addClass("focused");
  }, [selected, actualFocus, data, center, expanded]);
  const zoom = (factor: number) => { const graph = cy.current; if (!graph) return; graph.resize(); graph.zoom({ level: Math.max(.15, Math.min(3, graph.zoom() * factor)), renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 } }); };
  const families = [...new Set(shown.edges.map(e => edgeVisual(e).family))];
  return <><div className="w-graph-scope"><span>{center ? `局部关系：${entityName(center, data.nodes.find(n => n.id === center)?.label)} · ` : "全部关系 · "}{shown.nodes.length}/{data.nodes.length} 个节点 · {shown.edges.length}/{data.edges.length} 类关系组合</span>{center && <button onClick={() => { callbacks.current.onNode(""); setExpanded(true); }}>查看全部关系</button>}</div>
    <div className="w-canvas-frame"><div className="w-graph-tools w-canvas-tools"><button aria-label="放大关系图" onClick={() => zoom(1.25)}><ZoomIn size={15}/></button><button aria-label="缩小关系图" onClick={() => zoom(.8)}><ZoomOut size={15}/></button><button onClick={() => { cy.current?.resize(); cy.current?.fit(undefined, 55); }}>适合画布</button><details><summary>布局</summary><button onClick={() => { const graph = cy.current; if (!graph) return; cache.delete(viewKey); const positions = arrange(current.current.data); graph.nodes().forEach(n => { n.position(positions.get(n.id())!); }); graph.fit(undefined, 55); cache.set(viewKey, { positions, zoom: graph.zoom(), pan: { ...graph.pan() } }); }}>重新布局</button></details></div><div className="w-relation-canvas" ref={host} aria-label="有向关系画布，可拖动节点和缩放" />{hover && <div className="w-edge-tooltip">{relationName[hover.relation]} · {number(hover.count)} 条 · {hover.action}</div>}</div>
    <div className="w-relation-color-legend">{families.map(family => <span key={family}><i style={{ background: edgeVisual(shown.edges.find(e => edgeVisual(e).family === family)!).color }}/>{familyNames[family]}</span>)}<span>虚线：删除动作或缺失来源；线宽：事件数量</span></div><EntityLegend/><p className="mc2-note">拖动画布平移，滚轮缩放。点击节点查看一跳关系，点击边查看记录；局部查看不改变全局筛选。</p></>;
}

export type MatrixView = { sort: string; left: number; top: number; cell: number };
export function RelationMatrix({ data, selected, onEdge, cache, viewKey }: { data: RelationData; selected?: Edge; onEdge: (e: Edge) => void; cache: Map<string, MatrixView>; viewKey: string }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState(cache.get(viewKey)?.sort ?? "name");
  const [cell, setCell] = useState(cache.get(viewKey)?.cell ?? 26);
  const [search, setSearch] = useState(""), [located, setLocated] = useState("");
  const [previousView, setPreviousView] = useState(viewKey);
  if (previousView !== viewKey) {
    const previous = cache.get(viewKey);
    setPreviousView(viewKey); setSort(previous?.sort ?? "name"); setCell(previous?.cell ?? 26); setSearch(""); setLocated("");
  }
  useLayoutEffect(() => {
    if (!scroll.current) return;
    const saved = cache.get(viewKey);
    scroll.current.scrollLeft = saved?.left ?? 0; scroll.current.scrollTop = saved?.top ?? 0;
  }, [viewKey, cache]);
  const save = () => { cache.set(viewKey, { sort, cell, left: scroll.current?.scrollLeft ?? 0, top: scroll.current?.scrollTop ?? 0 }); };
  useEffect(save, [sort, cell, viewKey, cache]);
  const model = useMemo(() => {
    const nodes = new Map(data.nodes.map(n => [n.id, n]));
    const ranks = new Map<string, number>(), sources = new Set<string>(), targets = new Set<string>();
    const grouped = new Map<string, { edges: Edge[]; count: number }>();
    for (const edge of data.edges) {
      sources.add(edge.source); targets.add(edge.target);
      for (const id of new Set([edge.source, edge.target])) ranks.set(id, (ranks.get(id) ?? 0) + edge.count);
      const key = JSON.stringify([edge.source, edge.target]);
      const value = grouped.get(key) ?? { edges: [], count: 0 };
      value.edges.push(edge); value.count += edge.count; grouped.set(key, value);
    }
    const name = (id: string) => entityName(id, nodes.get(id)?.label);
    const ids = [...new Set([...sources, ...targets])].sort((a, b) => (sort === "count" ? (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0) : 0) || name(a).localeCompare(name(b)) || a.localeCompare(b));
    return { nodes, name, sources: ids.filter(id => sources.has(id)), targets: ids.filter(id => targets.has(id)), grouped,
      max: Math.max(1, ...[...grouped.values()].map(value => value.count)) };
  }, [data, sort]);
  const [pair, setPair] = useState<Edge[]>([]);
  useEffect(() => { setPair([]); }, [data, viewKey]);
  const axis = (id: string) => <EntityLabel id={id} label={model.nodes.get(id)?.label} kind={model.nodes.get(id)?.entity_type}/>;
  const locate = () => {
    const q = search.trim().toLocaleLowerCase();
    const id = [...new Set([...model.sources, ...model.targets])].find(id => model.name(id).toLocaleLowerCase().includes(q));
    if (!q || !id) { setLocated(q ? "__not_found__" : ""); return; }
    setLocated(id);
    if (scroll.current) {
      scroll.current.scrollLeft = Math.max(0, model.targets.indexOf(id) * (cell + 1) - cell);
      scroll.current.scrollTop = Math.max(0, model.sources.indexOf(id) * (cell + 1) - cell);
      save();
    }
  };
  return <><div className="w-graph-tools w-matrix-tools"><span>完整 {model.sources.length} 行 × {model.targets.length} 列 · 连续滚动</span><label>排序<select aria-label="矩阵排序" value={sort} onChange={e => { setSort(e.target.value); setLocated(""); if (scroll.current) { scroll.current.scrollTop = 0; scroll.current.scrollLeft = 0; } }}><option value="name">名称</option><option value="count">关系量</option></select></label><label>格子<input aria-label="矩阵格子尺寸" type="range" min="14" max="38" value={cell} onChange={e => setCell(Number(e.target.value))}/></label><button onClick={() => setCell(Math.max(14, Math.min(38, Math.floor(((scroll.current?.clientWidth || 800) - 172) / Math.max(1, model.targets.length)) - 1)))}>适合宽度</button></div>
    <form className="w-matrix-locate" onSubmit={e => { e.preventDefault(); locate(); }}><input aria-label="定位矩阵对象" placeholder="输入姓名或对象名称，定位行／列" value={search} onChange={e => setSearch(e.target.value)}/><button type="submit"><Search size={13}/>定位</button><span role="status">{located === "__not_found__" ? "未找到此对象" : located ? `已定位 ${model.name(located)}` : "行：来源 · 列：目标；表头保持可见"}</span></form>
    <div className="w-matrix-scroll" ref={scroll} onScroll={save} tabIndex={0} aria-label="有向关系矩阵" style={{ "--matrix-cell": `${cell}px` } as CSSProperties}><table className="w-relation-matrix"><thead><tr><th>来源 ↓ / 目标 →</th>{model.targets.map(id => <th key={id} className={located === id ? "is-located" : ""} title={model.name(id)}>{axis(id)}</th>)}</tr></thead><tbody>{model.sources.map(id => <tr key={id}><th className={located === id ? "is-located" : ""} title={model.name(id)}>{axis(id)}</th>{model.targets.map(target => {
      const value = model.grouped.get(JSON.stringify([id, target]));
      if (!value) return <td key={target} className="w-matrix-zero"/>;
      const { edges, count } = value;
      return <td key={target}><button className={selected?.source === id && selected.target === target ? "selected" : ""} title={`${model.name(id)} → ${model.name(target)} · ${count} 条类型记录${edges.length > 1 ? '（多种动作，点击区分）' : ''}`} aria-label={`${model.name(id)} → ${model.name(target)} ${count}`} style={{ background: barShade("#638a98", Math.log1p(count) / Math.log1p(model.max)), color: Math.log1p(count) / Math.log1p(model.max) > .65 ? "white" : "#294c70" }} onClick={() => { setPair(edges); if (edges.length === 1) onEdge(edges[0]); }}>{cell >= 24 ? count : ""}</button></td>;
    })}</tr>)}</tbody></table></div>{pair.length > 1 && <div className="w-pair-types"><span>该组合包含多种动作，请选择：</span>{pair.map(e => <button key={edgeKey(e)} onClick={() => onEdge(e)}>{relationName[e.relation]} · {e.action} · {number(e.count)}</button>)}</div>}<EntityLegend/><p className="mc2-note">所有关系参与统一对数刻度；缩小格子后悬停查看数量。空白格为0，缺失来源单列；不同动作分别查证。</p></>;
}
