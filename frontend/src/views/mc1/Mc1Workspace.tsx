import { useEffect, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchMc1Context, type Mc1DecisionPayload } from "../../data/api";
import { filterKey } from "../../data/filterContext";
import { AgentActivity } from "./AgentActivity";
import { DecisionTimeline } from "./DecisionTimeline";
import { LeadingIndicators } from "./LeadingIndicators";

/**
 * MC1 「事件时间线」主视图：上方活动矩阵，下方决策泳道与先兆候选。
 * 三次查询共享同一 FilterContext；泳道与先兆只请求一次 /api/mc1/context。
 */
export function Mc1Workspace() {
  const { filters, cursor, masking } = useWorkspace();
  const [payload, setPayload] = useState<Mc1DecisionPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = filterKey(filters, { cursor_us: masking ? cursor : undefined, masking });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchMc1Context({ filters, cursorUs: masking ? cursor : null, masking }, controller.signal)
      .then((data) => setPayload(data))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : "MC1 决策上下文加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // filters 通过 key 参与依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="mc1-workspace">
      {payload && !payload.views_available && !loading && (
        <div className="callout callout-warn">
          <strong>MC1 派生视图未加载</strong>
          <p className="muted small">
            views.json 缺失或哈希不符：活动矩阵与消息仍可读，但环境轨、约束轨与人工标记不会出现。
          </p>
        </div>
      )}
      <AgentActivity />
      <DecisionTimeline payload={payload} loading={loading} error={error} />
      <LeadingIndicators indicators={payload?.leading_indicators ?? null} />
    </div>
  );
}
