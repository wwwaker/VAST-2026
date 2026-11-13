import { Activity, Clock3, GitBranch, Layers3, ShieldCheck, ShieldOff, Sprout, ClipboardList, Sailboat, Send, Repeat2, Settings2, Network, Search, PenLine } from "lucide-react";

export const conditionVisuals: Record<string, { color: string; icon: typeof Activity }> = {
  normal: { color: "#258879", icon: ShieldCheck },
  bypass_review: { color: "#cd7059", icon: ShieldOff },
  stale_version: { color: "#b38a36", icon: Layers3 },
  repeated_handoff: { color: "#8b6bb5", icon: Repeat2 },
};
export const metricVisuals = {
  duration: { color: "#278c95", icon: Clock3 },
  calls: { color: "#687bb7", icon: Activity },
  versions: { color: "#b38a36", icon: Layers3 },
  handoffs: { color: "#9270b2", icon: GitBranch },
  reviews: { color: "#59906a", icon: ShieldCheck },
  attempts: { color: "#bd7852", icon: Send },
};
export const roleVisuals: Record<string, { color: string; icon: typeof Activity }> = {
  controller: { color: "#66758f", icon: Settings2 },
  coordinator: { color: "#7d6bb3", icon: Network },
  researcher: { color: "#338d83", icon: Search },
  writer: { color: "#ad8130", icon: PenLine },
  reviewer: { color: "#528e62", icon: ShieldCheck },
  publisher: { color: "#bf725d", icon: Send },
};
export const roleVisual = (role: string) => roleVisuals[role] ?? { color: "#788898", icon: Activity };
export function taskVisual(name: string | null) {
  if (name?.includes("equipment_handover")) return { label: "教室实验器材交接清单", icon: ClipboardList };
  if (name?.includes("garden_status")) return { label: "校园花园志愿者状态简报", icon: Sprout };
  if (name?.includes("paper_boats")) return { label: "纸船工作坊通知", icon: Sailboat };
  return { label: name?.split("/").at(-1)?.replace(/\.md$/, "") ?? "未记录任务", icon: ClipboardList };
}
