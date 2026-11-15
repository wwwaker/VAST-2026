import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep workspace styles isolated while sharing the mounting lifecycle. */
export function ShadowWorkspace({
  testId,
  styles,
  children,
}: {
  testId: string;
  styles: string;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    if (host.current) {
      setShadow(host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" }));
    }
    const previous = document.documentElement.style.scrollbarGutter;
    document.documentElement.style.scrollbarGutter = "stable";

    return () => {
      document.documentElement.style.scrollbarGutter = previous;
    };
  }, []);

  return (
    <div
      ref={host}
      data-testid={testId}
      style={{ minHeight: "100vh", background: "#f5f7fa" }}
    >
      {shadow &&
        createPortal(
          <>
            <style>{styles}</style>
            {children}
          </>,
          shadow,
        )}
    </div>
  );
}
