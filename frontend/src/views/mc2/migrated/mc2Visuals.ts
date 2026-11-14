import { Activity, MessagesSquare, Megaphone, Mail, FolderOpen, Workflow, Users, Settings2, Layers3, Network, GitCompareArrows } from "lucide-react";

// IDs follow the API's comm/post/mail/file/task/presence/system/other categories.
const categoryIcons = [MessagesSquare, Megaphone, Mail, FolderOpen, Workflow, Users, Settings2, Activity];
export const categoryIcon = (category: number) => categoryIcons[category - 1] ?? Activity;
export const fileActionColor = (action:string) => action === "delete_file" ? "#bd6d62" : action === "create_file" ? "#398e7e" : action === "read_file" ? "#638ac0" : action.includes("post") ? "#ad8239" : action.includes("queue") ? "#9570b7" : "#718697";
export const modeVisuals = {
  types: { Icon: Layers3, color: "#338d83" },
  system: { Icon: Network, color: "#7d6bb3" },
  relay: { Icon: Workflow, color: "#bf6965" },
  operations: { Icon: FolderOpen, color: "#b17a29" },
  compare: { Icon: GitCompareArrows, color: "#638a98" },
};
