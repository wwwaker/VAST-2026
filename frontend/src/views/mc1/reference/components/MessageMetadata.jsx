import React from 'react';
import { ArrowLeft, X } from 'lucide-react';

export function MessageMetadata({ number, timestamp, children }) {
  return <div className="msg-meta">
    {number != null && <span className="comm-id">#{number}</span>}
    <b>{timestamp}</b>
    {children}
  </div>;
}

export function ReadingActions({ onBack, onClose, backLabel = '返回上一条', closeLabel = '关闭对话' }) {
  return <>
    {onBack && <button className="flow-back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true"/>{backLabel}</button>}
    <button className="flow-close" aria-label={closeLabel} title="关闭 · Esc" onClick={onClose}><X size={16} aria-hidden="true"/></button>
  </>;
}
