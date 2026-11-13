import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { roleNames } from "./customApi";
import { RoleLabel } from "./RoleLabel";

/** Uses the existing event-type dropdown shell; null means all, [] means none. */
export function RolePicker({ roles, value, change }: { roles: string[]; value: string[] | null; change: (v: string[] | null) => void }) {
  const host = useRef<HTMLDetailsElement>(null), all = useRef<HTMLInputElement>(null);
  const selected = roles.filter(role => value === null || value.includes(role));
  const isAll = selected.length === roles.length;
  useEffect(() => { if (all.current) all.current.indeterminate = selected.length > 0 && !isAll; }, [selected.length, isAll]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (host.current?.open && !event.composedPath().includes(host.current)) host.current.open = false; };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <details ref={host} className="cu-types cu-role-picker" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (host.current) { host.current.open = false; host.current.querySelector("summary")?.focus(); } } }}>
    <summary aria-label="轨迹角色筛选"><span>角色：{isAll ? "全部角色" : selected.length === 0 ? "未选择" : selected.length === 1 ? roleNames[selected[0]] ?? selected[0] : `已选 ${selected.length} 个`}</span><ChevronDown size={14} aria-hidden="true"/></summary>
    <div role="group" aria-label="可选轨迹角色"><label className="cu-role-all"><input ref={all} type="checkbox" checked={isAll} onChange={e => change(e.target.checked ? null : [])}/>全部角色</label>{roles.map(role => <label key={role}><input type="checkbox" data-role={role} aria-label={`轨迹角色：${roleNames[role] ?? role}`} checked={selected.includes(role)} onChange={e => { const next = e.target.checked ? [...selected, role] : selected.filter(r => r !== role); change(next.length === roles.length ? null : next); }}/><RoleLabel role={role}/></label>)}<button className="cu-text-button" onClick={() => change([])}>清空角色选择</button></div>
  </details>;
}
