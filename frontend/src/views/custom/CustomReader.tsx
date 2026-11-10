import { useEffect, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchEvent, formatUtc, type EventDetail } from "../../data/api";

const ROLES = [
  { role: "support", label: "支持" },
  { role: "counter", label: "反证" },
  { role: "uncertain", label: "待核实" },
] as const;

function scalarEntries(value: Record<string, unknown> | null): [string, string][] {
  if (!value) return [];
  return Object.entries(value)
    .filter(([, item]) => item == null || ["string", "number", "boolean"].includes(typeof item))
    .map(([key, item]) => [key, item == null ? "—" : String(item)]);
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * CUSTOM 的唯一事件阅读区：泳道、阶段样本、审计证据、配对两侧、案例证据和事件查询
 * 都打开这同一份正文。身份按事件自己的 run_id 判定，配对里点对照事件不会改当前运行。
 */
export function CustomReader({
  eventId,
  timeUs,
  currentRunId,
  baselineRunId,
  onClose,
  onResolvedTime,
}: {
  eventId: string;
  timeUs: number | null;
  currentRunId: string | null;
  baselineRunId: string | null;
  onClose: () => void;
  /** 正文接口带回真实时微秒后回填共享 selection，避免二次请求事件。 */
  onResolvedTime?: (eventId: string, timeUs: number) => void;
}) {
  const { addToBasket, selectEvent, setEvidenceTab, setEvidenceOpen } = useWorkspace();
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    fetchEvent("CUSTOM", eventId, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setDetail(data);
        onResolvedTime?.(data.event_id, data.time_us);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取事件失败");
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const add = (role: (typeof ROLES)[number]["role"]) =>
    detail &&
    addToBasket({
      event_id: detail.event_id,
      dataset: "CUSTOM",
      role,
      label: detail.event_type,
      excerpt: (textOf(detail.details?.content) ?? textOf(detail.outgoing_text) ?? detail.timestamp_raw).slice(0, 120),
    });

  const owner = detail?.run_id
    ? detail.run_id === currentRunId
      ? { text: "当前运行", className: "tag tag-ok", runId: detail.run_id }
      : detail.run_id === baselineRunId
        ? { text: "正常对照运行", className: "tag tag-warn", runId: detail.run_id }
        : { text: "其他运行", className: "tag", runId: detail.run_id }
    : null;

  const body = detail ? textOf(detail.details?.content) ?? textOf(detail.outgoing_text) : null;
  const details = scalarEntries(detail?.details ?? null);

  return (
    <section className="custom-reader" role="region" aria-label="事件原始记录" data-testid="custom-reader">
      <header className="custom-detail-head">
        <div className="custom-reader-title">
          <strong>{detail ? `事件 ${detail.event_type}` : "事件原始记录"}</strong>
          <p className="muted small">{eventId}</p>
        </div>
        <div className="custom-detail-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>

      <div className="custom-reader-body">
        {error && (
          <div className="callout callout-warn">
            <strong>事件读取失败</strong>
            <p className="muted small">
              {error}
              <span className="mono"> · {eventId}</span>
            </p>
          </div>
        )}
        {!detail && !error && <p className="muted small">正在读取事件原始记录…</p>}

        {detail && (
          <>
            <div className="custom-msg-meta">
              <span className="mono">{detail.event_id}</span>
              <span className="muted small">{detail.event_type}</span>
              {owner && (
                <span className={owner.className} data-testid="custom-event-owner">
                  {owner.text}
                  <span className="mono"> {owner.runId}</span>
                </span>
              )}
            </div>

            <p className="muted small">
              {formatUtc(detail.time_us)}
              {timeUs != null && timeUs !== detail.time_us ? `（选中记录 ${formatUtc(timeUs)}）` : ""} ·{" "}
              {detail.timezone_status === "unknown" ? "源时区未知" : detail.timezone_status.toUpperCase()}
            </p>

            <dl className="custom-facts">
              <dt>时间（源记录）</dt>
              <dd className="mono">{detail.timestamp_raw}</dd>
              <dt>run_id</dt>
              <dd className="mono">{detail.run_id ?? "（源记录未提供）"}</dd>
              <dt>执行者</dt>
              <dd className="mono">{detail.actor_id ?? "（源记录未提供）"}</dd>
              {detail.actor_rule && (
                <>
                  <dt>actor 来源</dt>
                  <dd className="mono">{detail.actor_rule}</dd>
                </>
              )}
              <dt>版本</dt>
              <dd className="mono">{detail.version ?? "—"}</dd>
              {detail.document_id && (
                <>
                  <dt>document_id</dt>
                  <dd className="mono">{detail.document_id}</dd>
                </>
              )}
              {detail.parent_event_id && (
                <>
                  <dt>父事件</dt>
                  <dd className="mono">{detail.parent_event_id}</dd>
                </>
              )}
              <dt>source_record_id</dt>
              <dd className="mono">{detail.source_record_id ?? "（源文件未提供）"}</dd>
              <dt>来源定位</dt>
              <dd className="mono">
                {detail.source_file ?? "—"}
                {detail.source_json_pointer ? ` · ${detail.source_json_pointer}` : ""}
              </dd>
            </dl>

            {body ? (
              <blockquote className="quote">{body}</blockquote>
            ) : (
              <p className="muted small">该事件的源记录没有正文文本；界面不补全内容。</p>
            )}

            {details.length > 0 && (
              <div className="custom-msg-block">
                <h4>details（规范化字段）</h4>
                <dl className="custom-facts">
                  {details.map(([key, value]) => (
                    <div key={key} className="custom-fact-row">
                      <dt>{key}</dt>
                      <dd className="mono">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <details className="raw custom-raw">
              <summary>原始载荷 raw（完整字段）</summary>
              <pre>{JSON.stringify(detail.raw, null, 2)}</pre>
            </details>
            <details className="raw custom-raw">
              <summary>details（完整 JSON）</summary>
              <pre>{JSON.stringify(detail.details, null, 2)}</pre>
            </details>

            <div className="custom-msg-actions">
              <span className="muted small">加入证据篮</span>
              {ROLES.map((item) => (
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
        )}
      </div>
    </section>
  );
}
