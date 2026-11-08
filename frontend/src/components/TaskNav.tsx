import { useWorkspace, type DatasetId } from "../state/workspace";
import { CAPABILITIES } from "../state/workspaceReducer";
import type { Mode, TaskId } from "../state/workspaceTypes";

const TASKS: Array<{ id: TaskId; label: string; hint: string }> = [
  { id: "overview", label: "概览", hint: "从全局对象和活动开始调查" },
  { id: "trace", label: "追踪", hint: "沿来源、运行或决策链下钻" },
  { id: "compare", label: "对照", hint: "比较时间窗、历史实例或运行" },
  { id: "findings", label: "结论", hint: "整理证据、案例、笔记和导出" },
];

const MODE_LABELS: Record<Mode, string> = {
  activity: "活动", time: "时间", relations: "关系", system: "系统", runs: "运行",
  decision: "决策", localGraph: "局部关系", source: "来源", intervention: "干预", run: "运行追踪",
  window: "时间窗", history: "历史", transitions: "转移", runPair: "运行对照", claims: "结论", notes: "笔记",
};

export function TaskNav({ onParallel }: { onParallel: () => void }) {
  const { dataset, state, changeTask } = useWorkspace();
  const modes = CAPABILITIES[dataset][state.task];

  return (
    <nav className="task-nav" aria-label="调查任务">
      <div className="task-nav-primary" role="tablist" aria-label="调查任务">
        {TASKS.map((task) => (
          <button
            key={task.id}
            type="button"
            role="tab"
            aria-selected={state.task === task.id}
            title={task.hint}
            className={`task-tab${state.task === task.id ? " task-tab-active" : ""}`}
            onClick={() => changeTask(task.id)}
          >
            {task.label}
          </button>
        ))}
      </div>
      {(
        <div className="task-nav-secondary" role="tablist" aria-label={`${state.task} 模式`}>
          <span className="task-nav-label">{TASKS.find((task) => task.id === state.task)?.label}</span>
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={state.mode === mode}
              className={`mode-tab${state.mode === mode ? " mode-tab-active" : ""}`}
              onClick={() => changeTask(state.task, mode)}
            >
              {MODE_LABELS[mode] ?? mode}
            </button>
          ))}
          <button type="button" className="btn btn-quiet parallel-toggle" onClick={onParallel} title="同时打开检查器和事件辅助区">
            并列核对
          </button>
        </div>
      )}
    </nav>
  );
}

export function taskModeLabel(dataset: DatasetId, task: TaskId, mode: Mode): string {
  return `${dataset} · ${TASKS.find((item) => item.id === task)?.label ?? task} · ${MODE_LABELS[mode] ?? mode}`;
}
