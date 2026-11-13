import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ReadingActions } from "../mc1/reference/components/MessageMetadata";

export function useReaderScrollLock(modal: RefObject<HTMLDivElement>) {
  useEffect(() => { const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; modal.current?.querySelector<HTMLButtonElement>("button")?.focus(); return () => { document.body.style.overflow = previous; }; }, [modal]);
}

export function ReaderDialog({ title, subtitle, back, close, children, bodyRef }: { title: string; subtitle: string; back?: () => void; close: () => void; children: ReactNode; bodyRef: RefObject<HTMLDivElement> }) {
  const modal = useRef<HTMLDivElement>(null); useReaderScrollLock(modal);
  return <div className="flow-overlay cu-reader-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><div ref={modal} className="flow-modal cu-reader" role="dialog" aria-modal="true" aria-labelledby="custom-reader-title" onKeyDown={e => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    if (e.key === "Tab") { const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary,input,select,[tabindex="0"]')].filter(n => !n.closest("details:not([open])") || n.tagName === "SUMMARY"); const root = e.currentTarget.getRootNode(); const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement; const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && active === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && active === last) { e.preventDefault(); first?.focus(); } }
  }}><div className="flow-modal-head"><div><h3 id="custom-reader-title">{title}</h3><p className="cu-note">{subtitle}</p></div><ReadingActions onBack={back} onClose={close} backLabel="返回上次阅读" closeLabel="关闭阅读记录"/></div><div className="flow-list cu-reader-body" ref={bodyRef} tabIndex={0}>{children}</div></div></div>;
}
