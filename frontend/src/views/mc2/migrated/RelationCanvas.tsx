import { useEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import type { Edge, RelationData } from "./workspaceApi";
import { relationName } from "./workspaceApi";
import { EntityLabel, EntityLegend, entityName } from "./EntityLabel";
import { displayId, number } from "./shared";

export const edgeKey = (e: Edge) => JSON.stringify([e.source, e.target, e.relation, e.action]);
export function RelationCanvas({ data, selected, onEdge, onNode, viewKey, cache }: { data: RelationData; selected?: Edge; onEdge: (e: Edge) => void; onNode: (id: string) => void; viewKey: string; cache: Map<string, { positions: Map<string, { x: number; y: number }>; zoom?: number; pan?: { x: number; y: number } }> }) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core>();
  const callbacks = useRef({ onEdge, onNode }); callbacks.current = { onEdge, onNode };
  const positions = useRef(new Map<string, cytoscape.Position>());
  const [focused, setFocused] = useState("");
  useEffect(() => {
    if (!host.current) return;
    const cached = cache.get(viewKey);
    positions.current = cached?.positions ?? new Map();
    const people = data.nodes.filter(n => n.entity_type !== "file_path");
    const nodes = data.nodes.map((n, i) => ({ data: { id: n.id, label: entityName(n.id, n.label), kind: n.entity_type }, position: positions.current.get(`${viewKey}:${n.id}`) ?? (data.mode === "operations" ? n.entity_type === "file_path" ? { x: 520, y: 60 + Math.max(0, people.length - 1) * 40 } : { x: 120, y: 60 + people.indexOf(n) * 80 } : { x: 120 + (i % 6) * 160, y: 60 + Math.floor(i / 6) * 90 }) }));
    const graph = cytoscape({ container: host.current, elements: [...nodes, ...data.edges.map(e => ({ data: { id: edgeKey(e), source: e.source, target: e.target, label: `${relationName[e.relation] ?? e.relation} · ${e.count}`, weight: 1 + Math.min(7, Math.log1p(e.count)), raw: e } }))],
      layout: { name: "preset" }, minZoom: .15, maxZoom: 3, userZoomingEnabled: true, boxSelectionEnabled: false,
      style: [
        { selector: "node", style: { label: "data(label)", "background-color": "#e6eff8", "border-color": "#608cb8", "border-width": 1.5, width: 34, height: 34, color: "#294c70", "font-size": 11, "text-valign": "bottom", "text-margin-y": 8, "text-wrap": "wrap", "text-max-width": "130px" } },
        { selector: 'node[kind="person"]', style: { shape: "ellipse", "background-color": "#e4f2ee", "border-color": "#478d7b" } },
        { selector: 'node[kind="agent"]', style: { shape: "round-rectangle", "background-color": "#eee6f6", "border-color": "#8862b4" } },
        { selector: 'node[kind="file_path"]', style: { shape: "rectangle", width: 46, "background-color": "#fff1dc", "border-color": "#c98e3e" } },
        { selector: 'node[kind="missing"]', style: { shape: "diamond", "border-style": "dashed", "background-color": "#f2f3f5" } },
        { selector: "edge", style: { width: "data(weight)", "line-color": "#9bb4ca", "target-arrow-color": "#7a99b6", "target-arrow-shape": "triangle", "curve-style": "bezier", opacity: .65 } },
        { selector: "edge:selected", style: { "line-color": "#d58c27", "target-arrow-color": "#d58c27", opacity: 1, label: "data(label)", "font-size": 11, "text-background-color": "#fff", "text-background-opacity": 1, color: "#80520f" } },
        { selector: "node:selected", style: { "border-color": "#d58c27", "border-width": 4 } },
        { selector: ".dim", style: { opacity: .12 } },
      ] });
    cy.current = graph;
    if (cached?.zoom && cached.pan) { graph.zoom(cached.zoom); graph.pan(cached.pan); } else graph.fit(undefined, 40);
    graph.on("tap", "edge", e => callbacks.current.onEdge(e.target.data("raw")));
    graph.on("tap", "node", e => {
      const node = e.target; graph.elements().removeClass("dim"); graph.elements().difference(node.closedNeighborhood()).addClass("dim");
      setFocused(node.id()); callbacks.current.onNode(node.id());
    });
    graph.on("tap", e => { if (e.target === graph) { graph.elements().removeClass("dim"); setFocused(""); } });
    const resize = new ResizeObserver(() => graph.resize()); resize.observe(host.current);
    // parentNode traversal in Cytoscape stops at ShadowRoot, missing outer scroll.
    const refreshCoordinates = () => graph.resize();
    const element = host.current;
    window.addEventListener("scroll", refreshCoordinates, true);
    element.addEventListener("mousedown", refreshCoordinates, true);
    element.addEventListener("wheel", refreshCoordinates, { capture: true, passive: true });
    element.addEventListener("touchstart", refreshCoordinates, { capture: true, passive: true });
    return () => { window.removeEventListener("scroll", refreshCoordinates, true); element.removeEventListener("mousedown", refreshCoordinates, true); element.removeEventListener("wheel", refreshCoordinates, true); element.removeEventListener("touchstart", refreshCoordinates, true); graph.nodes().forEach(n => { positions.current.set(`${viewKey}:${n.id()}`, n.position()); }); cache.set(viewKey, { positions: positions.current, zoom: graph.zoom(), pan: graph.pan() }); resize.disconnect(); graph.destroy(); cy.current = undefined; };
  }, [data, viewKey, cache]);
  useEffect(() => { cy.current?.edges().unselect(); if (selected) cy.current?.getElementById(edgeKey(selected)).select(); }, [selected, data]);
  const zoom = (factor: number) => { const graph = cy.current; if (!graph) return; graph.resize(); graph.zoom({ level: Math.max(.15, Math.min(3, graph.zoom() * factor)), renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 } }); };
  return <><div className="w-graph-tools"><span>{data.nodes.length} 个节点 · {data.edges.length} 类关系组合</span><button aria-label="放大关系图" onClick={() => zoom(1.25)}>＋</button><button aria-label="缩小关系图" onClick={() => zoom(.8)}>−</button><button onClick={() => { cy.current?.resize(); cy.current?.fit(undefined, 40); }}>适合画布</button><button onClick={() => { cache.delete(viewKey); cy.current?.layout({ name: "grid", padding: 40, avoidOverlap: true }).run(); }}>重新布局</button>{focused && <button onClick={() => { cy.current?.elements().removeClass("dim"); setFocused(""); }}>取消邻居突出</button>}</div><div className="w-relation-canvas" ref={host} aria-label="有向关系画布，可拖动节点和缩放" /><p className="mc2-note">○ 人员　▢ 智能体　□ 文件　◇ 缺失角色 · 箭头含义按关系名称解释；拖动画布平移，滚轮以鼠标位置为中心缩放，＋/− 也可缩放。节点点击只突出一跳。</p></>;
}

export function RelationMatrix({ data, selected, onEdge, cache, viewKey }: { data: RelationData; selected?: Edge; onEdge: (e: Edge) => void; cache: Map<string, { sort: string; row: number; column: number }>; viewKey: string }) {
  const [sort, setSort] = useState(cache.get(viewKey)?.sort ?? "name");
  const [rowPage, setRowPage] = useState(cache.get(viewKey)?.row ?? 0), [columnPage, setColumnPage] = useState(cache.get(viewKey)?.column ?? 0);
  useEffect(() => { cache.set(viewKey, { sort, row: rowPage, column: columnPage }); }, [sort, rowPage, columnPage, cache, viewKey]);
  const nodes = new Map(data.nodes.map(n => [n.id, n]));
  const rank = (id: string) => data.edges.filter(e => e.source === id || e.target === id).reduce((a, e) => a + e.count, 0);
  const ids = [...new Set(data.edges.flatMap(e => [e.source, e.target]))].sort((a, b) => sort === "count" ? rank(b) - rank(a) || a.localeCompare(b) : (nodes.get(a)?.label ?? a).localeCompare(nodes.get(b)?.label ?? b));
  const allSources = ids.filter(id => data.edges.some(e => e.source === id));
  const allTargets = ids.filter(id => data.edges.some(e => e.target === id));
  const sources = allSources.slice(rowPage * 24, (rowPage + 1) * 24);
  const targets = allTargets.slice(columnPage * 24, (columnPage + 1) * 24);
  const grouped = new Map<string, Edge[]>();
  data.edges.forEach(e => { const key = JSON.stringify([e.source, e.target]); grouped.set(key, [...(grouped.get(key) ?? []), e]); });
  const max = Math.max(1, ...[...grouped.values()].map(a => a.reduce((n, e) => n + e.count, 0)));
  const [pair, setPair] = useState<Edge[]>([]);
  const label = (id: string) => entityName(id, nodes.get(id)?.label);
  const axis = (id: string) => <EntityLabel id={id} label={nodes.get(id)?.label} kind={nodes.get(id)?.entity_type}/>;
  return <><EntityLegend/><div className="w-graph-tools"><span>行：发起/来源角色 · 列：目标角色</span><label>排序<select value={sort} onChange={e => { setSort(e.target.value); setRowPage(0); setColumnPage(0); }}><option value="name">名称</option><option value="count">关系量</option></select></label></div>{(allSources.length > 24 || allTargets.length > 24) && <div className="w-matrix-pages"><span>分块显示：{sources.length}/{allSources.length} 行、{targets.length}/{allTargets.length} 列；全部关系参与数量刻度</span><button disabled={!rowPage} onClick={() => setRowPage(v => v - 1)}>前24行</button><button disabled={(rowPage + 1) * 24 >= allSources.length} onClick={() => setRowPage(v => v + 1)}>后24行</button><button disabled={!columnPage} onClick={() => setColumnPage(v => v - 1)}>前24列</button><button disabled={(columnPage + 1) * 24 >= allTargets.length} onClick={() => setColumnPage(v => v + 1)}>后24列</button></div>}<div className="w-matrix-scroll" tabIndex={0} aria-label="有向关系矩阵"><table className="w-relation-matrix"><thead><tr><th>来源 ↓ / 目标 →</th>{targets.map(id => <th key={id} title={label(id)}>{axis(id)}</th>)}</tr></thead><tbody>{sources.map(id => <tr key={id}><th title={displayId(id)}>{axis(id)}</th>{targets.map(target => {
    const edges = grouped.get(JSON.stringify([id, target])) ?? [];
    const n = edges.reduce((a, e) => a + e.count, 0);
    return <td key={target}><button disabled={!n} className={selected?.source === id && selected.target === target ? "selected" : ""} title={`${label(id)} → ${label(target)} · ${n} 条类型记录${edges.length > 1 ? '（多种动作，点击区分）' : ''}`} aria-label={`${label(id)} → ${label(target)} ${n}`} style={{ background: n ? `rgba(38,115,184,${.14 + .86 * Math.log1p(n) / Math.log1p(max)})` : "#f0f3f7", color: n > max / 3 ? "white" : "#294c70" }} onClick={() => { setPair(edges); if (edges.length === 1) onEdge(edges[0]); }}>{n || ""}</button></td>;
  })}</tr>)}</tbody></table></div>{pair.length > 1 && <div className="w-pair-types"><span>该组合包含多种动作，请选择：</span>{pair.map(e => <button key={edgeKey(e)} onClick={() => onEdge(e)}>{relationName[e.relation]} · {e.action} · {number(e.count)}</button>)}</div>}<p className="mc2-note">颜色表示数量（统一对数刻度）；缺少发起者是缺失分组。箭头角色不等于内容流动；不同动作分开查证。</p></>;
}
