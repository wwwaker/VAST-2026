import { useEffect, useState, type ReactNode } from "react";
import { useWorkspace } from "../../state/workspace";
import { useTheme } from "../../theme/theme";
import { fetchEvent, fetchEvents, formatUtc, type EventDetail, type EventItem } from "../../data/api";
import { FileTrack } from "./FileTrack";

const ROLE_LABEL = [
  { role: "support", label: "支持" },
  { role: "counter", label: "反证" },
  { role: "uncertain", label: "待核实" },
] as const;

/** MC2 的唯一对象阅读外壳：事件、文件轨迹、实体事件都落在同一个面板里。 */
export function Mc2Reader({
  title,
  meta,
  actions,
  onClose,
  ariaLabel,
  testId,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  ariaLabel: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="mc2-reader" role="region" aria-label={ariaLabel} data-testid={testId}>
      <header className="mc2-detail-head">
        <div className="mc2-reader-title">
          <strong>{title}</strong>
          {meta && <p className="muted small">{meta}</p>}
        </div>
        <div className="mc2-detail-actions">
          {actions}
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>
      <div className="mc2-reader-body">{children}</div>
    </section>
  );
}

function scalarEntries(value: Record<string, unknown> | null): [string, string][] {
  if (!value) return [];
  return Object.entries(value)
    .filter(([, item]) => item == null || ["string", "number", "boolean"].includes(typeof item))
    .map(([key, item]) => [key, item == null ? "—" : String(item)]);
}

/** 单条事件：原始记录、参与者/关系边、来源文件与证据动作。 */
export function Mc2EventReader({
  eventId,
  timeUs,
  onOpenFile,
  onSetRoot,
}: {
  eventId: string;
  timeUs: number | null;
  onOpenFile: (fileId: string, path: string) => void;
  onSetRoot: (eventId: string) => void;
}) {
  const { addToBasket, selectEvent, setEvidenceTab, setEvidenceOpen } = useWorkspace();
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    fetchEvent("MC2", eventId, controller.signal)
      .then((data) => !controller.signal.aborted && setDetail(data))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取事件失败");
      });
    return () => controller.abort();
  }, [eventId]);

  const contentSource =
    detail?.details && typeof detail.details.content_source === "string" ? detail.details.content_source : null;
  const content =
    detail?.details && typeof detail.details.content === "string" ? detail.details.content : null;

  const add = (role: (typeof ROLE_LABEL)[number]["role"]) =>
    detail &&
    addToBasket({
      event_id: detail.event_id,
      dataset: "MC2",
      role,
      label: detail.event_type,
      excerpt: (detail.outgoing_text ?? detail.timestamp_raw ?? "").slice(0, 120),
    });

  if (error) {
    return (
      <div className="callout callout-warn">
        <strong>事件读取失败</strong>
        <p className="muted small">{error}</p>
      </div>
    );
  }
  if (!detail) {
    return <p className="muted small">正在读取事件原始记录…</p>;
  }

  const details = scalarEntries(detail.details);

  return (
    <>
      <div className="mc2-msg-meta">
        <span className="mono">{detail.event_id}</span>
        <span className="muted small">{detail.event_type}</span>
        <span className="muted small">
          {formatUtc(detail.time_us)}
          {timeUs != null && timeUs !== detail.time_us ? `（当前选中 ${formatUtc(timeUs)}）` : ""} ·{" "}
          {detail.timezone_status === "unknown" ? "源时区未知" : detail.timezone_status.toUpperCase()}
        </span>
      </div>

      <dl className="mc2-facts">
        <dt>时间（源记录）</dt>
        <dd className="mono">{detail.timestamp_raw}</dd>
        <dt>执行者</dt>
        <dd className="mono">{detail.actor_id ?? "（源记录未提供）"}</dd>
        {detail.actor_rule && (
          <>
            <dt>actor 来源</dt>
            <dd className="mono">{detail.actor_rule}</dd>
          </>
        )}
        <dt>source_record_id</dt>
        <dd className="mono">{detail.source_record_id ?? "（源文件未提供）"}</dd>
        <dt>来源定位</dt>
        <dd className="mono">
          {detail.source_file ?? "—"}
          {detail.source_json_pointer ? ` · ${detail.source_json_pointer}` : ""}
        </dd>
        {detail.parent_event_id && (
          <>
            <dt>父事件</dt>
            <dd className="mono">{detail.parent_event_id}</dd>
          </>
        )}
      </dl>

      {content && <blockquote className="quote">{content}</blockquote>}

      {contentSource && (
        <div className="callout callout-warn">
          <strong>日志只记录了来源文件名，没有提供正文。</strong>
          <p className="muted small">
            <code>details.content_source</code> 指向文件 <code>{contentSource}</code>；事件载荷与文件实体都没有正文文本。
            界面不补全内容，也不据此断言帖子的含义。
          </p>
          <div className="mc2-reader-actions">
            <button
              type="button"
              className="btn"
              onClick={() => onOpenFile(`MC2:file_path:${contentSource}`, contentSource)}
            >
              查看文件轨迹
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => onSetRoot(detail.event_id)}>
              以它为链根
            </button>
          </div>
        </div>
      )}

      {details.length > 0 && (
        <div className="mc2-msg-block">
          <h4>details（规范化字段）</h4>
          <dl className="mc2-facts">
            {details.map(([key, value]) => (
              <div key={key} className="mc2-fact-row">
                <dt>{key}</dt>
                <dd className="mono">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="mc2-msg-block">
        <h4>参与者与关系边</h4>
        <ul className="mc2-participants">
          {detail.participants.map((item) => (
            <li key={`${item.entity_id}-${item.role}`}>
              <span className="mono small">{item.entity_id}</span>
              <span className="role-chip">
                {item.role} · {item.derivation}
              </span>
            </li>
          ))}
        </ul>
        {detail.relations.length > 0 && (
          <ul className="mc2-participants">
            {detail.relations.map((item, index) => (
              <li key={`${item.relation}-${index}`}>
                <span className="mono small">
                  {item.src_id ?? "（源未知）"} → {item.dst_id}
                </span>
                <span className={`role-chip${item.target_kind === "event" ? " role-chip-event" : ""}`}>
                  {item.relation} · {item.direction}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">关系类型为源字段直读；时间先后与共同参与不等于因果。</p>
      </div>

      <details className="raw mc2-raw-details">
        <summary>原始载荷 raw（完整字段）</summary>
        <pre>{JSON.stringify(detail.raw, null, 2)}</pre>
      </details>
      <details className="raw mc2-raw-details">
        <summary>details（完整 JSON）</summary>
        <pre>{JSON.stringify(detail.details, null, 2)}</pre>
      </details>

      <div className="mc2-msg-actions">
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

/** 文件在当前来源链里的身份；恢复快照后由链结果重新判断，不依赖页面局部标记。 */
export type FileKind = "candidate" | "recorded" | "unknown";

/** 文件轨迹：内容状态、操作分布与分页事件；点行切换到该事件的原始记录。 */
export function Mc2FileReader({
  fileId,
  onOpenEvent,
  onPickRoot,
  kind,
}: {
  fileId: string;
  onOpenEvent: (eventId: string, timeUs: number, trigger?: Element | null) => void;
  onPickRoot: (eventId: string) => void;
  kind: FileKind;
}) {
  return (
    <>
      {kind === "candidate" && (
        <p className="callout callout-warn small" role="status" data-testid="mc2-file-kind">
          候选文件：仅因文件名前缀与当前链根的文件相同而被列出，日志没有记录它被转交给发布者。
          它的操作记录不等于已记录的传播链，也不等于传播证据。
        </p>
      )}
      {kind === "unknown" && (
        <p className="callout small" role="status" data-testid="mc2-file-kind">
          当前来源链没有把该文件标为“记录”或“候选”（可能来自其它链根或旧快照）。
          文件实体本身来自日志，但它与本链根的关系仍待核实，不能把这里的操作当作已证实关联。
        </p>
      )}
      <FileTrack fileId={fileId} onOpenEvent={onOpenEvent} onPickRoot={onPickRoot} />
    </>
  );
}

/** 聚合成员：真实实体 ID 只作当前筛选下的样本，不冒充全量事件。 */
export function Mc2EntityReader({
  entityId,
  label,
  onOpenEvent,
}: {
  entityId: string;
  label: string;
  onOpenEvent: (eventId: string, timeUs: number, trigger?: Element | null) => void;
}) {
  const { filters, cursor, masking } = useWorkspace();
  const { colors } = useTheme();
  const [items, setItems] = useState<EventItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setItems([]);
    setTotal(null);
    fetchEvents(
      {
        dataset: "MC2",
        filters: { ...filters, participantId: entityId },
        limit: 50,
        direction: "desc",
        cursorUs: masking ? cursor : null,
        masking,
      },
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setTotal(page.meta.matched_events);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取实体事件失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [entityId, filters, cursor, masking]);

  return (
    <>
      <p className="mc2-msgs-scope">
        当前筛选 ∩ 该实体作为参与者
        {total != null ? ` · 共 ${total.toLocaleString()} 条（最多显示 50）` : ""}
        {filters.actorId && filters.actorId !== entityId ? " · 执行者筛选与实体不同，结果可能为空集" : ""}
      </p>
      {error && <p className="stream-error">{error}</p>}
      {loading && items.length === 0 && <p className="muted small">正在读取该实体的事件…</p>}
      <ul className="stream-list mc2-entity-events">
        {items.map((item) => (
          <li key={item.event_id}>
            <button type="button" className="stream-row" onClick={(event) => onOpenEvent(item.event_id, item.time_us, event.currentTarget)}>
              <span className="stream-time mono">{formatUtc(item.time_us)}</span>
              <span
                className="stream-dot"
                style={{ background: colors.categories[Math.max(0, Math.min(7, item.category - 1))] }}
                aria-hidden="true"
              />
              <span className="stream-type">{item.event_type}</span>
              <span className="stream-preview">{item.preview || "（无摘要）"}</span>
            </button>
          </li>
        ))}
      </ul>
      {!loading && !error && items.length === 0 && (
        <p className="muted small">
          {label} 在当前筛选下没有事件（空集不等于该实体不存在）。
        </p>
      )}
    </>
  );
}
