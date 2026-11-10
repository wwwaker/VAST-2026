import { useEffect, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { fetchEvent, type EventDetail } from "../data/api";
import { annotationBadge, badgeClass } from "../data/labels";
import { NotesPanel } from "./NotesPanel";
import { EvidenceBasket } from "./EvidenceBasket";

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
    selectedEventAt,
    state,
    restoreMissing,
    notes,
    notesLoading,
    addNote,
    removeNote,
    noteDraft,
    setNoteDraft,
    focusEntity,
    openTrace,
    addToBasket,
  } = useWorkspace();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedEventId) {
      setEvent(null);
      return;
    }
    // 恢复快照判定缺失的事件：保留引用，但不请求已知不存在的对象
    if (restoreMissing.includes(selectedEventId)) {
      setEvent(null);
      setError("该事件在快照中被标记为缺失");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setEvent(null);
    setError(null);
    fetchEvent(dataset, selectedEventId)
      .then((detail) => {
        if (cancelled) return;
        setEvent(detail);
        // 选中事件时把关系图聚焦到它的 actor（不强制切换视图）
        if (detail.actor_id) focusEntity(detail.actor_id, { onlyIfEmpty: true });
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
  // MC1/CUSTOM 的正文与原始字段已统一在页面阅读面板里，证据侧栏只保留关联、证据篮和笔记，
  // 不再提供第二套消息阅读入口。
  const tabs =
    dataset === "MC1" || dataset === "CUSTOM"
      ? [
          { key: "related", label: "关联" },
          { key: "basket", label: "证据篮" },
          { key: "notes", label: "笔记" },
        ]
      : [
          { key: "message", label: "消息" },
          { key: "related", label: "关联" },
          { key: "raw", label: "原始记录" },
          { key: "basket", label: "证据篮" },
          { key: "notes", label: "笔记" },
        ];
  const activeTab = tabs.some((t) => t.key === evidenceTab) ? evidenceTab : tabs[0].key;

  return (
    <aside className={`drawer${dataset === "MC1" ? " drawer-wide" : ""}`} aria-label="证据侧栏">
      <div className="drawer-head">
        <h2>证据</h2>
        <button type="button" className="btn btn-quiet" onClick={() => setEvidenceOpen(false)}>
          关闭
        </button>
      </div>

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={`tab${activeTab === t.key ? " tab-active" : ""}`}
            onClick={() => setEvidenceTab(t.key as typeof evidenceTab)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="drawer-body">
        {activeTab === "basket" ? (
          <EvidenceBasket />
        ) : activeTab === "notes" ? (
          <NotesPanel
            notes={notes}
            loading={notesLoading}
            selectedEventId={selectedEventId}
            eventTime={selectedEventAt}
            onAdd={addNote}
            onRemove={removeNote}
            draft={noteDraft}
            onDraftChange={setNoteDraft}
          />
        ) : !selectedEventId && state.selection ? (
          <div className="empty-state">
            <p>已选择 {state.selection.kind === "graphEdge" ? "关系边" : state.selection.kind === "entity" ? "实体" : state.selection.kind === "file" ? "文件" : "对象"}。</p>
            <p className="muted mono">{"id" in state.selection ? state.selection.id : state.selection.kind === "graphEdge" ? `${state.selection.sourceId} → ${state.selection.targetId}` : "当前选择"}</p>
            <p className="muted small">该对象没有事件详情接口；可从关系图或事件流继续选择具体事件。</p>
          </div>
        ) : !selectedEventId ? (
          <div className="empty-state">
            <p>尚未选择事件。</p>
            <p className="muted">
              {dataset === "MC1"
                ? "在热力图、事件轨或回复网络中打开对象后，这里会显示它的参与实体与关系边。"
                : dataset === "CUSTOM"
                  ? "从阶段样本、角色泳道、配对轨迹或事件查询打开事件后，这里显示它的关联与笔记入口。"
                  : "在下方事件流中点击任意一行，或点击时间线上的红色三角锚点。"}
            </p>
            <p className="muted small">
              需要记录结论时可以切到「笔记」页，笔记存在服务端，刷新不会丢。
            </p>
          </div>
        ) : loading ? (
          <p className="muted small">正在读取事件…</p>
        ) : error ? (
          <div className="callout callout-warn">
            <strong>读取失败</strong>
            <p>{error}</p>
          </div>
        ) : !event ? null : activeTab === "message" ? (
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

            <div className="basket-add">
              <span className="muted small">加入证据篮：</span>
              {(
                [
                  { role: "support", label: "支持" },
                  { role: "counter", label: "反证" },
                  { role: "uncertain", label: "待核实" },
                ] as const
              ).map((item) => (
                <button
                  key={item.role}
                  type="button"
                  className="btn btn-quiet"
                  onClick={() =>
                    addToBasket({
                      event_id: event.event_id,
                      dataset,
                      role: item.role,
                      label: event.event_type,
                      excerpt: (event.outgoing_text ?? "").slice(0, 120),
                    })
                  }
                  title="加入后可切到「证据篮」写结论"
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* MC1 的正文/内部审议统一在页面阅读面板，这里只承接 MC2/CUSTOM 的内容字段 */}
            {details && typeof details.content === "string" && (
              <blockquote className="quote">{details.content}</blockquote>
            )}
            {details && typeof details.content_source === "string" && (
              <div className="callout callout-warn">
                <strong>日志只记录了来源文件名，未提供正文。</strong>
                <p>
                  <code>details.content_source</code> 指向文件实体{" "}
                  <code>{details.content_source}</code>。事件载荷与文件实体都没有正文文本，
                  界面不能凭空补全内容，也不能据此断言帖子的含义。
                </p>
                {dataset === "MC2" && (
                  <div className="drawer-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        openTrace({
                          rootEventId: event?.event_id ?? null,
                          fileId: `MC2:file_path:${details.content_source}`,
                        })
                      }
                      title="在来源链中打开该文件的完整操作轨迹"
                    >
                      查看文件轨迹
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => focusEntity(`MC2:file_path:${details.content_source}`, { switchView: true })}
                      title="在关系图中聚焦该文件实体"
                    >
                      在关系图中聚焦
                    </button>
                  </div>
                )}
              </div>
            )}

            {event.annotations.map((a) => {
              const badge = annotationBadge(a);
              return (
                <div key={`${a.scenario}-${a.run_id}`} className="callout">
                  <strong className={badgeClass(badge.tone)}>{badge.text}</strong>{" "}
                  <ProvenanceTag kind="hint" />
                  <p>
                    scenario <code>{a.scenario ?? "（未标注）"}</code>
                    {a.anomaly_type && <> · {a.anomaly_type}</>}
                  </p>
                  {a.reason && <p>{a.reason}</p>}
                </div>
              );
            })}

            <p className="muted small">
              来源指针 <code>{event.source_json_pointer ?? "—"}</code>
            </p>
          </div>
        ) : activeTab === "related" ? (
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
