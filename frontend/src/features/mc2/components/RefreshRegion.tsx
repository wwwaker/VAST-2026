import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export { useRequest } from "../../../shared/hooks/request";

/** Keep committed content and height during refresh. Relationship panels can
 * cover the old view with an explicit loading state. */
export function PendingRegion({
  data,
  loading,
  error,
  children,
  minimum = 0,
  layoutKey = "default",
  maskWhileLoading = false,
  loadingLabel = "正在加载…",
}: {
  data?: unknown;
  loading: boolean;
  error?: string;
  children: ReactNode;
  minimum?: number;
  layoutKey?: string;
  maskWhileLoading?: boolean;
  loadingLabel?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const snapshot = useRef<{ children: ReactNode; layoutKey: string } | null>(null);
  const pending = loading || !!error;
  useLayoutEffect(() => {
    if (!pending || (snapshot.current && snapshot.current.layoutKey !== layoutKey)) {
      snapshot.current = data == null ? null : { children, layoutKey };
    }
  }, [pending, data, children, layoutKey]);
  const retaining = pending && snapshot.current !== null;

  const content =
    retaining && snapshot.current!.layoutKey === layoutKey ? snapshot.current!.children : children;

  const [layout, setLayout] = useState({ key: layoutKey, width: 0, height: 0 });
  const measured = useRef(layout);

  const readingAnchor = useRef<{ element: Element; top: number; fallback: Element | null } | null>(
    null,
  );

  const compensated = useRef(false);
  useLayoutEffect(() => {
    compensated.current = false;
    const el = host.current;
    if (!el) {
      return;
    }

    const capture = () => {
      const root = el.getRootNode() as Document | ShadowRoot;

      const element = [
        ...root.querySelectorAll(".mc2-record, .w-edge-events > div, h2, h3, .w-process-mark"),
      ].find((node) => {
        const rect = node.getBoundingClientRect();

        return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
      });

      readingAnchor.current = element
        ? {
            element,
            top: element.getBoundingClientRect().top,
            fallback: el.closest("section")?.querySelector("h2,h3") ?? null,
          }
        : null;
    };

    if (pending) {
      capture();
      window.addEventListener("scroll", capture, { passive: true });

      return () => window.removeEventListener("scroll", capture);
    }
    const anchor = readingAnchor.current;
    readingAnchor.current = null;
    if (anchor) {
      compensated.current = true;
      if (anchor.element.isConnected) {
        const delta = anchor.element.getBoundingClientRect().top - anchor.top;
        if (Math.abs(delta) > 1) {
          window.scrollBy(0, delta);
        }
      } else {
        anchor.fallback?.scrollIntoView({ block: "start" });
      }
    }
  }, [pending, layoutKey]);
  useLayoutEffect(() => {
    const el = host.current;
    const inner = body.current;
    if (!el || !inner) {
      return;
    }

    const measure = () => {
      const width = el.getBoundingClientRect().width;
      const natural = inner.getBoundingClientRect().height;
      const previous = measured.current;
      const reset = previous.key !== layoutKey || Math.abs(previous.width - width) > 1;
      const height = pending && !reset ? previous.height : natural;
      // If a fully off-screen section contracts after refresh, keep the
      // following content at the same viewport position.
      if (
        !pending &&
        !compensated.current &&
        !reset &&
        previous.height > 0 &&
        height !== previous.height &&
        el.getBoundingClientRect().top + previous.height < 0
      ) {
        window.scrollBy?.(0, height - previous.height);
      }
      if (previous.key !== layoutKey || previous.width !== width || previous.height !== height) {
        measured.current = { key: layoutKey, width, height };
        setLayout(measured.current);
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(inner);

    return () => observer.disconnect();
  }, [content, layoutKey, pending]);

  return (
    <div
      ref={host}
      className={`w-pending-region ${pending ? "is-pending" : ""} ${retaining && !maskWhileLoading ? "is-retaining" : ""}`}
      aria-busy={loading}
      data-refresh-state={
        loading ? (retaining ? "refreshing" : "initial") : error ? "error" : "ready"
      }
      style={{
        minHeight: pending
          ? Math.max(minimum, layout.key === layoutKey ? layout.height : 0) || undefined
          : undefined,
      }}
    >
      <div
        className="w-pending-content"
        ref={(el) => {
          body.current = el;
          if (el) {
            el.inert = pending;
          }
        }}
        aria-hidden={pending || undefined}
      >
        {content}
      </div>
      {pending && (!retaining || maskWhileLoading) && (
        <div
          className={`w-loading-placeholder ${maskWhileLoading ? "w-loading-mask" : ""}`}
          aria-hidden="true"
        >
          <div className="w-loading-message">
            {loading && maskWhileLoading && <span className="w-loading-spinner" />}
            <span>{loading ? loadingLabel : "加载失败，请点击上方重试"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function RequestStatus({
  data,
  loading,
  error,
  reload,
  maskWhileLoading = false,
  loadingLabel = "正在加载…",
}: {
  data?: unknown;
  loading: boolean;
  error?: string;
  reload: () => void;
  maskWhileLoading?: boolean;
  loadingLabel?: string;
}) {
  return (
    <div
      className={`mc2-status ${loading && maskWhileLoading ? "is-masked-loading" : ""}`}
      role={error ? "alert" : "status"}
    >
      {loading ? (
        data == null || maskWhileLoading ? (
          loadingLabel
        ) : (
          "更新中 · 暂显示上次结果"
        )
      ) : error ? (
        <>
          {data == null || maskWhileLoading ? "加载失败" : "更新失败 · 暂显示上次结果"}：{error}{" "}
          <button onClick={reload}>重试</button>
        </>
      ) : null}
    </div>
  );
}
