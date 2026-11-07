import { useEffect, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchIntervention, formatUtc, type InterventionPayload } from "../../data/api";

function lagText(us: number | null): string {
  if (us == null) return "—";
  return us >= 1_000_000 ? `${(us / 1_000_000).toFixed(1)} s` : `${(us / 1000).toFixed(0)} ms`;
}

/** MC2 的 actor 是 `Agent/person:chloe_ballast` 这种 ID，表格里只显示人名末段。 */
function actorName(value: string | null): string {
  if (!value) return "—";
  const tail = value.replace(/\//g, ":").split(":").filter(Boolean).pop() ?? value;
  return tail.replace(/_/g, " ");
}

/** 单点干预论证：覆盖、附带影响、可切断性、局限。 */
export function InterventionPanel() {
  const { selectEvent, state, dispatch } = useWorkspace();
  const [payload, setPayload] = useState<InterventionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = state.interventionPosition === "relay_queue";
  const setSelected = (value: boolean) => dispatch({ type: "display", patch: { interventionPosition: value ? "relay_queue" : null } });

  useEffect(() => {
    const controller = new AbortController();
    fetchIntervention("relay_queue", controller.signal)
      .then((data) => setPayload(data))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取失败");
      });
    return () => controller.abort();
  }, []);

  if (error) return <div className="callout callout-warn">{error}</div>;
  if (!payload) return <p className="muted small">正在计算干预覆盖…</p>;

  const { coverage_summary: summary, impact, cut_analysis: cut } = payload;

  return (
    <div className="intervention-view">
      <div className="trace-head">
        <strong>{payload.label}</strong>
        <span className="tag tag-warn">候选（唯一活动位置）</span>
      </div>

      <div className="callout">
        <p className="muted small">
          可执行条件：<code>{payload.predicate.event_type}</code> 的{" "}
          {payload.predicate.fields.map((field) => (
            <code key={field}>{field} </code>
          ))}
          满足「{payload.predicate.condition}」
          {payload.predicate.checkable_from_log ? "（字段在日志中可直接判断）" : "（需要新增监控字段）"}。
        </p>
      </div>

      <h3>已观测链覆盖：{summary.covered}/{summary.denominator}，其中部分链 {summary.partial_chains} 条</h3>
      <div className="pattern-scroll">
        <table className="pattern-table">
          <thead>
            <tr>
              <th scope="col">实例</th>
              <th scope="col">该阶段</th>
              <th scope="col">紧邻转交</th>
              <th scope="col">距发布</th>
              <th scope="col">链完整性</th>
            </tr>
          </thead>
          <tbody>
            {payload.coverage.map((item) => (
              <tr key={item.post_event_id}>
                <td className="mono">{item.content_file ?? item.post_event_id}</td>
                <td>{item.present ? <span className="tag tag-ok">存在</span> : "缺失"}</td>
                <td>
                  {item.nearest_event_id ? (
                    <button
                      type="button"
                      className="btn btn-quiet pattern-event"
                      onClick={() => selectEvent(item.nearest_event_id, null)}
                      title={item.nearest_actor ?? item.nearest_event_id}
                    >
                      {actorName(item.nearest_actor)}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="mono">{lagText(item.nearest_lag_us)}</td>
                <td className="muted small">
                  {item.partial_chain ? `部分（缺 ${item.missing_stages.join("、")}）` : "完整"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        缺失阶段不默认算作“拦截成功”；覆盖分母按纳入比较的链数计。
      </p>

      <h3>可能影响的正常任务</h3>
      <dl className="file-facts">
        <dt>排队任务总数</dt>
        <dd className="mono">{impact.queue_events_total.toLocaleString()} 条</dd>
        <dt>带文件路径</dt>
        <dd className="mono">
          {impact.queue_events_with_file_path} 条（命中条件才受影响）
        </dd>
        <dt>其中指向这三份指令文件</dt>
        <dd className="mono">{impact.events_on_target_files} 条</dd>
        <dt>其他指令文件</dt>
        <dd className="mono">{impact.events_on_other_files} 条</dd>
        <dt>涉及执行者</dt>
        <dd className="mono">{impact.distinct_senders} 人</dd>
      </dl>
      <p className="muted small">{impact.note}</p>
      <ul className="trace-list">
        {impact.samples.map((sample) => (
          <li key={sample.event_id}>
            <button
              type="button"
              className="trace-item"
              onClick={() => selectEvent(sample.event_id, sample.time_us)}
            >
              <span className="mono small">{formatUtc(sample.time_us)}</span>
              <span className="mono small">{sample.actor_label ?? "—"}</span>
              <span className="muted small">{sample.path ?? "—"}</span>
            </button>
          </li>
        ))}
      </ul>

      <h3>能否证明“切断即阻断”</h3>
      <div className={`callout${cut.deterministic_path_exists ? "" : " callout-warn"}`}>
        <strong>{cut.deterministic_path_exists ? "存在显式父边" : "无法对确定路径做切断证明"}</strong>
        <p className="muted small">{cut.statement}</p>
      </div>

      <h3>论证边界</h3>
      <ul className="muted small">
        {payload.limitations.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h3>实施还需的信息</h3>
      <ul className="muted small">
        {payload.extra_info_needed.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <div className="intervention-actions">
        <button
          type="button"
          className={`btn${selected ? " btn-quiet" : ""}`}
          onClick={() => setSelected(!selected)}
          aria-pressed={selected}
        >
          {selected ? "取消选择该干预位置" : "选为干预位置"}
        </button>
        <span className="muted small">{payload.constraint}</span>
      </div>
    </div>
  );
}
