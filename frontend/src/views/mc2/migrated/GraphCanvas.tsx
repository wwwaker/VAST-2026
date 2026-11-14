import { Keyboard, Search, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import { recordTiming } from "./performance";
import { edgeKey } from "./RelationCanvas";
import { EntityLegend, entityName } from "./EntityLabel";
import { number } from "./shared";
import { relationName, type Edge, type RelationData } from "./workspaceApi";
import { arrange, edgeVisual, edgeWidth, familyNames, oneHop, type GraphView } from "./relationLayout";

export function RelationCanvas({ data, selected, onEdge, onNode, focused = "", viewKey, cache }: {
  data: RelationData; selected?: Edge; onEdge: (e: Edge) => void; onNode: (id: string) => void;
  focused?: string; viewKey: string; cache: Map<string, GraphView>;
}) {
  const host = useRef<HTMLDivElement>(null), cy = useRef<cytoscape.Core>();
  const callbacks = useRef({ onEdge, onNode }); callbacks.current = { onEdge, onNode };
  const activeView = useRef(viewKey);
  const [hover, setHover] = useState<Edge | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState(""), [hoverNode, setHoverNode] = useState("");
  const tools = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<"search" | "layout" | "keyboard" | null>(null);
  const closeTool = () => { tools.current?.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`)?.focus({preventScroll:true}); setTool(null); };
  useEffect(() => {
    if (!tool) return;
    const outside = (event: PointerEvent) => { if (tools.current && !event.composedPath().includes(tools.current)) setTool(null); };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [tool]);
  const actualFocus = data.nodes.some(n => n.id === focused) ? focused : "";
  // Dense networks open as an explicitly labelled one-hop view, with full matrix
  // and full graph still available. No sampled edges are presented as complete.
  const dense = data.nodes.length > 20 && data.edges.length > data.nodes.length * 4;
  const participation = new Map<string,number>();
  data.edges.forEach(e=>new Set([e.source,e.target]).forEach(id=>participation.set(id,(participation.get(id)??0)+e.count)));
  const recommended = [...data.nodes].sort((a,b)=>(participation.get(b.id)??0)-(participation.get(a.id)??0)||a.id.localeCompare(b.id))[0]?.id;
  const center = actualFocus || (dense && !expanded ? selected?.source ?? recommended ?? "" : "");
  const shown = center ? oneHop(data, center) : data;
  const current = useRef({ data: shown, viewKey }); current.current = { data: shown, viewKey };
  useEffect(() => { setExpanded(false); setHover(null); setHoverNode(""); setTool(null); }, [viewKey]);
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
        { selector: "node.hidden-label", style: { label: "" } },
        { selector: "node.reveal", style: { label: "data(label)", "border-width": 3 } },
        { selector: "node.neighbor", style: { "border-width": 2.5, "border-color": "#287d75" } },
        { selector: ".dimmed", style: { opacity: .14 } },
        { selector: "edge[deleted = 1]", style: { label: "data(label)", "font-size": 10, "text-rotation": "autorotate", "text-background-color": "#fff", "text-background-opacity": .9 } },
      ] });
    cy.current = graph;
    graph.on("tap", "edge", event => callbacks.current.onEdge(event.target.data("raw")));
    graph.on("tap", "node", event => callbacks.current.onNode(event.target.id()));
    graph.on("tap", event => { if (event.target === graph) { setHover(null); setHoverNode(""); graph.elements().removeClass("hover dimmed"); } });
    graph.on("mouseover", "edge", event => { event.target.addClass("hover"); setHover(event.target.data("raw")); });
    graph.on("mouseout", "edge", event => { event.target.removeClass("hover"); setHover(null); });
    graph.on("mouseover", "node",event=>{graph.elements().addClass("dimmed");event.target.closedNeighborhood().removeClass("dimmed");event.target.addClass("reveal");event.target.neighborhood().nodes().addClass("neighbor reveal");setHoverNode(event.target.id());});
    graph.on("mouseout", "node",()=>{graph.elements().removeClass("dimmed");graph.nodes().removeClass("neighbor reveal");graph.nodes(":selected, .focused").addClass("reveal");graph.edges(":selected").connectedNodes().addClass("reveal");setHoverNode("");});
    graph.on("zoom",()=>{graph.nodes().toggleClass("hidden-label",graph.zoom()<.7&&graph.nodes().length>20);});
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
    const layoutStarted=performance.now();
    const positions = arrange(shown, new Map([...(saved?.positions ?? []), ...existing]));
    recordTiming("graph-layout",performance.now()-layoutStarted,`${shown.nodes.length} nodes / ${shown.edges.length} edges`);
    const max = Math.max(1, ...data.edges.map(e => e.count));
    const loops = new Map<string, number>();
    const elements = [...shown.nodes.map(n => ({ data: { id: n.id, label: n.id === "__missing__" ? "? 来源未记录" : entityName(n.id, n.label).slice(0,48), kind: n.entity_type }, position: positions.get(n.id) })), ...shown.edges.map(e => {
      const visual = edgeVisual(e), loop = loops.get(e.source) ?? 0; if (e.source === e.target) loops.set(e.source, loop + 1);
      return { data: { id: edgeKey(e), source: e.source, target: e.target, label: `${e.action === "delete_file" ? "× 删除 · " : ""}${relationName[e.relation] ?? e.relation} · ${e.action} · ${e.count}`, color: visual.color, deleted: e.action === "delete_file" ? 1 : 0, lineStyle: e.source === "__missing__" ? "dashed" : "solid", weight: edgeWidth(e.count, max), loopDirection: `${-45 + loop * 55}deg`, raw: e } };
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
    graph.elements().unselect().removeClass("focused reveal neighbor");
    if (selected) { graph.getElementById(edgeKey(selected)).select(); graph.getElementById(selected.source).addClass("reveal"); graph.getElementById(selected.target).addClass("reveal"); }
    if (actualFocus) {graph.getElementById(actualFocus).addClass("focused reveal");graph.getElementById(actualFocus).neighborhood().nodes().addClass("neighbor");}
  }, [selected, actualFocus, data, center, expanded]);
  const zoom = (factor: number) => { const graph = cy.current; if (!graph) return; graph.resize(); graph.zoom({ level: Math.max(.15, Math.min(3, graph.zoom() * factor)), renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 } }); };
  const families = [...new Set(shown.edges.map(e => edgeVisual(e).family))];
  const candidates = data.nodes.filter(n => search.trim() && `${n.label} ${n.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const scopeLabel = `${center ? `局部关系：${entityName(center, data.nodes.find(n => n.id === center)?.label)} · ${actualFocus ? "用户选择" : selected?.source === center ? "选中关系来源" : "本投影入出参与量最高"} · ` : "全部关系 · "}${shown.nodes.length}/${data.nodes.length} 个节点 · ${shown.edges.length}/${data.edges.length} 类关系组合`;
  const hoverLabel = hoverNode ? `${entityName(hoverNode, data.nodes.find(n => n.id === hoverNode)?.label)} · ${hoverNode} · 绿色边框为直接邻居` : hover ? `${relationName[hover.relation]} · ${number(hover.count)} 条 · ${hover.action}` : "";
  return <>
    <div className="w-graph-scope"><span title={scopeLabel}>{scopeLabel}</span>{center && <button onClick={() => { callbacks.current.onNode(""); setExpanded(true); }}>查看全部关系</button>}</div>
    <div className="w-canvas-frame">
      <div ref={tools} className="w-graph-tools w-canvas-tools" onKeyDown={e => { if (e.key === "Escape" && tool) { e.stopPropagation(); closeTool(); } }}>
        <button data-tool="search" aria-label="搜索关系图对象" aria-expanded={tool === "search"} onClick={() => setTool(tool === "search" ? null : "search")}><Search size={15}/></button>
        <button aria-label="放大关系图" onClick={() => zoom(1.25)}><ZoomIn size={15}/></button>
        <button aria-label="缩小关系图" onClick={() => zoom(.8)}><ZoomOut size={15}/></button>
        <button onClick={() => { cy.current?.resize(); cy.current?.fit(undefined, 55); }}>适合画布</button>
        <button data-tool="layout" aria-expanded={tool === "layout"} onClick={() => setTool(tool === "layout" ? null : "layout")}>布局</button>
        <button data-tool="keyboard" aria-label="键盘查证节点与关系" aria-expanded={tool === "keyboard"} onClick={() => setTool(tool === "keyboard" ? null : "keyboard")}><Keyboard size={15}/></button>
        {tool && <div className="w-canvas-popover" role="dialog" aria-label={tool === "search" ? "关系图对象搜索" : tool === "layout" ? "关系图布局" : "键盘查证节点与关系"}>
          {tool === "search" ? <>
            <label>搜索关系图对象<input autoFocus type="text" aria-label="输入关系图对象" value={search} onChange={e => setSearch(e.target.value)} placeholder="姓名、路径或标识" onKeyDown={e => { if(e.key === "Enter" && candidates.length === 1) { callbacks.current.onNode(candidates[0].id); closeTool(); } }}/></label>
            <div className="w-matrix-candidates" aria-label="关系图搜索结果">{candidates.map(n => <button key={n.id} onClick={() => { callbacks.current.onNode(n.id); closeTool(); }}>{entityName(n.id,n.label)} · {n.entity_type} · {n.id}</button>)}<span role="status">{search.trim() ? candidates.length ? `${candidates.length} 个匹配对象` : "没有匹配对象" : "输入名称或标识查找对象"}</span></div>
          </> : tool === "layout" ? <button onClick={() => { const graph = cy.current; if (!graph) return; cache.delete(viewKey); const positions = arrange(current.current.data); graph.nodes().forEach(n => { n.position(positions.get(n.id())!); }); graph.fit(undefined, 55); cache.set(viewKey, { positions, zoom: graph.zoom(), pan: { ...graph.pan() } }); closeTool(); }}>重新布局</button> : <div className="w-matrix-candidates">{shown.nodes.map(n => <button key={n.id} onClick={() => { callbacks.current.onNode(n.id); closeTool(); }}>{entityName(n.id,n.label)}</button>)}{shown.edges.map(e => <button key={edgeKey(e)} onClick={() => { callbacks.current.onEdge(e); closeTool(); }}>{entityName(e.source)} → {entityName(e.target)} · {e.action} · {e.count} 条</button>)}</div>}
        </div>}
      </div>
      <div className="w-relation-canvas" ref={host} aria-label="有向关系画布，可拖动节点和缩放"/>
      {selected && !shown.edges.some(e => edgeKey(e) === edgeKey(selected)) && <div className="w-canvas-notice">选中关系在当前显示外。<button onClick={() => callbacks.current.onNode(selected.source)}>定位选中关系</button></div>}
      {hoverLabel && <div className="w-edge-tooltip">{hoverLabel}</div>}
    </div>
    <div className="w-relation-color-legend">{families.map(family => <span key={family}><i style={{ background: edgeVisual(shown.edges.find(e => edgeVisual(e).family === family)!).color }}/>{familyNames[family]}</span>)}<span>虚线：来源未记录；× 删除标签：删除动作；线宽：事件数量</span></div><EntityLegend/>
    <p className="mc2-note">拖动画布平移，滚轮缩放；点击节点查看一跳关系，点击边查看记录。右上角可搜索对象或使用键盘查证。</p>
  </>;
}
