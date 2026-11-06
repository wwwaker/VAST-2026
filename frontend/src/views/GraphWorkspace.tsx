import { useState } from "react";
import { useWorkspace } from "../state/workspace";
import { RelationGraph } from "./RelationGraph";
import { SystemMap } from "./mc2/SystemMap";

type GraphMode = "local" | "system";

/** 关系图标签下的两种取景：局部实体（可筛选）与 MC2 系统背景（类型聚合）。 */
export function GraphWorkspace() {
  const { dataset, focusedEntityId, openTrace, traceRootId, selectedEventId } = useWorkspace();
  const [mode, setMode] = useState<GraphMode>("local");

  const rootId = traceRootId ?? selectedEventId;

  return (
    <div className="graph-workspace">
      <div className="canvas-subbar">
        <div className="seg" role="tablist" aria-label="关系图取景">
          <button
            type="button"
            className={`seg-item${mode === "local" ? " seg-active" : ""}`}
            onClick={() => setMode("local")}
            aria-pressed={mode === "local"}
          >
            局部实体
          </button>
          {dataset === "MC2" && (
            <button
              type="button"
              className={`seg-item${mode === "system" ? " seg-active" : ""}`}
              onClick={() => setMode("system")}
              aria-pressed={mode === "system"}
            >
              系统背景
            </button>
          )}
          {dataset === "MC2" && rootId && (
            <button type="button" className="seg-item" onClick={() => openTrace({ rootEventId: rootId })}>
              当前链
            </button>
          )}
        </div>
        <span className="muted small">
          {mode === "system"
            ? "背景图不做时间筛选，组织边为静态结构；目标链按当前焦点/选中事件高亮。"
            : focusedEntityId
              ? `以 ${focusedEntityId} 为中心，随筛选与回放变化`
              : "选中事件或参与者后再展开局部关系"}
        </span>
      </div>
      {mode === "system" && dataset === "MC2" ? <SystemMap /> : <RelationGraph />}
    </div>
  );
}
