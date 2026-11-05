import { useState } from "react";
import { formatUtc, type NoteItem } from "../data/api";

/** 调查笔记：人工结论，与数据标签、规则线索分开存放，写入服务端。 */
export function NotesPanel({
  notes,
  loading,
  selectedEventId,
  eventTime,
  onAdd,
  onRemove,
}: {
  notes: NoteItem[];
  loading: boolean;
  selectedEventId: string | null;
  eventTime: number | null;
  onAdd: (body: string, options?: { eventId?: string | null; eventTime?: number | null }) => Promise<void>;
  onRemove: (noteId: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attachToEvent = selectedEventId != null;

  const submit = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(draft, {
        eventId: attachToEvent ? selectedEventId : null,
        eventTime: attachToEvent ? eventTime : null,
      });
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notes">
      <div className="notes-editor">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="记录判断、支持证据、反证与未确定项…"
          rows={3}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          }}
        />
        <div className="notes-actions">
          <span className="muted small">
            {attachToEvent ? (
              <>
                将关联到事件 <code>{selectedEventId}</code>
              </>
            ) : (
              "未选择事件，仅记录当前筛选条件"
            )}
          </span>
          <button type="button" className="btn" onClick={() => void submit()} disabled={busy || !draft.trim()}>
            {busy ? "保存中…" : "保存笔记"}
          </button>
        </div>
        {error && <p className="notes-error">保存失败：{error}</p>}
      </div>

      {notes.length === 0 ? (
        <p className="muted small">
          {loading ? "正在读取…" : "还没有笔记。笔记写入服务端，刷新或重启浏览器都不会丢。"}
        </p>
      ) : (
        <ul className="note-list">
          {notes.map((n) => (
            <li key={n.note_id} className="note-item">
              <div className="note-body">{n.body}</div>
              <div className="note-meta">
                <span className="mono">{n.created_at.replace("T", " ").slice(0, 16)}</span>
                {n.event_id && (
                  <span className="mono" title={n.event_id}>
                    事件 {n.event_id.slice(-12)}
                  </span>
                )}
                {n.event_time != null && (
                  <span className="mono">
                    {formatUtc(n.event_time > 1e12 ? n.event_time : n.event_time * 1e6)}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-quiet note-del"
                  onClick={() => void onRemove(n.note_id)}
                  aria-label="删除笔记"
                >
                  删除
                </button>
              </div>
              {n.filter_summary && <div className="note-filter muted small">{n.filter_summary}</div>}
            </li>
          ))}
        </ul>
      )}

      <p className="muted small">
        笔记属于人工结论，与数据标签、规则线索并列但不同源；导出报告时应保留其筛选快照。
      </p>
    </div>
  );
}
