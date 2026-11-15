export interface TrajectoryState {
  mode: "time" | "order" | "handoff";
  /** 相对运行起点的秒数；与服务端整数微秒分开保存。 */
  window: [number, number] | null;
  all: boolean;
  calls: boolean;
  roles: string[] | null;
  search: string;
  types: string[] | null;
  anchor: string | null;
  members: string[];
}

/** 返回历史保留展示状态；采集集合筛选由工作区单独维护。 */
export interface Investigation {
  run: string | null;
  view: "collection" | "run" | "compare";
  tab: "version" | "trajectory";
  attempt: string | null;
  selected: string | null;
  baseline: string | null;
  comparisonTab: "version" | "trajectory";
  comparisonWindow: [number, number] | null;
  trajectory: TrajectoryState;
  scroll: number;
}

export const emptyTrajectory = (): TrajectoryState => ({
  mode: "time",
  window: null,
  all: false,
  calls: true,
  roles: null,
  search: "",
  types: null,
  anchor: null,
  members: [],
});

export function initialState(): Investigation {
  const params = new URLSearchParams(window.location.search);
  const run = params.get("run");
  const baseline = params.get("baseline");
  let view: Investigation["view"] = "collection";

  // 只有运行深链接进入详情；baseline 随运行一起决定是否进入配对比较。
  if (run) {
    view = baseline ? "compare" : "run";
  }

  return {
    run,
    view,
    tab: params.get("tab") === "trajectory" ? "trajectory" : "version",
    attempt: null,
    selected: null,
    baseline,
    comparisonTab: "version",
    comparisonWindow: null,
    trajectory: emptyTrajectory(),
    scroll: 0,
  };
}
