import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Retain layout during refresh; PendingRegion makes previous results unavailable. */
export function useRequest<T>(key: string, request: (signal: AbortSignal) => Promise<T>): { data?: T; error?: string; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key, loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState(previous => ({ key, data: previous.data, loading: true }));
    request(controller.signal).then(data => {
      if (active) setState({ key, data, loading: false });
    }).catch(error => {
      if (active && error.name !== "AbortError") setState(previous => ({ key, data: previous.data, error: String(error.message ?? error), loading: false }));
    });
    return () => { active = false; controller.abort(); };
    // The caller supplies the complete request identity, independent of closure identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  return { data: state.data, error: state.key === key ? state.error : undefined, loading: state.key !== key || state.loading, reload: () => setRetry(value => value + 1) };
}

export function PendingRegion({ loading, error, children, minimum = 0 }: { loading: boolean; error?: string; children: ReactNode; minimum?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const height = useRef(0);
  const pending = loading || !!error;
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || pending) return;
    const measure = () => { height.current = el.getBoundingClientRect().height || height.current; };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(el);
    return () => observer.disconnect();
  }, [pending, children]);
  return <div ref={host} className={`w-pending-region ${pending ? "is-pending" : ""}`} aria-busy={loading} style={{ minHeight: pending ? height.current || minimum : undefined }}>
    <div className="w-pending-content" ref={el => { if (el) el.inert = pending; }} aria-hidden={pending || undefined}>{children}</div>
    {pending && <div className="w-loading-placeholder" aria-hidden="true">{loading ? "正在更新，保留当前视图位置…" : "暂未取得当前范围的数据"}</div>}
  </div>;
}

export function RequestStatus({ loading, error, reload }: { loading: boolean; error?: string; reload: () => void }) {
  return <div className="mc2-status" role={error ? "alert" : "status"}>{loading ? "正在载入…" : error ? <>{error} <button onClick={reload}>重试</button></> : null}</div>;
}
