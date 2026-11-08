import { useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchEvent, formatUtc, type EventDetail, type EventItem } from "../../data/api";

/**
 * 参考项目 messagePanels 的本地化版本：列表只给摘要，正文/内部审议/原始字段按需展开。
 * 数据来自 /api/events（列表）与 /api/events/{id}（详情），点击不改变全局筛选。
 */
export function Mc1MessageList({
  items,
  loading,
  error,
  emptyText,
  total,
  scopeNote,
}: {
  items: EventItem[];
  loading: boolean;
  error: string | null;
  emptyText: string;
  total?: number | null;
  scopeNote?: string;
}) {
  const { dataset, selectEvent, setEvidenceOpen, setEvidenceTab } = useWorkspace();
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, EventDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<{ id: string; message: string } | null>(null);

  const toggle = async (item: EventItem) => {
    selectEvent(item.event_id, item.time_us);
    if (openId === item.event_id) {
      setOpenId(null);
      return;
    }
    setOpenId(item.event_id);
    if (details[item.event_id]) return;
    setDetailLoading(item.event_id);
    setDetailError(null);
    try {
      const data = await fetchEvent(dataset, item.event_id);
      setDetails((prev) => ({ ...prev, [item.event_id]: data }));
    } catch (err) {
      setDetailError({
        id: item.event_id,
        message: err instanceof Error ? err.message : "读取消息详情失败",
      });
    } finally {
      setDetailLoading((current) => (current === item.event_id ? null : current));
    }
  };

  if (error) {
    return (
      <div className="callout callout-warn">
        <strong>消息集合读取失败</strong>
        <p className="muted small">{error}</p>
      </div>
    );
  }

  return (
    <div className="mc1-msgs">
      {scopeNote && <p className="mc1-msgs-scope">{scopeNote}</p>}
      {loading && items.length === 0 && <p className="muted small">正在读取消息集合…</p>}
      {!loading && items.length === 0 && <p className="muted small">{emptyText}</p>}
      {items.length > 0 && (
        <ol className="mc1-msg-list">
          {items.map((item) => {
            const expanded = openId === item.event_id;
            const detail = details[item.event_id];
            return (
              <li key={item.event_id} className={`mc1-msg${expanded ? " is-open" : ""}`}>
                <button
                  type="button"
                  className="mc1-msg-head"
                  aria-expanded={expanded}
                  onClick={() => void toggle(item)}
                >
                  <span className="mc1-msg-time mono">{formatUtc(item.time_us)}</span>
                  <span className="mc1-msg-actor">{item.actor_label ?? item.actor_id ?? "未标注 actor"}</span>
                  <span className="mc1-msg-channel mono">{item.channel_id?.split(":").pop() ?? "—"}</span>
                  <span className="mc1-msg-preview">{item.preview || "（无摘要）"}</span>
                  <span className="mc1-msg-badges">
                    {item.has_deliberation && <span className="tag tag-delib">内部审议</span>}
                    {item.source_missing_id && <span className="tag tag-warn">来源记录缺失</span>}
                    {item.annotations.length > 0 && (
                      <span className="tag">{item.annotations[0].anomaly_type ?? "标记"}</span>
                    )}
                  </span>
                </button>

                {expanded && (
                  <div className="mc1-msg-body">
                    {detailLoading === item.event_id && <p className="muted small">正在读取原始记录…</p>}
                    {detailError?.id === item.event_id && (
                      <div className="callout callout-warn">
                        <strong>详情读取失败</strong>
                        <p className="muted small">{detailError.message}</p>
                      </div>
                    )}
                    {detail && (
                      <>
                        <section className="mc1-msg-channel-block">
                          <h4>外发内容</h4>
                          <p className="mc1-msg-text">
                            {detail.outgoing_text ?? "该事件没有可读的外发正文（可能是动作或状态记录）。"}
                          </p>
                        </section>
                        <section className="mc1-msg-channel-block">
                          <h4>
                            内部审议
                            {detail.deliberation ? (
                              <span className="tag tag-delib">已记录</span>
                            ) : (
                              <span className="tag">无记录</span>
                            )}
                          </h4>
                          {detail.deliberation ? (
                            <dl className="mc1-msg-deliberation">
                              {Object.entries(detail.deliberation).map(([key, value]) => (
                                <div key={key}>
                                  <dt className="mono">{key}</dt>
                                  <dd>{value}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : (
                            <p className="muted small">
                              源记录没有 internal_state 字段，不能据正文推测内部审议。
                            </p>
                          )}
                        </section>
                        <section className="mc1-msg-channel-block">
                          <h4>原始字段</h4>
                          <dl className="mc1-msg-raw">
                            <div>
                              <dt>event_id</dt>
                              <dd className="mono">{detail.event_id}</dd>
                            </div>
                            <div>
                              <dt>source_record_id</dt>
                              <dd className="mono">{detail.source_record_id ?? "—"}</dd>
                            </div>
                            <div>
                              <dt>源时间</dt>
                              <dd className="mono">
                                {detail.timestamp_raw}（{detail.timezone_status === "unknown" ? "源时区未知" : detail.timezone_status}）
                              </dd>
                            </div>
                            <div>
                              <dt>类型 / 渠道</dt>
                              <dd className="mono">
                                {detail.event_type} · {detail.channel_id ?? "—"}
                              </dd>
                            </div>
                            <div>
                              <dt>来源定位</dt>
                              <dd className="mono">
                                {detail.source_file ?? "—"}
                                {detail.source_json_pointer ? ` · ${detail.source_json_pointer}` : ""}
                              </dd>
                            </div>
                            {detail.parent_event_id && (
                              <div>
                                <dt>父事件</dt>
                                <dd className="mono">{detail.parent_event_id}</dd>
                              </div>
                            )}
                          </dl>
                        </section>
                        <div className="mc1-msg-actions">
                          <button
                            type="button"
                            className="btn btn-quiet"
                            onClick={() => {
                              selectEvent(detail.event_id, detail.time_us);
                              setEvidenceTab("message");
                              setEvidenceOpen(true);
                            }}
                          >
                            在证据面板查看
                          </button>
                          <button
                            type="button"
                            className="btn btn-quiet"
                            onClick={() => {
                              selectEvent(detail.event_id, detail.time_us);
                              setEvidenceTab("basket");
                            }}
                          >
                            去证据篮标注支持/反证
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {total != null && total > items.length && (
        <p className="muted small">
          只显示最近 {items.length} 条，共 {total} 条匹配；缩小时间窗或筛选后可看到更早记录。
        </p>
      )}
    </div>
  );
}
