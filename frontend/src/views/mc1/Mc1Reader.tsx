import { useEffect, useState, type ReactNode } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchEvent, formatUtc, type EventDetail } from "../../data/api";
import { Mc1EventDetail } from "./Mc1EventDetail";

/**
 * MC1 唯一对象阅读面板：热力格、回复边、角色节点、环境记录和事件轨中的单条消息
 * 都落在同一个面板里，按需展开正文与原始字段，不再各自叠一个详情卡。
 */
export function Mc1Reader({
  title,
  meta,
  actions,
  onClose,
  ariaLabel,
  testId,
  dataTotal,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  ariaLabel: string;
  testId?: string;
  dataTotal?: number | string;
  children: ReactNode;
}) {
  return (
    <section
      className="mc1-reader"
      role="region"
      aria-label={ariaLabel}
      data-testid={testId}
      data-total={dataTotal}
    >
      <header className="mc1-detail-head">
        <div className="mc1-reader-title">
          <strong>{title}</strong>
          {meta && <p className="muted small">{meta}</p>}
        </div>
        <div className="mc1-detail-actions">
          {actions}
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>
      <div className="mc1-reader-body">{children}</div>
    </section>
  );
}

/** 事件轨里单条消息的阅读面：与消息列表共用正文、审议、原始字段和证据动作。 */
export function Mc1EventReader({
  eventId,
  timeUs,
  channel,
  preview,
  coverage,
}: {
  eventId: string;
  timeUs: number | null;
  channel: string | null;
  preview?: string;
  coverage?: { withCount: number; total: number } | null;
}) {
  const { dataset } = useWorkspace();
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    fetchEvent(dataset, eventId, controller.signal)
      .then((data) => !controller.signal.aborted && setDetail(data))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取事件失败");
      });
    return () => controller.abort();
  }, [dataset, eventId]);

  if (error) {
    return (
      <div className="callout callout-warn">
        <strong>事件读取失败</strong>
        <p className="muted small">{error}</p>
      </div>
    );
  }

  return (
    <div className="mc1-msgs">
      <p className="mc1-msgs-scope">
        <span className="mono">{timeUs != null ? formatUtc(timeUs) : detail ? formatUtc(detail.time_us) : "时间待读取"}</span>
        {(() => {
          const channelLabel = channel?.split(":").pop() ?? detail?.channel_id?.split(":").pop() ?? null;
          return channelLabel ? ` · ${channelLabel}` : "";
        })()}
        {preview ? ` · ${preview}` : ""}
      </p>
      {!detail ? (
        <p className="muted small">正在读取事件正文…</p>
      ) : (
        <Mc1EventDetail detail={detail} coverage={coverage} />
      )}
    </div>
  );
}
