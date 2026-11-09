import { useEffect, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { useTheme } from "../../theme/theme";
import {
  fetchFileTrack,
  formatUtc,
  type ContentStatus,
  type EventItem,
  type FileTrackPayload,
} from "../../data/api";
import { filterKey } from "../../data/filterContext";

const PAGE = 100;

const STATUS_TEXT: Record<ContentStatus, string> = {
  available: "正文可用",
  metadata_only: "仅有元数据",
  unresolved: "无法解析",
};

function statusClass(status: ContentStatus): string {
  if (status === "available") return "tag tag-ok";
  if (status === "metadata_only") return "tag tag-warn";
  return "tag tag-risk";
}

/** 单个文件的操作轨迹。内容缺失时明确说缺什么，不提供伪造预览。 */
export function FileTrack({
  fileId,
  onPickRoot,
  onOpenEvent,
}: {
  fileId: string;
  onPickRoot?: (eventId: string) => void;
  /** 提供时单击行会打开所在页面的阅读面板；否则只更新共享选中事件。 */
  onOpenEvent?: (eventId: string, timeUs: number, trigger?: Element | null) => void;
}) {
  const { filters, cursor, masking, selectedEventId, selectEvent } = useWorkspace();
  const { colors } = useTheme();
  const [payload, setPayload] = useState<FileTrackPayload | null>(null);
  const [items, setItems] = useState<(EventItem & { file_relations: string[] })[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = filterKey(filters, {
    file: fileId,
    cursor_us: masking ? cursor : undefined,
    masking,
  });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchFileTrack(
      { fileId, filters, limit: PAGE, cursorUs: masking ? cursor : null, masking },
      controller.signal,
    )
      .then((data) => {
        setPayload(data);
        setItems(data.items);
        setNextCursor(data.next_cursor);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "文件轨迹加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // filters 以 key 的形式参与依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadMore = () => {
    if (!nextCursor) return;
    const controller = new AbortController();
    fetchFileTrack(
      { fileId, filters, limit: PAGE, cursor: nextCursor, cursorUs: masking ? cursor : null, masking },
      controller.signal,
    )
      .then((data) => {
        setItems((prev) => [...prev, ...data.items]);
        setNextCursor(data.next_cursor);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载更多失败"));
  };

  if (error) {
    return (
      <section className="file-track">
        <h3>文件轨迹</h3>
        <p className="stream-error">{error}</p>
      </section>
    );
  }
  if (!payload) {
    return (
      <section className="file-track">
        <h3>文件轨迹</h3>
        <p className="muted small">{loading ? "正在读取文件轨迹…" : "未选择文件"}</p>
      </section>
    );
  }

  const file = payload.file;
  return (
    <section className="file-track" aria-label="文件轨迹">
      <header className="file-track-head">
        <div>
          <h3 className="mono">{file.path}</h3>
          <p className="muted small">
            <span className={statusClass(file.content_status)}>{STATUS_TEXT[file.content_status]}</span>{" "}
            {file.reason}
          </p>
        </div>
        <span className="muted small">{payload.meta.matched_events} 条事件</span>
      </header>

      <dl className="file-facts">
        {file.size_hint != null && (
          <>
            <dt>size_hint</dt>
            <dd className="mono">{file.size_hint.toLocaleString()} 字节（仅元数据）</dd>
          </>
        )}
        <dt>操作分布</dt>
        <dd>
          {Object.entries(file.event_type_counts).map(([type, count]) => (
            <span key={type} className="role-chip">
              {type} × {count}
            </span>
          ))}
        </dd>
        <dt>关系口径</dt>
        <dd className="muted small">
          {Object.entries(payload.relation_counts)
            .map(([relation, count]) => `${relation} ${count}`)
            .join(" · ")}
        </dd>
      </dl>

      {file.missing_fields.length > 0 && (
        <div className="callout callout-warn">
          <strong>缺少字段：{file.missing_fields.join("、")}</strong>
          <p className="muted small">
            可支持：{file.supports.join("；")}。
          </p>
          <p className="muted small">
            不能支持：{file.cannot_support.join("；")}。正文缺失时不做推测补全。
          </p>
        </div>
      )}

      <ul className="stream-list file-events">
        {items.map((item) => (
          <li key={item.event_id} className={onPickRoot ? "file-track-row" : undefined}>
            <button
              type="button"
              className={`stream-row${selectedEventId === item.event_id ? " stream-row-active" : ""}`}
              title="查看该事件的原始记录"
              onClick={(event) => {
                selectEvent(item.event_id, item.time_us);
                onOpenEvent?.(item.event_id, item.time_us, event.currentTarget);
              }}
            >
              <span className="stream-time mono">{formatUtc(item.time_us)}</span>
              <span
                className="stream-dot"
                style={{ background: colors.categories[Math.max(0, Math.min(7, item.category - 1))] }}
                aria-hidden="true"
              />
              <span className="stream-type">{item.event_type}</span>
              <span className="stream-actor mono">{item.actor_label ?? item.actor_id ?? "—"}</span>
              <span className="stream-preview">{item.preview || "（无正文摘要）"}</span>
              <span className="role-chip">{item.file_relations.join("/")}</span>
            </button>
            {onPickRoot && (
              <button
                type="button"
                className="btn btn-quiet file-track-root"
                title="以该事件为链根重新追踪"
                onClick={() => onPickRoot(item.event_id)}
              >
                设为链根
              </button>
            )}
          </li>
        ))}
      </ul>

      {nextCursor && (
        <button type="button" className="btn stream-more" onClick={loadMore} disabled={loading}>
          {loading ? "加载中…" : "加载更多"}
        </button>
      )}
      <p className="muted small">{payload.naming_note}</p>
    </section>
  );
}
