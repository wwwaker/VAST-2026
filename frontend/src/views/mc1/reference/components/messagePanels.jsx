
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatRecipients } from '../utils.js';
import {
  EVENT_RELATED_BY_MESSAGE_ID, SEQ_KINDS,
  agentLabelOf, roleLabelOf, channelLabelOf, messageTypeLabelOf, visibilityLabelOf,
} from '../constants.js';
import { messageNumber } from '../commIdMap.js';
import { AGENTS } from '../network.jsx';

export function MessageDetailPanel({ requestStatus, onRetry, selected, selectedCellData, selectedSemantic, semanticComparisonMode, collapsed, setCollapsed, messages, rounds, selectedMessageId, messageContext, contextStatus, onSelectMessage, onOpenFlow }) {
  if (!selected) {
    return <div className="detail-card empty"><span className="muted">点击热力图单元格或时间表头，即可在此查看对应消息。</span></div>;
  }
  const count = selectedCellData?.message_count ?? messages.length;
  return (
    <div className="detail-card">
      <div className="detail-summary" onClick={() => setCollapsed(c => !c)}>
        <button className="collapse-btn" aria-label="展开或收起">
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <div className="ds-text">
          <b>{agentLabelOf(selected.agent.agent_id, selected.agent.agent_label)}</b>
          <span className="ds-pipe">|</span> {selected.bucket}
          <span className="ds-pipe">|</span> {count} 条消息
        </div>
        <span className="ds-hint">{collapsed ? '展开消息' : '收起'}</span>
      </div>

      {!collapsed && (
        <div className="detail-body">
          {/* event context */}
          {rounds.length > 0 && (
            <div className="rounds">
              {rounds.map(r => (
                <article className="round" key={r.hour}>
                  <div className="round-hour">{r.hour}</div>
                  <h4>{r.event_headline || '（无标题）'}</h4>
                  <p>{r.event_narrative || ''}</p>
                  <div className="chips">
                    {r.has_merger_context && <span className="merger">合并相关背景</span>}
                  </div>
                </article>
              ))}
            </div>
          )}

          <h3>消息（{messages.length}）</h3>
          <MessageList status={requestStatus} messages={messages} selectedMessageId={selectedMessageId} onSelectMessage={onSelectMessage} />

          {requestStatus === 'error' && <button className="flow-btn" onClick={onRetry}>重试加载</button>}

          {/* clicking any message opens the related-messages chat popup */}
          {selectedMessageId && (
            <div className="ctx-hint">
              <span className="muted">
                {contextStatus === 'loading' ? '正在加载相关消息…'
                  : contextStatus === 'error' ? '无法加载相关消息。'
                  : '相关消息已在对话弹窗中打开。'}
              </span>
              <button className="flow-btn" onClick={(e) => { e.stopPropagation(); onOpenFlow && onOpenFlow(); }}>
                打开对话
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageList({ status, messages, selectedMessageId, onSelectMessage, renderExtra }) {
  if (status === 'loading') return <p className="muted" role="status">正在加载消息…</p>;
  if (status === 'error') return <p className="muted" role="alert">消息加载失败，请重新选择或刷新后重试。</p>;
  if (!messages.length) {
    return <p className="muted">没有消息符合当前筛选条件。</p>;
  }
  return messages.map(m => (
    <article
      className={`message clickable${m.message_id === selectedMessageId ? ' selected' : ''}`}
      key={m.message_id}
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelectMessage?.(m.message_id); } }}
      onClick={() => onSelectMessage && onSelectMessage(m.message_id)}
      title="点击查看该消息的上下文 / 相关消息"
    >
      {renderExtra && renderExtra(m)}
      <div className="msg-meta">
        {m.comm_id != null && <span className="comm-id">#{m.comm_id}</span>}
        <b>{m.timestamp}</b>
        <span>{agentLabelOf(m.agent_id, m.agent_label)}</span>
        <span>{channelLabelOf(m.channel)}</span>
        <span>{visibilityLabelOf(m.visibility)}</span>
        {m.keyword_score > 0 && <span className="keyword-score">关键词得分：{m.keyword_score}</span>}
        {m.is_merger_related && <span className="merger">内容含合并关键词</span>}
        {m.internal_merger_related && <span className="internal-merger">内心想法含合并关键词</span>}
        {EVENT_RELATED_BY_MESSAGE_ID.has(m.message_id) &&
          EVENT_RELATED_BY_MESSAGE_ID.get(m.message_id).map(ev => {
            const kind = SEQ_KINDS[ev.kind] || SEQ_KINDS.decision;
            return (
              <span key={ev.id} className="event-related"
                style={{ borderColor: kind.color, color: kind.color }}
                title={`事件相关消息 · ${ev.title}（${kind.label}）`}>
                事件相关 · {kind.label}
              </span>
            );
          })}
      </div>
      <div className="sub-meta">
        角色：{roleLabelOf(m.agent_role) || '-'} / 收件人：{formatRecipients(m.recipients)} / 回复对象：{(() => {
          if (!m.responding_to) return '-';
          const n = messageNumber(m.responding_to);
          return n != null ? `#${n}` : m.responding_to;
        })()}
      </div>
      <p>{m.content}</p>
      {m.reply_class === 'reply_future_reference' && <p className="provenance-note">原文引用了晚于本消息的记录；保留引用，不计入历史回复链。</p>}
      {(m.internal_reacting || m.internal_rationalizing || m.internal_deliberating) && (
        <details onClick={e => e.stopPropagation()}>
          <summary>内心状态</summary>
          {m.internal_reacting && <p><b>即时反应：</b> {m.internal_reacting}</p>}
          {m.internal_rationalizing && <p><b>自我说服：</b> {m.internal_rationalizing}</p>}
          {m.internal_deliberating && <p><b>权衡斟酌：</b> {m.internal_deliberating}</p>}
        </details>
      )}
    </article>
  ));
}

export function EdgeMessagesPanel({ requestStatus, selectedEdge, messages, collapsed, setCollapsed, selectedMessageId, messageContext, contextStatus, onSelectMessage, onOpenFlow }) {
  if (!selectedEdge) {
    return <div className="detail-card empty"><span className="muted">点击网络图中的一条连线，即可在此查看这条关系背后的消息。</span></div>;
  }
  const { sourceLabel, targetLabel, channel, message_type: messageType, mention } = selectedEdge;
  // comms_huddle 的广播与行动是两条不同的连线，标题里也要带上 message_type。
  const channelText = channel === 'comms_huddle' && messageType
    ? `${channelLabelOf(channel)}（${messageTypeLabelOf(messageType)}）`
    : channelLabelOf(channel);
  return (
    <div className="detail-card">
      <div className="detail-summary" onClick={() => setCollapsed(c => !c)}>
        <button className="collapse-btn" aria-label="展开或收起">
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <div className="ds-text">
          <b>{sourceLabel}</b> {mention ? '点名致意' : '→'} <b>{targetLabel}</b>
          {!mention && <><span className="ds-pipe">|</span> {channelText}</>}
          <span className="ds-pipe">|</span> {messages.length} 条消息
        </div>
        <span className="ds-hint">{collapsed ? '展开消息' : '收起'}</span>
      </div>

      {!collapsed && (
        <div className="detail-body">
          <h3>消息（{messages.length}）</h3>
          <MessageList status={requestStatus} messages={messages} selectedMessageId={selectedMessageId} onSelectMessage={onSelectMessage} />

          {selectedMessageId && (
            <div className="ctx-hint">
              <span className="muted">
                {contextStatus === 'loading' ? '正在加载相关消息…'
                  : contextStatus === 'error' ? '无法加载相关消息。'
                  : '相关消息已在对话弹窗中打开。'}
              </span>
              <button className="flow-btn" onClick={(e) => { e.stopPropagation(); onOpenFlow && onOpenFlow(); }}>
                打开对话
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Network node click → Node Messages Panel
// Bir node seçilince o agent'ın (mevcut network filtresiyle) gönderdiği TÜM
// mesajları gösterir — reply graph'ta edge'e dönüşmeyen broadcast / root
// mesajlar dahil. Bu mesajlara daha önce chat panelinden erişilemiyordu.
export function NodeMessagesPanel({ requestStatus, node, messages, collapsed, setCollapsed, selectedMessageId, contextStatus, onSelectMessage, onOpenFlow }) {
  if (!node) return null;
  const nonReply = messages.filter(m => !m.resolved_parent_id).length;
  return (
    <div className="detail-card">
      <div className="detail-summary" onClick={() => setCollapsed(c => !c)}>
        <button className="collapse-btn" aria-label="展开或收起">
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <div className="ds-text">
          <b>{node.label}</b> — 全部发出的消息
          <span className="ds-pipe">|</span> {messages.length} 条消息
          {nonReply > 0 && <><span className="ds-pipe">|</span> ◌ {nonReply} 条非回复（广播/主题起点）</>}
        </div>
        <span className="ds-hint">{collapsed ? '展开消息' : '收起'}</span>
      </div>

      {!collapsed && (
        <div className="detail-body">
          <h3>消息（{messages.length}）</h3>
          <MessageList
            status={requestStatus}
            messages={messages}
            selectedMessageId={selectedMessageId}
            onSelectMessage={onSelectMessage}
            renderExtra={(m) => !m.resolved_parent_id ? (
              <span className="bc-chip" title="该消息不是对其他 Agent 的回复——它是对全体成员的广播，或是一条开启话题的帖子，因此在回复图中没有连线。">
                ◌ 非回复（广播/主题起点）
              </span>
            ) : null}
          />

          {selectedMessageId && (
            <div className="ctx-hint">
              <span className="muted">
                {contextStatus === 'loading' ? '正在加载相关消息…'
                  : contextStatus === 'error' ? '无法加载相关消息。'
                  : '相关消息已在对话弹窗中打开。'}
              </span>
              <button className="flow-btn" onClick={(e) => { e.stopPropagation(); onOpenFlow && onOpenFlow(); }}>
                打开对话
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RelatedMessages({ status, context, selectedMessageId, onSelectMessage, onOpenFlow }) {
  if (status === 'loading') {
    return <div className="context-section"><span className="muted">正在加载相关消息…</span></div>;
  }
  if (status === 'error') {
    return <div className="context-section"><span className="muted">无法加载相关消息。</span></div>;
  }
  if (!context || !context.found) {
    return <div className="context-section"><span className="muted">未找到该消息的上下文。</span></div>;
  }

  const groups = [
    ['上级消息', context.parent_message ? [context.parent_message] : []],
    ['回复', context.replies || []],
    ['时间邻近', context.temporal_neighbors || []],
    ['同渠道', context.same_channel_context || []],
    ['同 Agent', context.same_agent_context || []],
    ['关键词相关', context.keyword_related || []],
  ];
  const why = context.selected_message && context.selected_message.why_matters;
  const sel = context.selected_message;

  return (
    <div className="context-section" onClick={e => e.stopPropagation()}>
      <div className="ctx-header-row">
        <div className="ctx-header">所选消息的上下文</div>
        <button className="flow-btn" onClick={() => onOpenFlow && onOpenFlow()}>对话流</button>
      </div>
      {sel && (
        <div className="ctx-focused">
          <div className="ctx-item-meta">
            {sel.comm_id != null && <span className="comm-id">#{sel.comm_id}</span>}
            <span className="ctx-badge">{channelLabelOf(sel.channel)}</span>
            <span className="ctx-agent">{agentLabelOf(sel.agent_id, sel.agent_label)}</span>
            <span className="ctx-ts">{sel.timestamp}</span>
          </div>
          <div className="ctx-preview">
            {(sel.content || '').slice(0, 200)}{(sel.content || '').length > 200 ? '…' : ''}
          </div>
        </div>
      )}
      {why && <div className="why-matters"><b>为什么重要：</b> {why}</div>}
      {groups.every(([, items]) => items.length === 0) && (
        <span className="muted">该消息没有相关消息。</span>
      )}
      {groups.map(([label, items]) => (
        items.length > 0 && (
          <div className="ctx-group" key={label}>
            <div className="ctx-group-title">{label} ({items.length})</div>
            {items.map(it => (
              <div
                className={`ctx-item${it.message_id === selectedMessageId ? ' selected' : ''}`}
                key={`${label}-${it.message_id}`}
                onClick={() => onSelectMessage && onSelectMessage(it.message_id)}
                title="点击聚焦该消息"
              >
                <div className="ctx-item-meta">
                  {it.comm_id != null && <span className="comm-id">#{it.comm_id}</span>}
                  <span className="ctx-badge">{channelLabelOf(it.channel)}</span>
                  <span className="ctx-agent">{agentLabelOf(it.agent_id, it.agent_label)}</span>
                  <span className="ctx-ts">{it.timestamp}</span>
                  <span className="ctx-reason">{it.relation_reason}</span>
                </div>
                <div className="ctx-preview">
                  {(it.content || '').slice(0, 160)}{(it.content || '').length > 160 ? '…' : ''}
                </div>
              </div>
            ))}
          </div>
        )
      ))}
    </div>
  );
}

// Conversation Flow modal (chat-history style)
const KIND_TAG = {
  direct: { label: '直接回复', color: '#22c55e' },
  addressed: { label: '点名致意', color: '#f59e0b' },
  root: { label: '话题起点', color: '#7f93ad' },
};

export function ConversationFlowModal({ open, context, status, selectedMessageId, onClose, onSelectMessage }) {
  const modalRef = useRef(null);
  const returnFocus = useRef(null);
  const [history, setHistory] = useState([]);
  const restoreScroll = useRef(null);
  useEffect(() => {
    if (!open) { setHistory([]); restoreScroll.current = null; return; }
    const root = modalRef.current?.getRootNode();
    returnFocus.current = root?.activeElement || document.activeElement;
    modalRef.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = oldOverflow; returnFocus.current?.focus?.({ preventScroll: true }); };
  }, [open]);
  useEffect(() => {
    if (open && status === '' && context?.found) {
      if (restoreScroll.current !== null) {
        modalRef.current.querySelector('.flow-list').scrollTop = restoreScroll.current;
        restoreScroll.current = null;
      } else {
        modalRef.current?.querySelector('.chat-bubble.selected')?.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [open, status, selectedMessageId, context]);
  const select = id => {
    if (id === selectedMessageId) return;
    setHistory(h => [...h, { id: selectedMessageId, scroll: modalRef.current?.querySelector('.flow-list')?.scrollTop || 0 }]);
    onSelectMessage?.(id);
  };
  const back = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory(h => h.slice(0, -1));
    restoreScroll.current = previous.scroll;
    onSelectMessage?.(previous.id);
  };
  const handleKeys = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    if (e.key === 'Tab') {
      const nodes = [...modalRef.current.querySelectorAll('button:not(:disabled),[tabindex="0"],summary,a[href]')];
      const active = modalRef.current.getRootNode().activeElement;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && (active === first || active === modalRef.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first?.focus(); }
    }
  };
  if (!open) return null;

  const loading = status === 'loading';
  const errored = status === 'error';

  const thread = (context && context.thread) || [];
  const selIdx = thread.findIndex(t => t.is_focus);
  const before = selIdx >= 0 ? selIdx : 0;
  const after = selIdx >= 0 ? thread.length - selIdx - 1 : 0;

  const sel = context && context.selected_message;
  const why = sel && sel.why_matters;

  const renderBubble = (item) => {
    const color = AGENTS[item.agent_id]?.color || '#5a7a9a';
    const isSelf = !!item.is_focus;
    const isReply = !isSelf && (item.reply_kind === 'direct' || item.reply_kind === 'addressed');
    const tag = KIND_TAG[item.reply_kind] || null;
    return (
      <div
        key={item.message_id}
        className={`chat-bubble${isSelf ? ' selected' : ''}${isReply ? ' is-reply' : ''}`}
        style={{ '--agent-color': color }}
        role="button" tabIndex={0}
        onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(item.message_id); } }}
        onClick={() => select(item.message_id)}
        title={isSelf ? '当前聚焦的消息' : '点击聚焦该消息'}
      >
        <div className="cb-head">
          {isReply && <span className="cb-arrow" title="回复">↳</span>}
          <span className="cb-agent" style={{ color }}>{agentLabelOf(item.agent_id, item.agent_label)}</span>
          {item.comm_id != null && <span className="comm-id">#{item.comm_id}</span>}
          <span className="cb-ch">{channelLabelOf(item.channel)}</span>
          <span className="cb-ts">{item.timestamp}</span>
          {tag && <span className="cb-kind" style={{ '--kind-color': tag.color }}>{tag.label}</span>}
          <span className={`cb-reason${isSelf ? ' is-sel' : ''}`}>{isSelf ? '已选中' : item.relation_reason}</span>
        </div>
        <div className="cb-body">{item.content}</div>
        {item.is_focus && <>
          <div className="provenance-note">原始消息：{item.message_id}</div>
          {item.reply_class === 'reply_future_reference' && <div className="provenance-note">含未来引用，不计入历史回复链。</div>}
          {(item.internal_reacting || item.internal_rationalizing || item.internal_deliberating) && <details onClick={e => e.stopPropagation()}>
            <summary>内心状态</summary>
            {item.internal_reacting && <p><b>即时反应：</b>{item.internal_reacting}</p>}
            {item.internal_rationalizing && <p><b>自我说服：</b>{item.internal_rationalizing}</p>}
            {item.internal_deliberating && <p><b>权衡斟酌：</b>{item.internal_deliberating}</p>}
          </details>}
        </>}
      </div>
    );
  };

  return (
    <div className="flow-overlay" onClick={onClose}>
      <div className="flow-modal" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="对话流" onKeyDown={handleKeys} onClick={e => e.stopPropagation()}>
        <div className="flow-modal-head">
          <div>
            <h3>对话流</h3>
            {sel && (
              <div className="flow-sub">
                依据原文中明确且时间有效的回复引用 ·
                {' '}共 {thread.length} 条消息
                {' '}（前序 {before} 条，后续回复 {after} 条）
              </div>
            )}
          </div>
          {history.length > 0 && <button className="flow-back" onClick={back}>返回上一条</button>}
          <button className="flow-close" aria-label="关闭对话" onClick={onClose}>✕</button>
        </div>

        {!loading && !errored && why && <div className="flow-why"><b>为什么重要：</b> {why}</div>}

        {loading && (
          <p className="muted" style={{ padding: '8px 4px 8px 16px' }}>正在加载对话…</p>
        )}
        {errored && (
          <p className="muted" style={{ padding: '8px 4px 8px 16px' }}>无法加载该对话（后端是否正在运行？）</p>
        )}

        {!loading && !errored && (!context || !context.found) && (
          <p className="muted" style={{ padding: '8px 4px 8px 16px' }}>未选中任何消息。</p>
        )}

        {!loading && !errored && context && context.found && thread.length <= 1 && (
          <p className="muted" style={{ padding: '8px 16px' }}>
            该消息自成一个话题——没有任何消息回复它，它也没有点名回应更早的发言者。
          </p>
        )}

        <div className="flow-list">
          {!loading && !errored && thread.map(item => renderBubble(item))}
        </div>
      </div>
    </div>
  );
}
