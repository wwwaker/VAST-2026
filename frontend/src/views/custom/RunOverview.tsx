import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchRuns, formatDuration, type RunAuditSummary, type RunItem, type RunStageSummary } from "../../data/api";

/**
 * 默认主图：运行 × 七阶段。一次批量阶段摘要（include_stages=true）驱动，
 * 不为每行加载运行详情或配对。阶段状态 recorded / no_record / unknown 用
 * 底色 + 计数 / 空心短横 / 纹理问号区分，审计风险只在行尾用文字标记。
 */

const STATE_TEXT: Record<RunStageSummary["state"], string> = {
  recorded: "有记录",
  no_record: "完整日志未记录",
  unknown: "资料不足",
};

function resultBadge(summary: RunAuditSummary): { text: string; className: string } {
  if (summary.published_stale > 0) return { text: "旧版已发布", className: "tag tag-risk" };
  if (summary.denied > 0) return { text: "旧版被拒绝", className: "tag tag-warn" };
  if (summary.published_without_valid_review > 0) return { text: "审批绕过", className: "tag tag-risk" };
  if (summary.published_current > 0) return { text: "正常发布", className: "tag tag-ok" };
  if (summary.publish_unknown > 0) return { text: "无发布结果", className: "tag" };
  return { text: "无发布动作", className: "tag" };
}

/** 审计风险与发布结果分开成文字标记，避免同一颜色既表示数量又表示结论。 */
function riskMarkers(summary: RunAuditSummary): string[] {
  const marks: string[] = [];
  if (summary.review_invalid > 0) marks.push(`审核无效 ${summary.review_invalid}`);
  if (summary.version_stale > 0) marks.push(`读到旧版 ${summary.version_stale}`);
  if (summary.repeated_handoff > 0) marks.push(`重复交接 ${summary.repeated_handoff}`);
  return marks;
}

function shortId(runId: string): string {
  return runId.replace(/^run-/, "").slice(0, 10);
}

function fixtureName(fixture: string | null): string {
  if (!fixture) return "—";
  return fixture.split("/").pop() ?? fixture;
}

export function RunOverview({
  activeRunId,
  showFilters = true,
  onOpenRun,
  onOpenEvent,
}: {
  activeRunId: string | null;
  showFilters?: boolean;
  onOpenRun: (runId: string) => void;
  onOpenEvent: (eventId: string, timeUs: number | null, trigger?: Element | null) => void;
}) {
  const { state, dispatch } = useWorkspace();
  const [items, setItems] = useState<RunItem[]>([]);
  const [dictionary, setDictionary] = useState<{ key: string; label: string; order: number }[]>([]);
  const [meta, setMeta] = useState<{ matched_runs_total?: number; truncated?: boolean; data_version?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sample, setSample] = useState<{ runId: string; stageKey: string } | null>(null);

  const filters = state.collectionFilters;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchRuns({ includeStages: true, limit: 200 }, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setItems(payload.items);
        setDictionary(payload.stage_dictionary ?? []);
        setMeta(payload.meta as { matched_runs_total?: number; truncated?: boolean; data_version?: string });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  // 选项来源始终是完整集合，避免筛选后丢失可选值
  const options = useMemo(() => {
    const uniq = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))].sort();
    return {
      models: uniq(items.map((item) => item.model)),
      fixtures: uniq(items.map((item) => item.fixture)),
      scenarios: uniq(items.map((item) => item.scenario)),
    };
  }, [items]);

  const stages = useMemo(
    () => [...dictionary].sort((a, b) => a.order - b.order),
    [dictionary],
  );

  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (!filters.model || item.model === filters.model) &&
          (!filters.fixture || item.fixture === filters.fixture) &&
          (!filters.scenario || item.scenario === filters.scenario) &&
          (filters.observed === null || item.observed === filters.observed),
      ),
    [items, filters],
  );

  const patch = (next: Partial<typeof filters>) =>
    dispatch({ type: "display", patch: { collectionFilters: { ...filters, ...next } } });
  const clearFilters = () =>
    dispatch({ type: "display", patch: { collectionFilters: { model: null, fixture: null, scenario: null, observed: null } } });
  const activeConditions = [filters.model, filters.fixture, filters.scenario, filters.observed === null ? null : String(filters.observed)]
    .filter((value) => value !== null).length;

  if (error) {
    return (
      <section className="custom-card" aria-label="运行与阶段概览" data-testid="custom-overview">
        <div className="empty-state">
          <h2>运行摘要读取失败</h2>
          <p>{error}</p>
          <p className="muted small">请确认主库包含 CUSTOM 运行维度与阶段规则。</p>
        </div>
      </section>
    );
  }

  if (loading && items.length === 0) {
    return (
      <section className="custom-card" aria-label="运行与阶段概览" data-testid="custom-overview">
        <p className="muted small">正在读取运行阶段摘要…</p>
      </section>
    );
  }

  const stageOf = (item: RunItem, key: string): RunStageSummary | null =>
    item.stage_summary?.find((stage) => stage.key === key) ?? null;

  const sampleItem = sample ? items.find((item) => item.run_id === sample.runId) ?? null : null;
  const sampleStage: RunStageSummary | null = sample && sampleItem ? stageOf(sampleItem, sample.stageKey) : null;
  const sampleStageLabel = sample ? stages.find((stage) => stage.key === sample.stageKey)?.label ?? sample.stageKey : "";

  return (
    <section className="custom-card custom-overview" aria-label="运行与阶段概览" data-testid="custom-overview">
      <header className="custom-card-head">
        <h2>运行 × 阶段概览</h2>
        <p className="muted small">
          集合是完整运行摘要（full_run）；一个运行一行、一个阶段一格。
          {" "}
          <span data-testid="custom-overview-count">
            匹配 {visible.length} / {items.length}
          </span>
          {meta?.truncated && ` · 接口按上限截断（总数 ${meta.matched_runs_total ?? "?"}）`}
        </p>
        <span className="tag" title="阶段状态来自完整运行日志；回放与事件关键词不影响本图。">
          摘要=完整运行
        </span>
      </header>

      {showFilters && (
      <div className="custom-collection" role="group" aria-label="集合条件">
        <label className="field">
          <span>模型</span>
          <select
            value={filters.model ?? "all"}
            onChange={(event) => patch({ model: event.target.value === "all" ? null : event.target.value })}
          >
            <option value="all">全部</option>
            {options.models.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>fixture</span>
          <select
            value={filters.fixture ?? "all"}
            onChange={(event) => patch({ fixture: event.target.value === "all" ? null : event.target.value })}
          >
            <option value="all">全部</option>
            {options.fixtures.map((value) => (
              <option key={value} value={value}>{fixtureName(value)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>场景</span>
          <select
            value={filters.scenario ?? "all"}
            onChange={(event) => patch({ scenario: event.target.value === "all" ? null : event.target.value })}
          >
            <option value="all">全部</option>
            {options.scenarios.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>observed</span>
          <select
            value={filters.observed === null ? "all" : String(filters.observed)}
            onChange={(event) =>
              patch({ observed: event.target.value === "all" ? null : event.target.value === "true" })
            }
          >
            <option value="all">全部</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </label>
        {activeConditions > 0 && (
          <button type="button" className="btn btn-quiet" onClick={clearFilters}>
            清除集合条件（{activeConditions}）
          </button>
        )}
      </div>
      )}

      <div className="custom-overview-scroll">
        <div className="custom-overview-grid" role="table" aria-label="运行与阶段矩阵">
          <div className="custom-overview-row custom-overview-head" role="row">
            <span role="columnheader">运行</span>
            {stages.map((stage) => (
              <span key={stage.key} role="columnheader" title={stage.label}>
                {stage.label}
              </span>
            ))}
            <span role="columnheader">结果 / 风险</span>
          </div>

          {visible.map((item) => {
            const badge = resultBadge(item.audit);
            const marks = riskMarkers(item.audit);
            const open = sample?.runId === item.run_id;
            return (
              <div key={item.run_id} className="custom-overview-body">
                <div
                  className={`custom-overview-row${activeRunId === item.run_id ? " is-active" : ""}`}
                  role="row"
                  data-run-id={item.run_id}
                >
                  <button
                    type="button"
                    className="custom-run-identity"
                    onClick={() => onOpenRun(item.run_id)}
                    title={`${item.run_id}\nfixture ${item.fixture ?? "未知"} · ${item.event_count} 条事件 · ${formatDuration(item.duration_us)}\n打开该运行的角色流程`}
                  >
                    <span className="mono custom-run-id">{shortId(item.run_id)}</span>
                    <span className="custom-run-meta">
                      {item.model ?? "模型未知"} · {item.scenario ?? "未标注"} · observed{" "}
                      {item.observed ? "true" : "false"}
                    </span>
                  </button>

                  {stages.map((stage) => {
                    const cell = stageOf(item, stage.key);
                    const state = cell?.state ?? "unknown";
                    const detailText = cell
                      ? state === "recorded"
                        ? `${stage.label}：有记录 ${cell.count} 条 · 起点 +${formatDuration(cell.start_offset_us)} · 记录跨度 ${formatDuration(cell.duration_us)}（最多 3 条样本）`
                        : `${stage.label}：${STATE_TEXT[state]}`
                      : `${stage.label}：${STATE_TEXT.unknown}`;
                    return (
                      <button
                        key={stage.key}
                        type="button"
                        className={`custom-stage-cell is-${state}${sample?.runId === item.run_id && sample.stageKey === stage.key ? " is-selected" : ""}`}
                        data-run-id={item.run_id}
                        data-stage-key={stage.key}
                        data-stage-state={state}
                        aria-label={detailText}
                        title={detailText}
                        onClick={() =>
                          setSample((current) =>
                            current && current.runId === item.run_id && current.stageKey === stage.key
                              ? null
                              : { runId: item.run_id, stageKey: stage.key },
                          )
                        }
                      >
                        {state === "recorded" ? (
                          <span className="custom-stage-count mono">{cell?.count ?? 0}</span>
                        ) : state === "no_record" ? (
                          <span className="custom-stage-dash" aria-hidden="true">—</span>
                        ) : (
                          <span className="custom-stage-unknown" aria-hidden="true">?</span>
                        )}
                      </button>
                    );
                  })}

                  <span className="custom-run-result">
                    <span className={badge.className}>{badge.text}</span>
                    {marks.map((mark) => (
                      <span key={mark} className="custom-run-risk">{mark}</span>
                    ))}
                  </span>
                </div>

                {open && sampleStage && (
                  <div className="custom-stage-samples" role="group" aria-label="阶段样本" data-stage-key={sampleStage.key}>
                    <span className="muted small">
                      {sampleStageLabel} · {STATE_TEXT[sampleStage.state]}
                      {sampleStage.state === "recorded"
                        ? ` · 共 ${sampleStage.count} 条，下列最多 3 条样本（不是全阶段集合）`
                        : " · 没有可打开的事件"}
                    </span>
                    {sampleStage.state === "recorded" &&
                      sampleStage.sample_event_ids.map((eventId, index) => (
                        <button
                          key={eventId}
                          type="button"
                          className="btn btn-quiet"
                          data-event-id={eventId}
                          onClick={(event) => {
                            if (activeRunId !== item.run_id) onOpenRun(item.run_id);
                            onOpenEvent(eventId, null, event.currentTarget);
                          }}
                        >
                          样本 {index + 1}
                        </button>
                      ))}
                    {sampleStage.state === "recorded" && (
                      <button type="button" className="btn btn-quiet" onClick={() => onOpenRun(item.run_id)}>
                        进入运行 {shortId(item.run_id)}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {visible.length === 0 && (
        <div className="empty-state">
          <p>当前集合条件没有匹配运行。</p>
          <button type="button" className="btn" onClick={clearFilters}>
            清除集合条件
          </button>
        </div>
      )}

      <p className="muted small">
        <span className="legend-item">▢ 实底数字 = 有记录</span>
        <span className="legend-item">— 空心 = 完整日志未记录</span>
        <span className="legend-item">? 纹理 = 资料不足</span>
        <span className="legend-item legend-off">行尾文字单独标记审计风险；颜色不区分“异常”结论。</span>
      </p>
    </section>
  );
}
