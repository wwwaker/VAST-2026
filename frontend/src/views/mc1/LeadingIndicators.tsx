import { useWorkspace } from "../../state/workspace";
import {
  formatUtc,
  type Mc1IndicatorCandidate,
  type Mc1IndicatorsPayload,
} from "../../data/api";

const BASIS_TEXT: Record<string, string> = {
  recorded_environment_narrative: "记录依据：环境叙事",
  pending: "待确认预期",
};

function basisLabel(basis: string): string {
  return BASIS_TEXT[basis] ?? basis;
}

/** 先兆候选：每条候选必须带规则来源与局限；没有制度依据的规则显示“待确认预期”。 */
export function LeadingIndicators({ indicators }: { indicators: Mc1IndicatorsPayload | null }) {
  const { selectEvent } = useWorkspace();

  if (!indicators) {
    return (
      <section className="mc1-block">
        <p className="muted small">先兆候选不可用（MC1 派生视图未通过哈希核验或尚未加载）。</p>
      </section>
    );
  }

  const { summary, rules, candidates, pending_rules: pendingRules } = indicators;

  return (
    <section className="mc1-block" aria-label="MC1 先兆候选">
      <div className="canvas-subbar">
        <strong>先兆候选</strong>
        <span className="muted small">
          {summary.candidate_count} 条候选 · {summary.rules_with_candidates}/{summary.rule_count} 条规则有命中 ·
          待确认预期 {summary.pending_rule_count}
        </span>
        <span className="tag">候选层，不进入已确认统计</span>
      </div>

      <p className="muted small">
        检索范围：{indicators.scan_scope}
        {indicators.target_window.start_us != null && indicators.target_window.end_us != null
          ? `；默认排除目标窗口 ${formatUtc(indicators.target_window.start_us)} → ${formatUtc(
              indicators.target_window.end_us,
            )}（${indicators.target_window.source}）`
          : ""}
      </p>

      {candidates.length === 0 && (
        <div className="callout callout-info">
          <strong>未找到足够证据</strong>
          <p className="muted small">
            当前规则在目标窗口之前没有产生可复核候选；这本身是一个可复核结论，不用推测文本凑数。
          </p>
        </div>
      )}

      <ul className="mc1-candidate-list">
        {candidates.map((candidate) => (
          <CandidateCard
            key={`${candidate.rule_id}-${candidate.event_id ?? candidate.context_id}-${candidate.time_us}`}
            candidate={candidate}
            onSelectEvent={(eventId, atUs) => selectEvent(eventId, atUs)}
          />
        ))}
      </ul>

      <details className="mc1-rules" open>
        <summary>规则与预期依据</summary>
        <ul className="tight-list">
          {rules.map((rule) => (
            <li key={rule.rule_id}>
              <div className="mc1-rule-head">
                <code className="mono">{rule.rule_id}</code>
                <span className="muted small">v{rule.version}</span>
                <span className={`tag${rule.expected_basis === "pending" ? " tag-warn" : ""}`}>
                  {basisLabel(rule.expected_basis)}
                </span>
              </div>
              <p className="muted small">{rule.description}</p>
              <p className="muted small">
                适用：{rule.applies_to} · 预期来源：
                {rule.expected_behavior_source_ids.length
                  ? rule.expected_behavior_source_ids.join("、")
                  : "无（待确认预期）"}
              </p>
              <p className="muted small">局限：{rule.limitations}</p>
            </li>
          ))}
        </ul>
      </details>

      {pendingRules.length > 0 && (
        <div className="callout callout-warn">
          <strong>待确认预期</strong>
          <p className="muted small">
            {pendingRules
              .map((rule) => `${rule.rule_id}：${rule.description}`)
              .join("；")}
            。当前数据没有给出可引用的制度或指令，因此不生成候选，也不把“未找到审核消息”判为绕过。
          </p>
        </div>
      )}

      <ul className="tight-list muted small">
        {indicators.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

function CandidateCard({
  candidate,
  onSelectEvent,
}: {
  candidate: Mc1IndicatorCandidate;
  onSelectEvent: (eventId: string, atUs: number) => void;
}) {
  return (
    <li className="mc1-candidate">
      <div className="mc1-candidate-head">
        <code className="mono">{candidate.rule_id}</code>
        <span className="tag tag-warn">{candidate.provenanceKind}</span>
        <span className="muted small">{formatUtc(candidate.time_us)}</span>
        <span className="muted small">{candidate.actor_id ?? "身份未记录"}</span>
        <span className="muted small">{candidate.channel}</span>
        {candidate.event_id && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => onSelectEvent(candidate.event_id as string, candidate.time_us)}
          >
            回查事件
          </button>
        )}
      </div>
      <p className="mc1-candidate-excerpt">{candidate.excerpt}</p>
      {candidate.hit_keywords.length > 0 && (
        <p className="muted small">命中：{candidate.hit_keywords.join("、")}</p>
      )}
      <p className="muted small">
        预期依据：{basisLabel(candidate.expected_basis)} ·{" "}
        {candidate.expected_behavior_source_ids.join("、")}
      </p>
      <p className="muted small">相似：{candidate.similarity}</p>
      <p className="muted small">不同：{candidate.difference}</p>
      <p className="muted small">局限：{candidate.limitations}</p>
      {candidate.context_id && (
        <p className="muted small">
          背景记录（context_id）：<code className="mono">{candidate.context_id}</code>
        </p>
      )}
    </li>
  );
}
