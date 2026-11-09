import { useEffect, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchFilePostPatterns, formatUtc, type PatternChain, type PatternPayload } from "../../data/api";

function lagText(us: number | null | undefined): string {
  if (us == null) return "—";
  if (us < 1000) return `${us} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

function durationText(us: number): string {
  if (us >= 86_400_000_000) return `${(us / 86_400_000_000).toFixed(1)} 天`;
  if (us >= 3_600_000_000) return `${(us / 3_600_000_000).toFixed(1)} 小时`;
  return `${(us / 1_000_000).toFixed(0)} 秒`;
}

/** 三次“文件为内容源”的发布实例按阶段对齐；缺失阶段留空，不补。 */
export function PatternCompare({
  onOpenEvent,
}: {
  /** 阶段事件被点击时交给所在页面打开正文；只 select 会让阅读面板停在旧对象。 */
  onOpenEvent?: (eventId: string, trigger: HTMLElement) => void;
} = {}) {
  const { selectEvent } = useWorkspace();
  const [payload, setPayload] = useState<PatternPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchFilePostPatterns(null, controller.signal)
      .then((data) => setPayload(data))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取失败");
      });
    return () => controller.abort();
  }, []);

  if (error) return <div className="callout callout-warn">{error}</div>;
  if (!payload) return <p className="muted small">正在读取历史实例…</p>;

  const chains = payload.items;
  const stageRows = payload.stage_dictionary;

  return (
    <div className="pattern-view">
      <div className="trace-head">
        <strong>历史实例对齐</strong>
        <span className="muted small">
          共 {payload.total} 条以文件为内容源的发布 · 排序：{payload.ordering}
        </span>
      </div>

      <div className="pattern-scroll">
        <table className="pattern-table">
          <thead>
            <tr>
              <th scope="col">阶段</th>
              {chains.map((chain) => (
                <th key={chain.post_event_id} scope="col">
                  <span className="mono">{chain.content_file?.path ?? chain.post_event_id}</span>
                  <div className="muted small">
                    {chain.matched_stages}/{chain.stage_total} · {formatUtc(chain.post_time_us)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stageRows.map((row) => (
              <tr key={row.stage}>
                <th scope="row">{row.label}</th>
                {chains.map((chain) => {
                  const stage = chain.stages.find((item) => item.stage === row.stage);
                  if (!stage || stage.status !== "present") {
                    return (
                      <td key={chain.post_event_id} className="pattern-missing">
                        缺失
                        {stage?.note && <div className="muted small">{stage.note}</div>}
                      </td>
                    );
                  }
                  const ids = stage.event_ids?.length
                    ? stage.event_ids
                    : stage.sample_event_ids?.length
                      ? stage.sample_event_ids
                      : stage.nearest_event_id
                        ? [stage.nearest_event_id]
                        : [];
                  return (
                    <td key={chain.post_event_id}>
                      <div className="pattern-cell">
                        <span className="pattern-present">已记录</span>
                        {stage.total != null && stage.total > 1 && (
                          <span className="muted small">共 {stage.total} 次</span>
                        )}
                        {stage.nearest_lag_us != null && (
                          <span className="muted small">距发布 {lagText(stage.nearest_lag_us)}</span>
                        )}
                        <span className="pattern-events">
                          {ids.slice(0, 3).map((id) => (
                            <button
                              key={id}
                              type="button"
                              className="btn btn-quiet pattern-event"
                              onClick={(event) => {
                                selectEvent(id, null);
                                onOpenEvent?.(id, event.currentTarget);
                              }}
                              title={id}
                            >
                              {id.replace(/^MC2:event:/, "#")}
                            </button>
                          ))}
                          {ids.length > 3 && <span className="muted small">+{ids.length - 3}</span>}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="compare-cards">
        {chains.map((chain: PatternChain) => (
          <div key={chain.post_event_id} className="callout">
            <strong className="mono">{chain.content_file?.path ?? chain.post_event_id}</strong>
            <p className="muted small">
              发布 {formatUtc(chain.post_time_us)} · 参与者 {chain.actor_count} 人 ·
              观察窗 {durationText(chain.duration_us)}
            </p>
            <p className="muted small">
              指令文件 <code>{chain.instruction_file?.path ?? "未找到同名前缀文件"}</code>
              {chain.link_basis === "name_prefix" && "（对应关系来自文件名前缀）"}
            </p>
            <p className="muted small">
              缺失阶段：{chain.missing_stages.length === 0 ? "无" : chain.missing_stages.join("、")}
            </p>
          </div>
        ))}
      </div>

      <p className="muted small">{payload.link_basis_note}</p>
      <p className="muted small">{payload.note}</p>
    </div>
  );
}
