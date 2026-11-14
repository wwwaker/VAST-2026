import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { Edge, RelationData } from "./workspaceApi";

export type Point = { x: number; y: number };
export type GraphView = { positions: Map<string, Point>; zoom?: number; pan?: Point };
export const relationColors = { task: "#8862b4", mail: "#417bb4", file: "#b17a29", publish: "#bf6965", system: "#338d83", collaboration: "#638a98" };
export function edgeVisual(edge: Edge) {
  const family: keyof typeof relationColors = edge.relation.startsWith("queue") ? "task" : edge.relation.startsWith("mail") ? "mail" : edge.relation === "post_content_source" ? "publish" : edge.relation === "file_path" ? "file" : edge.relation === "system_party" ? "system" : "collaboration";
  return { color: relationColors[family], family, dashed: edge.action === "delete_file" || edge.source === "__missing__" || edge.source === "unknown" };
}
export const familyNames = { task: "任务", mail: "邮件", file: "文件操作", publish: "发布引用", system: "系统参与", collaboration: "通信与协作" };
export function edgeWidth(count: number, max: number) {
  return 1 + 2 * Math.log1p(count) / Math.log1p(Math.max(1, max));
}

/** Compute a settled layout once, rather than animating a simulation on every update. */
export function arrange(data: RelationData, saved = new Map<string, Point>()): Map<string, Point> {
  if (data.nodes.every(n => saved.has(n.id))) return new Map(data.nodes.map(n => [n.id, saved.get(n.id)!]));
  if (data.mode === "operations") {
    const actors = data.nodes.filter(n => n.entity_type !== "file_path");
    const files = data.nodes.filter(n => n.entity_type === "file_path");
    return new Map(data.nodes.map(n => [n.id, saved.get(n.id) ?? (n.entity_type === "file_path"
      ? { x: 510, y: 70 + files.indexOf(n) * 110 + Math.max(0, actors.length - files.length) * 48 }
      : { x: 120, y: 70 + actors.indexOf(n) * 96 })]));
  }
  const nodes = data.nodes.map((n, i) => ({ id: n.id, ...saved.get(n.id),
    x: saved.get(n.id)?.x ?? Math.cos(i / Math.max(1, data.nodes.length) * Math.PI * 2) * 220,
    y: saved.get(n.id)?.y ?? Math.sin(i / Math.max(1, data.nodes.length) * Math.PI * 2) * 180,
    ...(saved.has(n.id) ? { fx: saved.get(n.id)!.x, fy: saved.get(n.id)!.y } : {}) }));
  const pairs = new Set<string>();
  const links = data.edges.filter(e => {
    const pair = JSON.stringify([e.source, e.target].sort());
    if (e.source === e.target || pairs.has(pair)) return false;
    pairs.add(pair); return true;
  }).map(e => ({ source: e.source, target: e.target }));
  const simulation = forceSimulation(nodes).stop()
    .force("links", forceLink(links).id(n => (n as SimulationNodeDatum & { id: string }).id).distance(160).strength(.22))
    .force("repulsion", forceManyBody().strength(-900))
    .force("collisions", forceCollide(72).iterations(3))
    .force("x", forceX(0).strength(.025)).force("y", forceY(0).strength(.04));
  if (!saved.size) simulation.force("center", forceCenter(0, 0));
  simulation.tick(200);
  return new Map(nodes.map(n => [n.id, { x: n.x, y: n.y }]));
}

export function oneHop(data: RelationData, id: string) {
  const edges = data.edges.filter(e => e.source === id || e.target === id);
  const ids = new Set([id, ...edges.flatMap(e => [e.source, e.target])]);
  return { ...data, edges, nodes: data.nodes.filter(n => ids.has(n.id)) };
}
