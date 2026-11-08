import { useWorkspace } from "../../state/workspace";
import type { EventDetail } from "../../data/api";
import { DualChannel } from "../../components/DualChannel";

const ROLE_LABEL = [
  { role: "support", label: "支持" },
  { role: "counter", label: "反证" },
  { role: "uncertain", label: "待核实" },
] as const;

/**
 * MC1 消息的唯一正文阅读面：外发文本/内部审议（复用 DualChannel）、原始字段与证据动作。
 * 消息列表、单条事件阅读都用它，避免同一条消息在几套页面各写一遍。
 */
export function Mc1EventDetail({
  detail,
  coverage,
}: {
  detail: EventDetail;
  coverage?: { withCount: number; total: number } | null;
}) {
  const { dataset, addToBasket, selectEvent, setEvidenceTab, setEvidenceOpen } = useWorkspace();

  const add = (role: (typeof ROLE_LABEL)[number]["role"]) =>
    addToBasket({
      event_id: detail.event_id,
      dataset,
      role,
      label: detail.event_type,
      excerpt: (detail.outgoing_text ?? detail.timestamp_raw ?? "").slice(0, 120),
    });

  return (
    <>
      <DualChannel event={detail} coverage={coverage ?? null} />

      <details className="mc1-msg-raw-details">
        <summary>原始 ID 与字段</summary>
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
      </details>

      {/* 完整源载荷按需展开：规范化字段不能替代转义前的 raw 与 details */}
      <details className="raw mc1-raw-details">
        <summary>原始载荷 raw（完整字段）</summary>
        <pre>{JSON.stringify(detail.raw, null, 2)}</pre>
      </details>
      <details className="raw mc1-raw-details">
        <summary>details（规范化载荷）</summary>
        <pre>{JSON.stringify(detail.details, null, 2)}</pre>
      </details>

      <div className="mc1-msg-actions">
        <span className="muted small">加入证据篮</span>
        {ROLE_LABEL.map((item) => (
          <button key={item.role} type="button" className="btn btn-quiet" onClick={() => add(item.role)}>
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-quiet"
          title="在证据面板查看参与实体与关系边"
          onClick={() => {
            selectEvent(detail.event_id, detail.time_us);
            setEvidenceTab("related");
            setEvidenceOpen(true);
          }}
        >
          关联上下文
        </button>
      </div>
    </>
  );
}
