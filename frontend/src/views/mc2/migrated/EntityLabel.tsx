import { Bot, FileText, HelpCircle, MapPin, Server, UserRound, Users } from "lucide-react";

const kinds = {
  agent: { label: "智能体", color: "#8862b4", Icon: Bot },
  person: { label: "人员", color: "#429583", Icon: UserRound },
  system: { label: "系统", color: "#417bb4", Icon: Server },
  file_path: { label: "文件", color: "#b17a29", Icon: FileText },
  room: { label: "场所", color: "#638a98", Icon: MapPin },
  team: { label: "团队", color: "#9c6b91", Icon: Users },
  missing: { label: "缺失角色", color: "#748092", Icon: HelpCircle },
};
export function entityName(id: string, label?: string) {
  const name = (label || id).replace(/^(?:(?:MC2|agent|Agent|person|system|world|team|file_path|room|group):|(?:Agent|agent)\/)+/g, "");
  const systems: Record<string, string> = { email: "邮件", mail: "邮件", file_system: "文件系统", filesystem: "文件系统", flex: "FleX", saidit: "SaidIt", calendar: "日历" };
  if (id.includes(":file_path:")) return name;
  return systems[name.toLowerCase()] ?? name.replaceAll("_", " ");
}
export function EntityLabel({ id, label, kind = "missing" }: { id: string; label?: string; kind?: string }) {
  const item = kinds[kind as keyof typeof kinds] ?? kinds.missing;
  return <span className="w-entity-label" title={`${item.label} · ${entityName(id, label)}\n${id.replace(/^MC2:/, "")}`}><item.Icon size={14} color={item.color} aria-label={item.label}/><span className="w-entity-name">{entityName(id, label)}</span></span>;
}
export function EntityLegend() {
  return <div className="w-entity-legend">{Object.entries(kinds).map(([kind, item]) => <span key={kind}><item.Icon size={13} color={item.color}/>{item.label}</span>)}</div>;
}
