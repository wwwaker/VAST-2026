import { useEffect, useMemo, useState } from "react";
import { fetchRuns, formatDuration, type RunAuditSummary, type RunItem } from "../../data/api";

function resultBadge(summary: RunAuditSummary): { text: string; className: string } {
  if (summary.published_stale > 0) return { text: "旧版已发布", className: "tag tag-risk" };
  if (summary.denied > 0) return { text: "旧版被拒绝", className: "tag tag-warn" };
  if (summary.published_without_valid_review > 0) return { text: "审批绕过", className: "tag tag-risk" };
  if (summary.published_current > 0) return { text: "正常发布", className: "tag tag-ok" };
  if (summary.publish_unknown > 0) return { text: "无发布结果", className: "tag" };
  return { text: "无发布动作", className: "tag" };
}

function shortId(runId: string): string {
  return runId.replace(/^run-/, "").slice(0, 10);
}

export function RunOverview({ onOpen }: { onOpen: (runId: string) => void }) {
  const [items, setItems] = useState<RunItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scenario, setScenario] = useState("all");
  const [model, setModel] = useState("all");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchRuns({}, controller.signal)
      .then((payload) => {
        if (!controller.signal.aborted) setItems(payload.items);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const scenarios = useMemo(
    () => [...new Set(items.map((item) => item.scenario ?? "未标注"))].sort(),
    [items],
  );
  const models = useMemo(() => [...new Set(items.map((item) => item.model ?? "未知"))].sort(), [items]);

  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (scenario === "all" || (item.scenario ?? "未标注") === scenario) &&
          (model === "all" || (item.model ?? "未知") === model),
      ),
    [items, scenario, model],
  );

  if (error) {
    return (
      <div className="empty-state">
        <h2>运行列表读取失败</h2>
        <p>{error}</p>
        <p className="muted small">请确认主库已用 v2 导入并包含 CUSTOM 派生数据。</p>
      </div>
    );
  }

  if (loading && items.length === 0) {
    return <div className="empty-state"><p className="muted">正在载入运行列表…</p></div>;
  }

  return (
    <div className="runs">
      <div className="runs-head">
        <div>
          <h2>32 次工作流运行</h2>
          <p className="muted small">
            审计结果由事件字段重算；来源标签的 scenario/observed 仅作并列展示。
            选择运行进入流程泳道，再用「与正常对照比较」核对阶段差异。
          </p>
        </div>
        <div className="runs-tools">
          <label className="field">
            <span>场景</span>
            <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
              <option value="all">全部</option>
              {scenarios.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>模型</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="all">全部</option>
              {models.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small">{visible.length} / {items.length}</span>
        </div>
      </div>

      <div className="run-table" role="table" aria-label="运行列表">
        <div className="run-row run-header" role="row">
          <span>运行</span>
          <span>模型</span>
          <span>fixture</span>
          <span>场景</span>
          <span>observ.</span>
          <span>发布结果</span>
          <span>审核</span>
          <span>重复交接</span>
          <span>事件</span>
          <span>耗时</span>
        </div>
        {visible.map((item) => {
          const badge = resultBadge(item.audit);
          return (
            <button
              key={item.run_id}
              type="button"
              className="run-row run-row-button"
              role="row"
              onClick={() => onOpen(item.run_id)}
              title={`${item.run_id}\n点击进入流程泳道`}
            >
              <span className="mono" title={item.run_id}>{shortId(item.run_id)}</span>
              <span>{item.model ?? "—"}</span>
              <span className="run-fixture" title={item.fixture ?? ""}>
                {(item.fixture ?? "—").split("/").pop()}
              </span>
              <span>{item.scenario ?? "未标注"}</span>
              <span className={item.observed ? "run-observed" : "muted"}>{item.observed ? "true" : "false"}</span>
              <span>
                <span className={badge.className}>{badge.text}</span>
              </span>
              <span className={item.audit.review_invalid > 0 ? "run-risk" : "muted small"}>
                {item.audit.attempt_count === 0
                  ? "无尝试"
                  : item.audit.review_invalid > 0
                    ? `无效 ${item.audit.review_invalid}`
                    : item.audit.review_unknown > 0
                      ? "未知"
                      : "有效"}
              </span>
              <span className={item.audit.repeated_handoff > 0 ? "run-risk" : "muted"}>
                {item.audit.repeated_handoff}
              </span>
              <span className="mono">{item.event_count}</span>
              <span className="mono">{formatDuration(item.duration_us)}</span>
            </button>
          );
        })}
      </div>

      <p className="muted small">
        “旧版被拒绝”表示读到旧版并尝试发布但被拒绝；“无发布结果”不等于成功或失败，
        需要回到运行泳道查看截至当前可见的事件。
      </p>
    </div>
  );
}
