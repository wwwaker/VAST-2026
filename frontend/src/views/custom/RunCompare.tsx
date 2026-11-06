import { useEffect, useState } from "react";
import { fetchRunComparison, formatDuration, type RunComparisonPayload } from "../../data/api";

function value(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

export function RunCompare({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [payload, setPayload] = useState<RunComparisonPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetchRunComparison(runId, null, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setPayload(data);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取失败");
      });
    return () => controller.abort();
  }, [runId]);

  if (error) {
    return (
      <div className="empty-state">
        <h2>配对比较失败</h2>
        <p>{error}</p>
        <button type="button" className="btn" onClick={onBack}>返回运行</button>
      </div>
    );
  }

  if (!payload) {
    return <div className="empty-state"><p className="muted">正在对齐两个运行…</p></div>;
  }

  return (
    <div className="run-compare">
      <div className="run-detail-head">
        <div>
          <h2>运行对照</h2>
          <p className="muted small">
            {payload.run.run_id} ↔ {payload.baseline.run_id}
            {payload.pair.auto && "（自动选择已核验的正常对照）"}
            {!payload.pair.valid && " · 配对不合法，仅作预览"}
          </p>
          <p className="muted small">
            同模型 {String(payload.pair.same_model)} · 同任务 {String(payload.pair.same_fixture)} · 对照为
            normal {String(payload.pair.baseline_normal)}
          </p>
        </div>
        <button type="button" className="btn btn-quiet" onClick={onBack}>返回运行</button>
      </div>

      <div className="compare-table">
        <div className="run-row run-header run-stage-row">
          <span>阶段</span>
          <span>当前运行</span>
          <span>正常对照</span>
          <span>差异</span>
        </div>
        {payload.stages.map((stage) => {
          const different =
            stage.run.count !== stage.baseline.count ||
            stage.missing.run !== stage.missing.baseline;
          return (
            <div key={stage.stage} className={`run-row run-stage-row${different ? " compare-deviated" : ""}`}>
              <span>
                {stage.label}
                {stage.missing.run && <span className="tag tag-warn">当前缺失</span>}
                {stage.missing.baseline && <span className="tag tag-warn">对照缺失</span>}
              </span>
              <span className="mono">
                {stage.run.count} 条
                {stage.run.start_offset_us != null && ` · +${formatDuration(stage.run.start_offset_us)}`}
                {stage.run.duration_us != null && ` / ${formatDuration(stage.run.duration_us)}`}
              </span>
              <span className="mono">
                {stage.baseline.count} 条
                {stage.baseline.start_offset_us != null && ` · +${formatDuration(stage.baseline.start_offset_us)}`}
                {stage.baseline.duration_us != null && ` / ${formatDuration(stage.baseline.duration_us)}`}
              </span>
              <span className="muted small">
                {different
                  ? "阶段/数量不同；缺失不代表未执行，可能只是没有记录"
                  : "对齐"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="compare-table">
        <div className="run-row run-header run-stage-row">
          <span>指标</span>
          <span>当前运行</span>
          <span>正常对照</span>
          <span>差异</span>
        </div>
        {payload.metrics.map((metric) => (
          <div key={metric.key} className={`run-row run-stage-row${metric.different ? " compare-deviated" : ""}`}>
            <span>{metric.label}</span>
            <span className="mono">{value(metric.run)}</span>
            <span className="mono">{value(metric.baseline)}</span>
            <span className="muted small">{metric.different ? "不同" : "一致"}</span>
          </div>
        ))}
      </div>

      <div className="callout">
        <strong>审计差异</strong>
        <p className="muted small">
          当前：审核无效 {payload.audit.run.review_invalid} · 旧版 {payload.audit.run.version_stale} ·
          发布旧版 {payload.audit.run.published_stale} · 拒绝 {payload.audit.run.denied} · 重复交接{" "}
          {payload.audit.run.repeated_handoff}
        </p>
        <p className="muted small">
          对照：审核无效 {payload.audit.baseline.review_invalid} · 旧版{" "}
          {payload.audit.baseline.version_stale} · 发布旧版 {payload.audit.baseline.published_stale} ·
          拒绝 {payload.audit.baseline.denied} · 重复交接 {payload.audit.baseline.repeated_handoff}
        </p>
      </div>

      <p className="muted small">{payload.note}</p>
      <p className="muted small">
        事件数更少不等于“效率更高”，可能意味着跳过审核；阶段对齐只按事件类型与角色，
        不替代逐事件因果。
      </p>
    </div>
  );
}
