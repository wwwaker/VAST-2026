import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { useTheme } from "../theme/theme";
import { fetchCompare, formatDuration, formatUtc, type ComparePayload } from "../data/api";

const RATIO_FLAG = 2;

const COVERAGE_TEXT: Record<ComparePayload["window"]["coverage_status"], string> = {
  full: "完整",
  partial: "部分",
  before_data: "数据范围之前",
  unknown: "未知",
};

/** datetime-local 不带时区；本应用统一按 UTC 解释，避免浏览器本地时区偷换时刻 */
function parseUtcInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  return Number.isFinite(ms) ? ms * 1000 : null;
}

function toUtcInput(us: number): string {
  return new Date(Math.floor(us / 1000) * 1000).toISOString().slice(0, 16);
}

export function CompareView() {
  const {
    dataset,
    filters,
    dispatch,
    setCanvasView,
    cursor,
    masking,
    compareState,
    setCompareState,
  } = useWorkspace();
  const { colors } = useTheme();

  const { dimension, mode, baselineStartUs, baselineEndUs } = compareState;
  const [payload, setPayload] = useState<ComparePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const startUs = filters.startUs;
  const endUs = filters.endUs;
  const manualValid =
    mode !== "manual" ||
    (baselineStartUs != null && baselineEndUs != null && baselineStartUs < baselineEndUs);
  const manualIncomplete = mode === "manual" && !manualValid;

  // 进入手选模式时用当前已应用值或前一等长窗填草稿；不覆盖用户正在输入的内容
  useEffect(() => {
    if (mode !== "manual") return;
    if (baselineStartUs != null && baselineEndUs != null) {
      setDraftStart(toUtcInput(baselineStartUs));
      setDraftEnd(toUtcInput(baselineEndUs));
    } else if (startUs != null && endUs != null) {
      const span = endUs - startUs;
      setDraftStart(toUtcInput(startUs - span));
      setDraftEnd(toUtcInput(startUs));
    }
  }, [mode, baselineStartUs, baselineEndUs, startUs, endUs]);

  useEffect(() => {
    if (startUs == null || endUs == null) {
      setPayload(null);
      return;
    }
    if (manualIncomplete) {
      setPayload(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchCompare(
      {
        dataset,
        filters,
        dimension,
        baselineStartUs: mode === "manual" ? baselineStartUs : null,
        baselineEndUs: mode === "manual" ? baselineEndUs : null,
        cursorUs: cursor,
        masking,
      },
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setPayload(data);
          if (data.baseline.start_us != null && data.baseline.end_us != null) dispatch({ type: "resolvedWindow", currentUs: [startUs, endUs], baselineUs: [data.baseline.start_us, data.baseline.end_us] });
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [dataset, filters, dimension, mode, baselineStartUs, baselineEndUs, cursor, masking, startUs, endUs, manualIncomplete]);

  const maxAbsDelta = useMemo(
    () => Math.max(0.0001, ...(payload?.rows ?? []).map((row) => Math.abs(row.delta ?? 0))),
    [payload],
  );

  const flagged = useMemo(
    () =>
      (payload?.rows ?? []).filter(
        (row) => row.is_new || (row.ratio != null && (row.ratio >= RATIO_FLAG || row.ratio <= 1 / RATIO_FLAG)),
      ),
    [payload],
  );

  const draftOverlap = useMemo(() => {
    if (mode !== "manual" || startUs == null || endUs == null) return 0;
    const draftS = parseUtcInput(draftStart);
    const draftE = parseUtcInput(draftEnd);
    if (draftS == null || draftE == null || draftS >= draftE) return 0;
    return Math.max(0, Math.min(endUs, draftE) - Math.max(startUs, draftS));
  }, [mode, draftStart, draftEnd, startUs, endUs]);

  const enterManual = () => {
    if (baselineStartUs != null && baselineEndUs != null) {
      setCompareState({ mode: "manual" });
      return;
    }
    if (startUs != null && endUs != null) {
      const span = endUs - startUs;
      setCompareState({ mode: "manual", baselineStartUs: startUs - span, baselineEndUs: startUs });
    } else {
      setCompareState({ mode: "manual" });
    }
  };

  const fillPrevious = () => {
    if (startUs == null || endUs == null) return;
    const span = endUs - startUs;
    setDraftStart(toUtcInput(startUs - span));
    setDraftEnd(toUtcInput(startUs));
    setFormError(null);
  };

  const applyManual = () => {
    const nextStart = parseUtcInput(draftStart);
    const nextEnd = parseUtcInput(draftEnd);
    if (nextStart == null || nextEnd == null) {
      setFormError("时间格式应为 YYYY-MM-DDTHH:mm（按 UTC 解释）");
      return;
    }
    if (nextStart >= nextEnd) {
      setFormError("历史窗起点必须早于终点");
      return;
    }
    setFormError(null);
    setCompareState({ mode: "manual", baselineStartUs: nextStart, baselineEndUs: nextEnd });
  };

  const drillDown = (row: ComparePayload["rows"][number]) => {
    const evidence = row.evidence_filter;
    // 先保存完整比较状态（筛选 + 对照方式），返回时恢复原窗口与历史窗
    dispatch({ type: "drillFilters", patch: {
      startUs: evidence.start_us,
      endUs: evidence.end_us,
      actorId: dimension === "actor" && row.key !== "__unknown__" ? row.key : null,
      eventTypes: dimension === "event_type" ? [row.key] : [],
    } });
  };

  if (startUs == null || endUs == null) {
    return (
      <div className="empty-state">
        <h2>先选一个时间窗</h2>
        <p>
          基线比较需要一个「当前窗口」。在时间线上拖动选取一段，或点击锚点跳到该时刻 ±1 小时，
          这里会自动与等长的前一个窗口对比，也可以手选历史窗。
        </p>
        <button type="button" className="btn" onClick={() => setCanvasView("timeline")}>
          去时间线刷选
        </button>
      </div>
    );
  }

  const baselineBeforeData = payload?.baseline.coverage_status === "before_data";
  const partial =
    payload?.window.coverage_status === "partial" || payload?.baseline.coverage_status === "partial";

  return (
    <div className="compare">
      <div className="compare-head">
        <div>
          <h2>基线比较</h2>
          <p className="muted small">
            当前 {formatUtc(startUs)} → {formatUtc(endUs)}
            {payload && (
              <>
                （{formatDuration(payload.window.in_range_duration_us)} 有效 ·{" "}
                {payload.window.events.toLocaleString()} 条 · 覆盖{" "}
                {COVERAGE_TEXT[payload.window.coverage_status]} · {payload.window.observed_bucket_count} 桶）
              </>
            )}
            · 基线{" "}
            {payload
              ? `${formatUtc(payload.baseline.start_us ?? 0)} → ${formatUtc(payload.baseline.end_us ?? 0)}（${formatDuration(
                  payload.baseline.in_range_duration_us,
                )} 有效 · ${payload.baseline.events.toLocaleString()} 条 · 覆盖 ${
                  COVERAGE_TEXT[payload.baseline.coverage_status]
                }）`
              : mode === "manual"
                ? "手选窗待应用"
                : "自动取等长的前一窗口"}
          </p>
          <p className="muted small">
            窗口为半开区间 [start, end)：分界事件只属于右侧窗口。手选时间按 UTC 解释。
            {masking && cursor != null && ` 回放遮蔽生效，基线也截止到 ${formatUtc(cursor)}。`}
          </p>
        </div>
        <div className="compare-controls">
          <div className="seg" role="group" aria-label="对照方式">
            <button
              type="button"
              className={`seg-item${mode === "auto" ? " seg-active" : ""}`}
              aria-pressed={mode === "auto"}
              onClick={() => setCompareState({ mode: "auto", baselineStartUs: null, baselineEndUs: null })}
            >
              自动前一窗
            </button>
            <button
              type="button"
              className={`seg-item${mode === "manual" ? " seg-active" : ""}`}
              aria-pressed={mode === "manual"}
              onClick={enterManual}
            >
              手选历史窗
            </button>
          </div>
          <div className="seg" role="group" aria-label="比较维度">
            {(
              [
                { key: "event_type", label: "按事件类型" },
                { key: "actor", label: "按主体" },
              ] as const
            ).map((item) => (
              <button
                key={item.key}
                type="button"
                className={`seg-item${dimension === item.key ? " seg-active" : ""}`}
                onClick={() => setCompareState({ dimension: item.key })}
                aria-pressed={dimension === item.key}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === "manual" && (
        <div className="compare-manual">
          <label className="compare-manual-field">
            <span>历史窗起（UTC）</span>
            <input
              type="datetime-local"
              className="text-input"
              value={draftStart}
              step={60}
              onChange={(event) => setDraftStart(event.target.value)}
            />
          </label>
          <label className="compare-manual-field">
            <span>历史窗止（UTC）</span>
            <input
              type="datetime-local"
              className="text-input"
              value={draftEnd}
              step={60}
              onChange={(event) => setDraftEnd(event.target.value)}
            />
          </label>
          <div className="compare-manual-actions">
            <button type="button" className="btn" onClick={applyManual}>
              应用历史窗
            </button>
            <button type="button" className="btn btn-quiet" onClick={fillPrevious}>
              填入前一等长窗
            </button>
          </div>
          {formError && <p className="compare-manual-error">{formError}</p>}
          {draftOverlap > 0 && (
            <p className="muted small">
              草稿与当前窗口相交 {formatDuration(draftOverlap)}；应用后会在下方标出，请调整。
            </p>
          )}
        </div>
      )}

      {dataset === "CUSTOM" && (
        <div className="callout">
          <strong>自建数据更适合按运行配对比较</strong>
          <p>
            直接用墙钟窗口会把不同模型、任务和场景混在一起。这里的结果只能当作筛选预览，
            正式对照应选择同 model/fixture 的正常运行。
          </p>
        </div>
      )}

      {manualIncomplete && (
        <div className="callout callout-warn">
          <strong>手选历史窗尚未生效</strong>
          <p>填写起止时间并点击「应用历史窗」；起止都按 UTC 解释，且起点必须早于终点。</p>
        </div>
      )}

      {error && (
        <div className="callout callout-warn">
          <strong>比较失败</strong>
          <p>{error}</p>
        </div>
      )}

      {!payload && !error && !manualIncomplete && (
        <p className="muted small">{loading ? "正在计算…" : "暂无数据"}</p>
      )}

      {payload && (
        <>
          {baselineBeforeData && (
            <div className="callout callout-warn">
              <strong>基线窗口完全落在数据范围之前</strong>
              <p>该窗口没有任何记录，也不能当作真实的零活动。换一段更靠后的窗口再比较。</p>
            </div>
          )}

          {partial && !baselineBeforeData && (
            <div className="callout callout-warn">
              <strong>观察范围不完整</strong>
              <p>
                请求窗口与数据范围只有部分交集；速率按交集时长计算，缺失时段不计为“无活动”。
              </p>
            </div>
          )}

          {payload.overlap_us > 0 && (
            <div className="callout callout-warn">
              <strong>当前窗口与基线相交</strong>
              <p>交集 {formatDuration(payload.overlap_us)}，边界样本会同时影响两侧，请调整窗口。</p>
            </div>
          )}

          {flagged.length > 0 && (
            <p className="muted small">
              有 {flagged.length} 项偏离超过 {RATIO_FLAG} 倍或属新增。这是统计偏离，不是异常结论
              ——点击任意一行可跳到对应事件证据，返回时恢复原历史窗。
            </p>
          )}

          <div className="compare-table">
            <div className="compare-row compare-header">
              <span className="cmp-label">{dimension === "actor" ? "主体" : "事件类型"}</span>
              <span className="cmp-num">当前/时</span>
              <span className="cmp-num">基线/时</span>
              <span className="cmp-bar-head">变化</span>
            </div>

            {payload.rows.map((row) => {
              const deviated =
                row.is_new || (row.ratio != null && (row.ratio >= RATIO_FLAG || row.ratio <= 1 / RATIO_FLAG));
              const width = (Math.abs(row.delta ?? 0) / maxAbsDelta) * 50;
              return (
                <button
                  key={row.key}
                  type="button"
                  className={`compare-row compare-row-button${deviated ? " compare-deviated" : ""}`}
                  onClick={() => drillDown(row)}
                  title={`查看证据：当前 ${row.window_count} 条 / 基线 ${row.baseline_count} 条`}
                >
                  <span className="cmp-label">
                    {row.label}
                    {row.is_new && <span className="tag tag-risk">新增</span>}
                    {row.is_absent && <span className="tag tag-warn">消失</span>}
                    {row.small_sample && <span className="tag">小样本</span>}
                  </span>
                  <span className="cmp-num">
                    {row.window_rate == null ? "—" : row.window_rate.toFixed(2)}
                    <span className="muted small"> n={row.window_count}</span>
                  </span>
                  <span className="cmp-num">
                    {row.baseline_rate == null ? "—" : row.baseline_rate.toFixed(2)}
                    <span className="muted small"> n={row.baseline_count}</span>
                  </span>
                  <span className="cmp-bar">
                    <span className="cmp-axis" />
                    {row.delta != null && row.delta >= 0 ? (
                      <span
                        className="cmp-fill cmp-fill-up"
                        style={{ left: "50%", width: `${width}%`, background: colors.risk }}
                      />
                    ) : (
                      <span
                        className="cmp-fill cmp-fill-down"
                        style={{ right: "50%", width: `${width}%`, background: colors.textFaint }}
                      />
                    )}
                    <span className="cmp-ratio">{row.ratio == null ? "—" : `${row.ratio.toFixed(2)}x`}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <p className="muted small">{payload.metric_note}</p>
          <p className="muted small">
            基线只反映“这段时间里通常发生什么”，不反映“应该发生什么”。系统行为随时间合理漂移时，
            偏离也可能来自正常的负载变化——判断前请结合事件流与原始记录。
          </p>
          {loading && <p className="muted small">更新中…</p>}
        </>
      )}
    </div>
  );
}
