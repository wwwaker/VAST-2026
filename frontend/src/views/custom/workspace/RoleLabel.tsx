import { roleNames } from "./customApi";
import { roleVisual } from "./customVisuals";

export function RoleLabel({ role }: { role: string }) {
  const { color, icon: Icon } = roleVisual(role);
  return <span className="cu-role-label" style={{ color }}><Icon size={13} aria-hidden="true"/>{roleNames[role] ?? role}</span>;
}
