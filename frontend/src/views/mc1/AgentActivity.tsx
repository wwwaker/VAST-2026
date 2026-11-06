import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchMc1Activity, formatUtc, formatUtcDate, type Mc1ActivityPayload } from "../../data/api";
import { filterKey } from "../../data/filterContext";

type Granularity = "day" | "hour" | "round";
type Scope = "both" | "public" | "internal";

const PUBLIC_CHANNELS = [
  "MC1:channel:personal_post",
  "MC1:channel:official_post",
  "MC1:channel:anonymous_post",
];
const INTERNAL_CHANNELS = [
  "MC1:channel:comms_huddle",
  "MC1:channel:side_huddle",
  "MC1:channel:one_on_one_chat",
];

const DAY_US = 86_400_000_000;

/** 7 个 agent × 天/小时/轮次矩阵；公开与内部渠道分开计数。 */
export function AgentActivity() {
  const { filters, setFilters } = useWorkspace();
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [collapsed, setCollapsed] = useState(false);
  const [payload, setPayload] = useState<Mc1ActivityPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const key = filterKey(filters, { granularity });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchMc1Activity({ granularity, filters }, controller.signal)
      .then((data) => setPayload(data))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : "活动矩阵加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // filters 通过 key 参与依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cellMap = useMemo(() => {
    const map = new Map<string, Mc1ActivityPayload["cells"][number]>();
    for (const cell of payload?.cells ?? []) map.set(`${cell.agent_id}|${cell.bucket}`, cell);
    return map;
  }, [payload]);

  const columnLabel = (column: Mc1ActivityPayload["columns"][number]) => {
    if (!column.start_us) return column.label;
    if (granularity === "day") return formatUtcDate(column.start_us).slice(5);
    if (granularity === "hour") return formatUtc(column.start_us).slice(5);
    return column.label;
  };

  // 渠道范围以统一筛选为准，避免本地 state 与 FilterContext 分叉
  const scope: Scope =
    filters.channels.length === 0
      ? "both"
      : filters.channels.some((channel) => PUBLIC_CHANNELS.includes(channel))
        ? "public"
        : "internal";

  const applyScope = (next: Scope) => {
    setFilters({
      channels: next === "public" ? PUBLIC_CHANNELS : next === "internal" ? INTERNAL_CHANNELS : [],
    });
  };

  const pickCell = (agentId: string, bucketKey: string, expand: boolean) => {
    const column = payload?.columns.find((item) => item.key === bucketKey);
    if (!column || column.start_us == null || column.end_us == null) return;
    let start = column.start_us;
    let end = column.end_us;
    if (expand) {
      // Shift：扩展到列所在整天，便于把该 agent 的上下文一起看
      start = Math.floor(column.start_us / DAY_US) * DAY_US;
      end = start + DAY_US;
    }
    setFilters({ startUs: start, endUs: end, actorId: agentId });
  };

  return (
    <section className="mc1-block" aria-label="角色活动矩阵">
      <div className="canvas-subbar">
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "展开活动矩阵" : "收起活动矩阵"}
        </button>
        <div className="seg" role="group" aria-label="矩阵粒度">
          {(["day", "hour", "round"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`seg-item${granularity === item ? " seg-active" : ""}`}
              aria-pressed={granularity === item}
              onClick={() => setGranularity(item)}
            >
              {item === "day" ? "按天" : item === "hour" ? "按小时" : "按轮次"}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="渠道范围">
          {(["both", "public", "internal"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`seg-item${scope === item ? " seg-active" : ""}`}
              aria-pressed={scope === item}
              onClick={() => applyScope(item)}
            >
              {item === "both" ? "全部渠道" : item === "public" ? "公开发布" : "内部渠道"}
            </button>
          ))}
        </div>
        <span className="muted small">
          点击格 → 设置时间与 agent；Shift 点击 → 扩到整天。空格表示该时段无记录，不等于未执行职责。
        </span>
      </div>

      {error && (
        <div className="callout callout-warn">
          <strong>活动矩阵不可用</strong>
          <p className="muted small">{error}</p>
        </div>
      )}
      {loading && !payload && <p className="muted small">正在读取活动矩阵…</p>}

      {!collapsed && payload && (
        <>
          <p className="muted small">
            记录消息 {payload.matched_messages} 条 · 公开 {payload.public_messages} · 内部{" "}
            {payload.internal_messages}
            {granularity === "round" ? " · 轮次列使用派生轮次边界" : ""}
          </p>
          <div className="activity-grid-wrap">
            <table className="activity-table">
              <thead>
                <tr>
                  <th scope="col">agent</th>
                  {payload.columns.map((column) => (
                    <th key={column.key} scope="col" title={column.label}>
                      {columnLabel(column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payload.agents.map((agent) => (
                  <tr key={agent.agent_id}>
                    <th scope="row" title={agent.agent_id}>
                      {agent.label ?? agent.agent_id.split(":").pop()}
                    </th>
                    {payload.columns.map((column) => {
                      const cell = cellMap.get(`${agent.agent_id}|${column.key}`);
                      const publicCount = cell?.public ?? 0;
                      const internalCount = cell?.internal ?? 0;
                      const showPublic = scope !== "internal";
                      const showInternal = scope !== "public";
                      return (
                        <td key={column.key}>
                          <button
                            type="button"
                            className={`activity-cell${cell?.empty ? " activity-cell-empty" : ""}`}
                            onClick={(event) =>
                              pickCell(agent.agent_id, column.key, event.shiftKey)
                            }
                            title={
                              cell?.empty
                                ? `${agent.label ?? agent.agent_id} · ${column.label}：无记录（中性空状态）`
                                : `${agent.label ?? agent.agent_id} · ${column.label}：公开 ${publicCount} / 内部 ${internalCount}`
                            }
                            aria-label={
                              cell?.empty
                                ? `${agent.agent_id} ${column.label} 无记录`
                                : `${agent.agent_id} ${column.label} 公开 ${publicCount} 内部 ${internalCount}`
                            }
                          >
                            {cell?.empty ? (
                              <span className="muted">—</span>
                            ) : (
                              <>
                                {showPublic && publicCount > 0 && (
                                  <span className="activity-count activity-public">{publicCount}</span>
                                )}
                                {showInternal && internalCount > 0 && (
                                  <span className="activity-count activity-internal">{internalCount}</span>
                                )}
                              </>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            图例：<span className="activity-count activity-public">n</span> 公开渠道 ·
            <span className="activity-count activity-internal">n</span> 内部渠道 · — 无记录（不是“未执行职责”）
          </p>
        </>
      )}
    </section>
  );
}
