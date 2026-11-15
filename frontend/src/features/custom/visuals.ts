import { seriesColor } from "../../shared/lib/chartColors";
import {
  Activity,
  Clock3,
  GitBranch,
  Layers3,
  ShieldCheck,
  ShieldOff,
  Sprout,
  ClipboardList,
  Sailboat,
  Send,
  Repeat2,
  Settings2,
  Network,
  Search,
  PenLine,
} from "lucide-react";

export const conditionVisuals: Record<string, { color: string; icon: typeof Activity }> = {
  normal: { color: seriesColor("#258879"), icon: ShieldCheck },
  bypass_review: { color: seriesColor("#cd7059"), icon: ShieldOff },
  stale_version: { color: seriesColor("#b38a36"), icon: Layers3 },
  repeated_handoff: { color: seriesColor("#8b6bb5"), icon: Repeat2 },
};

export const metricVisuals = {
  duration: { color: seriesColor("#278c95"), icon: Clock3 },
  calls: { color: seriesColor("#687bb7"), icon: Activity },
  versions: { color: seriesColor("#b38a36"), icon: Layers3 },
  handoffs: { color: seriesColor("#9270b2"), icon: GitBranch },
  reviews: { color: seriesColor("#59906a"), icon: ShieldCheck },
  attempts: { color: seriesColor("#bd7852"), icon: Send },
};

export const roleVisuals: Record<string, { color: string; icon: typeof Activity }> = {
  controller: { color: seriesColor("#66758f"), icon: Settings2 },
  coordinator: { color: seriesColor("#7d6bb3"), icon: Network },
  researcher: { color: seriesColor("#338d83"), icon: Search },
  writer: { color: seriesColor("#ad8130"), icon: PenLine },
  reviewer: { color: seriesColor("#528e62"), icon: ShieldCheck },
  publisher: { color: seriesColor("#bf725d"), icon: Send },
};

export const roleVisual = (role: string) =>
  roleVisuals[role] ?? { color: seriesColor("#788898"), icon: Activity };

export function taskVisual(name: string | null) {
  if (name?.includes("equipment_handover")) {
    return { label: "教室实验器材交接清单", icon: ClipboardList };
  }
  if (name?.includes("garden_status")) {
    return { label: "校园花园志愿者状态简报", icon: Sprout };
  }
  if (name?.includes("paper_boats")) {
    return { label: "纸船工作坊通知", icon: Sailboat };
  }

  return {
    label: name?.split("/").at(-1)?.replace(/\.md$/, "") ?? "未记录任务",
    icon: ClipboardList,
  };
}
