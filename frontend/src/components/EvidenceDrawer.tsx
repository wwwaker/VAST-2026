import { useEffect, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { fetchDatasets, fetchEvent, type EventDetail } from "../data/api";
import { DualChannel } from "./DualChannel";

/** 证据分层标签：把"数据里记了什么"和"我们推断出什么"分开呈现 */
function ProvenanceTag({ kind }: { kind: "observed" | "derived" | "hint" | "conclusion" }) {
  const labels = {
    observed: "原始观测",
    derived: "规范化解释",
    hint: "分析线索",
    conclusion: "人工结论",
  } as const;
  return <span className={`prov prov-${kind}`}>{labels[kind]}</span>;
}

export function EvidenceDrawer() {
  const {
    dataset,
    evidenceOpen,
    setEvidenceOpen,
    evidenceTab,
    setEvidenceTab,
    selectedEventId,
    notes,
    focusEntity,
  } = useWorkspace();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [coverage, setCoverage] = useState<{ withCount: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDatasets()
      .then((list) => {
        if (cancelled) return;
        const info = list.find((d) => d.dataset_id === dataset);
        if (info) setCoverage({ withCount: info.deliberation_count, total: info.event_count });
      })
      .catch(() => setCoverage(null));
    return () => {
      cancelled = true;
    };
  }, [dataset]);

  useEffect(() => {
    if (!selectedEventId) {
      setEvent(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchEvent(dataset, selectedEventId)
      .then((detail) => {
        if (cancelled) return;
        setEvent(detail);
        // 选中事件时把关系图聚焦到它的 actor（不强制切换视图）
        if (detail.actor_id) focusEntity(detail.actor_id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "读取失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataset, selectedEventId]);

  if (!evidenceOpen) return null;

  const details = event?.details ?? null;

  return (
    <aside className={`drawer${dataset === "MC1" ? " drawer-wide" : ""}`} aria-label="证据侧栏">
      <div className="drawer-head">
        <h2>证据</h2>
        <button type="button" className="btn btn-quiet" onClick={() => setEvidenceOpen(false)}>
          关闭
        </button>
      </div>

      <div className="tabs" role="tablist">
        {[
          { key: "message", label: "消息" },
          { key: "related", label: "关联" },
          { key: "raw", label: "原始记录" },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={evidenceTab === t.key}
            className={`tab${evidenceTab === t.key ? " tab-active" : ""}`}
            onClick={() => setEvidenceTab(t.key as typeof evidenceTab)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="drawer-body">
        {!selectedEventId ? (
          <div className="empty-state">
            <p>尚未选择事件。</p>
            <p className="muted">在下方事件流中点击任意一行，或点击时间线上的红色三角锚点。</p>
            {notes.length > 0 && (
              <>
                <h3>已保存的笔记</h3>
                <ul className="note-list">
                  {notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : loading ? (
          <p className="muted small">正在读取事件…</p>
        ) : error ? (
          <div className="callout callout-warn">
            <strong>读取失败</strong>
            <p>{error}</p>
          </div>
        ) : !event ? null : evidenceTab === "message" ? (
          <div className="evidence">
            <div className="evidence-meta">
              <span className="mono">{event.event_id}</span>
              <ProvenanceTag kind="observed" />
            </div>
            <dl className="kv">
              <dt>时间</dt>
              <dd>
                {event.timestamp}
                <span className="muted"> · {event.event_type}</span>
              </dd>
              <dt>actor</dt>
              <dd className="mono">{event.actor_id ?? "（源记录未提供）"}</dd>
              {event.actor_rule && (
                <>
                  <dt>actor 来源</dt>
                  <dd>
                    <code>{event.actor_rule}</code> <ProvenanceTag kind="derived" />
                  </dd>
                </>
              )}
              {event.source_missing_id && (
                <>
                  <dt>源记录 ID</dt>
                  <dd className="muted small">源文件未提供，已回落为事件 ID</dd>
                </>
              )}
            </dl>

            {dataset === "MC1" ? (
              <DualChannel event={event} coverage={coverage} />
            ) : (
              details &&
              typeof details.content === "string" && (
                <blockquote className="quote">{details.content}</blockquote>
              )
            )}
            {details && typeof details.content_source === "string" && (
              <div className="callout callout-warn">
                <strong>正文不在事件记录中。</strong>
                <p>
                  该事件的 <code>details.content_source</code> 指向文件实体{" "}
                  <code>{details.content_source}</code>，正文需另行读取文件内容。界面不能凭空补全这段文字。
                </p>
              </div>
            )}

            {event.annotations.map((a) => (
              <div key={`${a.scenario}-${a.run_id}`} className="callout">
                <strong>{a.observed ? "已观测异常" : "已配置为异常但未观测到"}</strong>{" "}
                <ProvenanceTag kind="hint" />
                <p>
                  scenario <code>{a.scenario}</code>
                  {a.anomaly_type && <> · {a.anomaly_type}</>}
                </p>
                {a.reason && <p>{a.reason}</p>}
              </div>
            ))}

            <p className="muted small">
              来源指针 <code>{event.source_json_pointer ?? "—"}</code>
            </p>
          </div>
        ) : evidenceTab === "related" ? (
          <div className="evidence">
            <h3>参与者</h3>
            <p className="muted small">点击任一参与者，可在关系图中以它为中心展开。</p>
            <ul className="participants">
              {event.participants.map((p) => (
                <li key={`${p.entity_id}-${p.role}`}>
                  <button
                    type="button"
                    className="participant-btn"
                    onClick={() => focusEntity(p.entity_id, { switchView: true })}
                    title="在关系图中聚焦"
                  >
                    <span className="mono">{p.label ?? p.entity_id}</span>
                    <span className="role-chip">{p.role}</span>
                  </button>
                </li>
              ))}
            </ul>
            {event.relations.length > 0 && (
              <>
                <h3>关系边</h3>
                <ul className="participants">
                  {event.relations.map((r, i) => (
                    <li key={i}>
                      <span className="mono">
                        {r.src_id ?? "（源未知）"} → {r.dst_id}
                      </span>
                      <span className={`role-chip${r.target_kind === "event" ? " role-chip-event" : ""}`}>
                        {r.relation}
                        {r.target_kind === "event" && " · 指向事件"}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="muted small">
              关系类型为源字段直读，属于<ProvenanceTag kind="derived" />；时间先后与共同参与不等于因果关系。
            </p>
          </div>
        ) : (
          <div className="evidence">
            <p className="muted small">原始载荷默认折叠；只在选中事件时读取，不参与列表查询。</p>
            <details className="raw" open={false}>
              <summary>展开 raw 原始记录</summary>
              <pre>{JSON.stringify(event.raw, null, 2)}</pre>
            </details>
            <details className="raw">
              <summary>展开 details</summary>
              <pre>{JSON.stringify(event.details, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </aside>
  );
}
