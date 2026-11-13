import windowRangeCss from "../shared/window-range.css?inline";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DatasetId } from "../../state/workspace";
import referenceCss from "../mc1/reference/style.css?inline";
import themeCss from "../mc1/reference/theme.css?inline";
import sharedCss from "../shared/workspace.css?inline";
import css from "./workspace/custom.css?inline";
import { CustomWorkspace } from "./workspace/CustomWorkspace";

export function CustomMigratedPage({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  const host = useRef<HTMLDivElement>(null); const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => { if (host.current) setShadow(host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" })); const previous = document.documentElement.style.scrollbarGutter; document.documentElement.style.scrollbarGutter = "stable"; return () => { document.documentElement.style.scrollbarGutter = previous; }; }, []);
  return <div ref={host} data-testid="custom-reference" style={{ minHeight: "100vh", background: "#f5f7fa" }}>{shadow && createPortal(<><style>{referenceCss}{themeCss}{windowRangeCss}{sharedCss}{css}</style><CustomWorkspace onDatasetChange={onDatasetChange}/></>, shadow)}</div>;
}
