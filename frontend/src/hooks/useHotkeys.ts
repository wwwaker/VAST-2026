import { useEffect } from "react";
import { useWorkspace } from "../state/workspace";

/** 计划书约定的键盘验收范围：筛选、时间刷选与回放、事件选择、证据侧栏开关。
 *  不覆盖全部界面元素，也不与输入框抢键。 */

const IGNORE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (IGNORE_TAGS.has(el.tagName)) return true;
  return el.isContentEditable;
}

export function useHotkeys(onToggleHelp: () => void) {
  const {
    setCursor,
    togglePlaying,
    masking,
    setMasking,
    evidenceOpen,
    setEvidenceOpen,
    selectedEventId,
    setFilters,
  } = useWorkspace();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const step = event.shiftKey ? 6 * 3600 : 3600;

      switch (event.key) {
        case "?":
          event.preventDefault();
          onToggleHelp();
          break;

        case "/":
        case "f":
        case "F": {
          const input = document.querySelector<HTMLInputElement>('input[type="search"]');
          if (input) {
            event.preventDefault();
            input.focus();
            input.select();
          }
          break;
        }

        case "ArrowLeft":
          event.preventDefault();
          setCursor((prev) => (prev == null ? null : prev - step));
          break;

        case "ArrowRight":
          event.preventDefault();
          setCursor((prev) => (prev == null ? null : prev + step));
          break;

        case " ":
          event.preventDefault();
          togglePlaying();
          break;

        case "m":
        case "M":
          event.preventDefault();
          setMasking(!masking);
          break;

        case "Enter":
          if (selectedEventId) {
            event.preventDefault();
            setEvidenceOpen(true);
          }
          break;

        case "Escape":
          if (evidenceOpen) {
            event.preventDefault();
            setEvidenceOpen(false);
          } else {
            setFilters({ from: null, to: null });
          }
          break;

        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    onToggleHelp,
    setCursor,
    togglePlaying,
    masking,
    setMasking,
    evidenceOpen,
    setEvidenceOpen,
    selectedEventId,
    setFilters,
  ]);
}
