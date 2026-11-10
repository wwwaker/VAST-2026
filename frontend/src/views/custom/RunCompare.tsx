import { Fragment, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchRunComparison, formatDuration, type RunComparisonPayload, type RunStageSide } from "../../data/api";

function value(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function sideEnd(side: RunStageSide): number | null {
  if (side.start_offset_us == null || side.duration_us == null) return null;
  return side.start_offset_us + side.duration_us;
}

/**
 * 正常配对：七行固定阶段，每行当前/对照两条轨，共用从 0 到较大结束偏移的相对时间轴。
 * 0 起点、0 记录跨度是有效值，画成点而不是缺失；missing 单独标注“未记录”。
 */
export function RunCompare({
  runId,
  baselineRunId = null,
  missingRun = false,
  missingBaseline = false,
  onBack,
  onOpenEvent,
}: {
  runId: string;
  baselineRunId?: string | null;
  missingRun?: boolean;
  missingBaseline?: boolean;
  onBack: () => void;
  onOpenEvent: (eventId: string, timeUs: number | null, trigger?: Element | null) => void;
}) {
  const { dispatch } = useWorkspace();
  const [payload, setPayload] = useState<RunComparisonPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<{ stage: string; side: "run" | "baseline" } | null>(null);

  useEffect(() => {
    if (missingRun || missingBaseline) {
      setPayload(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setError(null);
    setPayload(null);
    fetchRunComparison(runId, baselineRunId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setPayload(data);
          dispatch({ type: "resolvedPair", runId, baselineRunId: data.pair.baseline_run_id });
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取失败");
      });
    return () => controller.abort();
  }, [runId, baselineRunId, dispatch, missingRun, missingBaseline]);

  const axisMax = useMemo(() => {
    if (!payload) return 0;
    const ends = payload.stages
      .flatMap((stage) => [sideEnd(stage.run), sideEnd(stage.baseline)])
      .filter((value): value is number => value != null);
    return ends.length ? Math.max(...ends) : 0;
  }, [payload]);

  if (missingRun || missingBaseline) {
    return (
      <section className="custom-card" aria-label="正常配对" data-testid="custom-pair">
        <div className="callout callout-warn">
          <strong>配对引用在快照中被标记为缺失</strong>
          <p className="muted small mono">
            {runId} ↔ {baselineRunId ?? "（无固定对照）"}
          </p>
          <p className="muted small">
            原引用保留并可导出；不会换一个运行冒充正常对照，也不请求已知缺失的对象。
          </p>
          <button type="button" className="btn" onClick={onBack}>
            返回运行
          </button>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="custom-card" aria-label="正常配对" data-testid="custom-pair">
        <div className="empty-state">
          <h2>配对比较失败</h2>
          <p>{error}</p>
          <p className="muted small">该运行可能没有已核验的正常对照；不会用集合第一行充当 baseline。</p>
          <button type="button" className="btn" onClick={onBack}>
            返回运行
          </button>
        </div>
      </section>
    );
  }

  if (!payload) {
    return (
      <section className="custom-card" aria-label="正常配对" data-testid="custom-pair">
        <p className="muted small">正在对齐两个运行…</p>
      </section>
    );
  }

  const span = axisMax > 0 ? axisMax : 1;
  const pct = (us: number) => (axisMax > 0 ? Math.max(0, Math.min(100, (us / span) * 100)) : 0);
  const ticks = axisMax > 0 ? [0, 0.25, 0.5, 0.75, 1].map((ratio) => ratio * axisMax) : [0];

  const track = (
    stageKey: string,
    stageLabel: string,
    side: "run" | "baseline",
    data: RunStageSide,
    missing: boolean,
    runLabel: string,
  ) => {
    const isOpen = expanded?.stage === stageKey && expanded.side === side;
    if (missing || data.count === 0) {
      return (
        <div className="custom-track-line is-missing" data-side={side}>
          <span className="custom-track-side">{side === "run" ? "当前" : "对照"}</span>
          <span className="custom-track-empty" data-testid={`custom-pair-missing-${side}-${stageKey}`}>
            未记录（{runLabel}）
          </span>
        </div>
      );
    }
    const start = data.start_offset_us ?? 0;
    const duration = data.duration_us ?? 0;
    const left = pct(start);
    const right = pct(start + duration);
    return (
      <div className="custom-track-line" data-side={side}>
        <span className="custom-track-side">{side === "run" ? "当前" : "对照"}</span>
        <button
          type="button"
          className={`custom-track${isOpen ? " is-open" : ""}`}
          aria-expanded={isOpen}
          data-stage-key={stageKey}
          data-side={side}
          data-count={data.count}
          title={`${stageLabel} · ${runLabel} · ${data.count} 条 · 起点 +${formatDuration(start)} · 记录跨度 ${formatDuration(duration)}`}
          onClick={() =>
            setExpanded((current) =>
              current && current.stage === stageKey && current.side === side ? null : { stage: stageKey, side },
            )
          }
        >
          <span className="custom-track-axis" aria-hidden="true" />
          {duration > 0 ? (
            <span className="custom-track-seg" style={{ left: `${left}%`, width: `${Math.max(0.8, right - left)}%` }} aria-hidden="true" />
          ) : (
            <span className="custom-track-point" style={{ left: `${left}%` }} aria-hidden="true" />
          )}
        </button>
        <span className="custom-track-count mono">
          {data.count} 条
          <span className="muted"> +{formatDuration(start)} / {formatDuration(duration)}</span>
        </span>
      </div>
    );
  };

  return (
    <section className="custom-card custom-pair" aria-label="正常配对" data-testid="custom-pair">
      <header className="custom-card-head">
        <h2>阶段对照 · 当前 ↔ 正常</h2>
        <p className="muted small">
          当前 <span className="mono">{payload.run.run_id}</span> ↔ 对照{" "}
          <span className="mono">{payload.baseline.run_id}</span>
          {payload.pair.auto && "（自动选择已核验的正常对照）"}
          {!payload.pair.valid && " · 配对不合法，仅作预览"}
        </p>
        <div className="custom-card-actions">
          <button type="button" className="btn btn-quiet" onClick={onBack}>
            返回运行
          </button>
        </div>
      </header>

      <div className="custom-scope">
        <span className={payload.pair.valid ? "tag tag-ok" : "tag tag-warn"}>
          同模型 {String(payload.pair.same_model)} · 同任务 {String(payload.pair.same_fixture)} · 对照为 normal{" "}
          {String(payload.pair.baseline_normal)}
        </span>
        <span className="tag" title="配对使用两次完整运行，不受事件筛选、时间窗或回放游标影响。">
          配对=两次完整运行（回放不生效）
        </span>
      </div>

      <div className="custom-pair-axis" data-axis-max={axisMax}>
        <span className="custom-pair-axis-label muted small">相对运行起点</span>
        <span className="custom-pair-axis-spacer" aria-hidden="true" />
        <span className="custom-pair-axis-scale">
          {ticks.map((tick, index) => (
            <span
              key={index}
              className="custom-pair-tick mono"
              style={{ left: `${axisMax > 0 ? (tick / axisMax) * 100 : 0}%` }}
            >
              +{formatDuration(tick)}
            </span>
          ))}
        </span>
        <span />
      </div>

      <div className="custom-pair-grid" role="table" aria-label="阶段对照">
        {payload.stages.map((stage) => {
          const different =
            stage.run.count !== stage.baseline.count || stage.missing.run !== stage.missing.baseline;
          const openSide = expanded?.stage === stage.stage ? expanded.side : null;
          const openData = openSide === "run" ? stage.run : openSide === "baseline" ? stage.baseline : null;
          const openRunId = openSide === "run" ? payload.run.run_id : payload.baseline.run_id;
          return (
            <Fragment key={stage.stage}>
              <div className={`custom-pair-row${different ? " is-different" : ""}`} role="row" data-stage-key={stage.stage}>
                <div className="custom-pair-label">
                  <strong>{stage.label}</strong>
                  {stage.missing.run && <span className="tag tag-warn">当前缺失</span>}
                  {stage.missing.baseline && <span className="tag tag-warn">对照缺失</span>}
                  {different && <span className="muted small">阶段/数量不同</span>}
                </div>
                <div className="custom-pair-tracks">
                  {track(stage.stage, stage.label, "run", stage.run, stage.missing.run, "当前运行")}
                  {track(stage.stage, stage.label, "baseline", stage.baseline, stage.missing.baseline, "正常对照")}
                </div>
              </div>
              {openData && (
                <div className="custom-pair-events" role="group" aria-label={`${stage.label} 事件`}>
                  <p className="muted small">
                    {openSide === "run" ? "当前运行" : "正常对照"} <span className="mono">{openRunId}</span> · {" "}
                    {openData.count} 条真实事件（打开不会切换当前调查运行）
                  </p>
                  <div className="custom-pair-event-list">
                    {openData.event_ids.map((eventId) => (
                      <button
                        key={eventId}
                        type="button"
                        className="btn btn-quiet mono"
                        data-event-id={eventId}
                        data-side={openSide ?? undefined}
                        onClick={(click) => onOpenEvent(eventId, null, click.currentTarget)}
                      >
                        {eventId.slice(0, 8)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Fragment>
          );
        })}
      </div>

      <details className="custom-metrics">
        <summary>指标差异（{payload.metrics.length}）</summary>
        <div className="custom-metrics-grid" role="table" aria-label="配对指标">
          <div className="custom-metrics-row custom-metrics-head" role="row">
            <span>指标</span>
            <span>当前运行</span>
            <span>正常对照</span>
            <span>差异</span>
          </div>
          {payload.metrics.map((metric) => (
            <div key={metric.key} className={`custom-metrics-row${metric.different ? " is-different" : ""}`} role="row">
              <span>{metric.label}</span>
              <span className="mono">{value(metric.run)}</span>
              <span className="mono">{value(metric.baseline)}</span>
              <span className="muted small">{metric.different ? "不同" : "一致"}</span>
            </div>
          ))}
        </div>
      </details>

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
        事件数更少不等于“效率更高”，可能意味着跳过审核；缺失不等于没有执行，只表示完整日志没有记录。
      </p>
    </section>
  );
}
