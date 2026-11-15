import { ShadowWorkspace } from "../../shared/ui/ShadowWorkspace";
import windowRangeCss from "../../shared/styles/window-range.css?inline";
import type { DatasetId } from "../../shared/types/dataset";
// Workspace rules stay inside the ShadowRoot; document palette tokens are inherited.
import Mc1Workspace from "./Mc1Workspace.jsx";
import referenceCss from "../../shared/styles/workspace-base.css?inline";
import themeCss from "../../shared/styles/workspace-theme.css?inline";
import layoutCss from "../../shared/styles/workspace-layout.css?inline";

export function Mc1Page({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  return (
    <ShadowWorkspace
      testId="mc1-reference"
      styles={referenceCss + layoutCss + themeCss + windowRangeCss}
    >
      <Mc1Workspace onDatasetChange={onDatasetChange} />
    </ShadowWorkspace>
  );
}
