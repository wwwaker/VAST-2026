import { Fingerprint, GitCompareArrows, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { useReaderScrollLock } from "../../../shared/ui/ReaderDialog";

/** Investigation tools float above the still-mounted workspace. Reader can stack above this. */
export function ResearchOverlay({
  kind,
  close,
  suspended,
  children,
}: {
  kind: "patterns" | "compare";
  close: () => void;
  suspended: boolean;
  children: ReactNode;
}) {
  const modal = useRef<HTMLDivElement | null>(null);
  useReaderScrollLock(modal);
  const patterns = kind === "patterns";
  const title = patterns ? "文件指纹" : "发布实例比较";
  const Icon = patterns ? Fingerprint : GitCompareArrows;

  return (
    <div
      className="w-research-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !suspended) {
          close();
        }
      }}
    >
      <div
        ref={(el) => {
          modal.current = el;
          if (el) {
            el.inert = suspended;
          }
        }}
        className="w-research-dialog"
        data-research-kind={kind}
        role="dialog"
        aria-modal={!suspended}
        aria-hidden={suspended || undefined}
        aria-labelledby="mc2-research-title"
        onKeyDown={(e) => {
          if (suspended) {
            return;
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
          if (e.key === "Tab") {
            const controls = [
              ...e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]',
              ),
            ].filter(
              (n) =>
                n.getClientRects().length > 0 &&
                !n.closest("[hidden]") &&
                !n.closest("[inert]") &&
                (!n.closest("details:not([open])") || n.tagName === "SUMMARY"),
            );

            const root = e.currentTarget.getRootNode();
            const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
            if (e.shiftKey && active === controls[0]) {
              e.preventDefault();
              controls.at(-1)?.focus();
            } else if (!e.shiftKey && active === controls.at(-1)) {
              e.preventDefault();
              controls[0]?.focus();
            }
          }
        }}
      >
        <header className="w-research-head">
          <div>
            <h2 id="mc2-research-title">
              <Icon size={21} />
              {title}
            </h2>
            <p>
              {patterns
                ? "按完整操作顺序寻找同类文件，再回到主图核对具体记录。"
                : "以发布时刻为零点，对齐比较来源文件的创建、读取与删除时机。"}
            </p>
          </div>
          <button
            aria-label={patterns ? "关闭文件指纹" : "关闭发布比较"}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <div className="w-research-body">{children}</div>
      </div>
    </div>
  );
}
