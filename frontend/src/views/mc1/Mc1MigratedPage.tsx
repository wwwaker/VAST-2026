import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DatasetId } from "../../state/workspace";
// The reference frontend lives inside a shadow root: neither stylesheet can
// change the other workspaces' grids, readers, controls or typography.
import ReferenceMc1 from "./reference/main.jsx";
import referenceCss from "./reference/style.css?inline";
import themeCss from "./reference/theme.css?inline";

export function Mc1MigratedPage({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    if (host.current) setRoot(host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" }));
    const previous = document.documentElement.style.scrollbarGutter;
    document.documentElement.style.scrollbarGutter = "stable";
    return () => { document.documentElement.style.scrollbarGutter = previous; };
  }, []);
  return <div ref={host} data-testid="mc1-reference" style={{ minHeight: "100vh", background: "#f5f7fa" }}>
    {root && createPortal(<><style>{referenceCss}{themeCss}</style><ReferenceMc1 onDatasetChange={onDatasetChange} /></>, root)}
  </div>;
}
