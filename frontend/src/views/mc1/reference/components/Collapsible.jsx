
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function Collapsible({ title, defaultOpen = true, right = null, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`collapsible ${open ? 'is-open' : 'is-closed'}`}>
      <button type="button" className="collapsible-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="collapsible-title">{title}</span>
        {right}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}
