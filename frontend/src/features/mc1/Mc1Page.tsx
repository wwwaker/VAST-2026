import { ShadowWorkspace } from "../../shared/ui/ShadowWorkspace";
import windowRangeCss from "../../shared/styles/window-range.css?inline";
import type { DatasetId } from "../../shared/types/dataset";
// The reference frontend lives inside a shadow root: neither stylesheet can
// change the other workspaces' grids, readers, controls or typography.
import Mc1Workspace from "./Mc1Workspace.jsx";
import referenceCss from "../../shared/styles/workspace-base.css?inline";
import themeCss from "../../shared/styles/workspace-theme.css?inline";

export function Mc1Page({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  return (
    <ShadowWorkspace
      testId="mc1-reference"
      styles={referenceCss + themeCss + windowRangeCss}
    >
      <Mc1Workspace onDatasetChange={onDatasetChange} />
    </ShadowWorkspace>
  );
}
