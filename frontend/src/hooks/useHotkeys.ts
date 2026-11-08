import { useEffect } from "react";
import { useWorkspace } from "../state/workspace";
import { HOUR_US, SECOND_US } from "../data/api";

/** 计划书约定的键盘验收范围：筛选、时间刷选与回放、事件选择、证据侧栏开关。
 *  不覆盖全部界面元素，也不与输入框抢键。 */

const IGNORE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (IGNORE_TAGS.has(el.tagName)) return true;
  return el.isContentEditable;
}

/**
 * 原生可交互元素（按钮/链接/摘要/带 role=button 的图元）自己消费 Enter 与 Space。
 * 全局快捷键只接管"焦点不在控件上"的情况，避免「关闭」按钮按 Enter 反而打开证据坞。
 */
const INTERACTIVE_ROLES = new Set(["button", "link", "switch", "checkbox", "tab", "menuitem", "option"]);

function isInteractiveControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.getAttribute !== "function") return false;
  if (typeof el.closest === "function" && el.closest("button, a, summary, [role='button']")) return true;
  const role = el.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return false;
}

export function useHotkeys(onToggleHelp: () => void) {
  const {
    dataset,
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
      // 局部处理过的按键（如 SVG 图元的 Enter/Space）不再触发全局回放或开坞
      if (event.defaultPrevented) return;
      if ((event.key === "Enter" || event.key === " ") && isInteractiveControl(event.target)) return;

      const baseStep = dataset === "CUSTOM" ? SECOND_US : HOUR_US;
      const step = event.shiftKey ? baseStep * 6 : baseStep;

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
            setFilters({ startUs: null, endUs: null });
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
    dataset,
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
