import { ShadowWorkspace } from "../../shared/ui/ShadowWorkspace";
import windowRangeCss from "../../shared/styles/window-range.css?inline";
import type { DatasetId } from "../../shared/types/dataset";
import referenceCss from "../../shared/styles/workspace-base.css?inline";
import themeCss from "../../shared/styles/workspace-theme.css?inline";
import sharedCss from "../../shared/styles/workspace-controls.css?inline";
import css from "./styles.css?inline";
import { CustomWorkspace } from "./CustomWorkspace";

export function CustomPage({ onDatasetChange }: { onDatasetChange: (id: DatasetId) => void }) {
  return (
    <ShadowWorkspace
      testId="custom-reference"
      styles={referenceCss + themeCss + windowRangeCss + sharedCss + css}
    >
      <CustomWorkspace onDatasetChange={onDatasetChange} />
    </ShadowWorkspace>
  );
}
