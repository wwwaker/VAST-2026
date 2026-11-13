import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export { useRequest } from "../../shared/request";

/** Keep committed content and height during refresh. Relationship panels can
 * cover the old view with an explicit loading state. */
export function PendingRegion({ data, loading, error, children, minimum = 0, layoutKey = "default", maskWhileLoading = false, loadingLabel = "正在加载…" }: {
  data?: unknown; loading: boolean; error?: string; children: ReactNode; minimum?: number; layoutKey?: string; maskWhileLoading?: boolean; loadingLabel?: string;
}) {
  const host = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement | null>(null);
  const snapshot = useRef<{ children: ReactNode; layoutKey: string } | null>(null);
  const pending = loading || !!error;
  useLayoutEffect(() => {
    if (!pending || (snapshot.current && snapshot.current.layoutKey !== layoutKey)) {
      snapshot.current = data == null ? null : { children, layoutKey };
    }
  }, [pending, data, children, layoutKey]);
  const retaining = pending && snapshot.current !== null;
  const content = retaining && snapshot.current!.layoutKey === layoutKey ? snapshot.current!.children : children;
  const [layout, setLayout] = useState({ key: layoutKey, width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = host.current, inner = body.current;
    if (!el || !inner) return;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      const natural = inner.getBoundingClientRect().height;
      setLayout(previous => {
        // Keep the largest result height across refreshes, including empty/error
        // results. Explicit collapse/expand and width changes start a new layout.
        const reset = previous.key !== layoutKey || Math.abs(previous.width - width) > 1;
        const height = reset ? natural : Math.max(previous.height, natural);
        return previous.key === layoutKey && previous.width === width && previous.height === height
          ? previous : { key: layoutKey, width, height };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el); observer.observe(inner);
    return () => observer.disconnect();
  }, [content, layoutKey]);
  return <div ref={host} className={`w-pending-region ${pending ? "is-pending" : ""} ${retaining && !maskWhileLoading ? "is-retaining" : ""}`}
    aria-busy={loading} data-refresh-state={loading ? retaining ? "refreshing" : "initial" : error ? "error" : "ready"}
    style={{ minHeight: Math.max(minimum, layout.key === layoutKey ? layout.height : 0) || undefined }}>
    <div className="w-pending-content" ref={el => { body.current = el; if (el) el.inert = pending; }} aria-hidden={pending || undefined}>{content}</div>
    {pending && (!retaining || maskWhileLoading) && <div className={`w-loading-placeholder ${maskWhileLoading ? "w-loading-mask" : ""}`} aria-hidden="true">
      <div className="w-loading-message">{loading && maskWhileLoading && <span className="w-loading-spinner"/>}<span>{loading ? loadingLabel : "加载失败，请点击上方重试"}</span></div>
    </div>}
  </div>;
}

export function RequestStatus({ data, loading, error, reload, maskWhileLoading = false, loadingLabel = "正在加载…" }: { data?: unknown; loading: boolean; error?: string; reload: () => void; maskWhileLoading?: boolean; loadingLabel?: string }) {
  return <div className={`mc2-status ${loading && maskWhileLoading ? "is-masked-loading" : ""}`} role={error ? "alert" : "status"}>
    {loading ? data == null || maskWhileLoading ? loadingLabel : "更新中 · 暂显示上次结果" : error ? <>{data == null || maskWhileLoading ? "加载失败" : "更新失败 · 暂显示上次结果"}：{error} <button onClick={reload}>重试</button></> : null}
  </div>;
}
