import React from 'react';

export function ViewControls({ views, children }) {
  return <section className="global-controls">
    <span className="gc-label">显示视图：</span>
    {views.map(view => <label className="check" key={view.id}><input type="checkbox" checked={view.checked} disabled={view.disabled} onChange={e => view.change(e.target.checked)} /> {view.label}</label>)}
    {children}
  </section>;
}
