import type { ReactNode } from "react";
import type { DatasetId } from "../../state/workspace";

export function WorkspaceHeader({ title, description, dataset, change, children }: { title: string; description: string; dataset: DatasetId; change: (id: DatasetId) => void; children?: ReactNode }) {
  return <header className="compact-header"><div><h1>{title}</h1><p>{description}</p></div><nav className="workspace-nav" aria-label="工作区导航">{(["MC1", "MC2", "CUSTOM"] as const).map(id => id === dataset ? <span key={id} className="nav-current">{id}</span> : <button key={id} onClick={() => change(id)}>{id}</button>)}{children}</nav></header>;
}
