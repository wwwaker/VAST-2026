import { seriesColor } from "../../shared/lib/chartColors";
import {
  Activity,
  MessagesSquare,
  Megaphone,
  Mail,
  FolderOpen,
  Workflow,
  Users,
  Settings2,
  Layers3,
  Network,
  GitCompareArrows,
} from "lucide-react";

// IDs follow the API's comm/post/mail/file/task/presence/system/other categories.
const categoryIcons = [
  MessagesSquare,
  Megaphone,
  Mail,
  FolderOpen,
  Workflow,
  Users,
  Settings2,
  Activity,
];

export const categoryIcon = (category: number) => categoryIcons[category - 1] ?? Activity;

export const fileActionColor = (action: string) =>
  action === "delete_file"
    ? seriesColor("#bd6d62")
    : action === "create_file"
      ? seriesColor("#398e7e")
      : action === "read_file"
        ? seriesColor("#638ac0")
        : action.includes("post")
          ? seriesColor("#ad8239")
          : action.includes("queue")
            ? seriesColor("#9570b7")
            : seriesColor("#718697");

export const modeVisuals = {
  types: { Icon: Layers3, color: seriesColor("#338d83") },
  system: { Icon: Network, color: seriesColor("#7d6bb3") },
  relay: { Icon: Workflow, color: seriesColor("#bf6965") },
  operations: { Icon: FolderOpen, color: seriesColor("#b17a29") },
  compare: { Icon: GitCompareArrows, color: seriesColor("#638a98") },
};
