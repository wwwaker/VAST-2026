import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/** Styled popup backed by a native select for form values and change events. */
export function WorkspaceSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { children, value, disabled, className, ...rest } = props;

  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const p = child.props as { value: string | number; children: string; disabled?: boolean };

      return {
        value: String(p.value),
        label: Children.toArray(p.children).join(""),
        disabled: !!p.disabled,
      };
    });

  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const id = useId();
  const selected = options.findIndex((o) => o.value === String(value));
  const prefix = useRef({ text: "", time: 0 });
  const label = props["aria-label"] ?? "选择选项";
  const close = () => setOpen(false);

  const show = (last = false) => {
    if (disabled) {
      return;
    }
    setActive(
      selected >= 0 && !options[selected].disabled
        ? selected
        : last
          ? (options
              .map((o, i) => (o.disabled ? -1 : i))
              .filter((i) => i >= 0)
              .at(-1) ?? -1)
          : options.findIndex((o) => !o.disabled),
    );
    setOpen(true);
  };

  const choose = (index: number) => {
    if (!native.current || !options[index] || options[index].disabled) {
      return;
    }
    if (options[index].value !== String(value)) {
      native.current.value = options[index].value;
      native.current.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close();
    trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) {
      return;
    }

    const place = () => {
      if (!trigger.current) {
        return;
      }
      const r = trigger.current.getBoundingClientRect();
      const gap = 5;
      const margin = 8;
      const width = Math.min(Math.max(r.width, 220), 480, window.innerWidth - margin * 2);
      const below = window.innerHeight - r.bottom - margin - gap;
      const above = r.top - margin - gap;
      const up = below < Math.min(280, options.length * 38 + 10) && above > below;
      const maxHeight = Math.max(0, Math.min(320, up ? above : below));
      setPosition({
        position: "fixed",
        left: Math.max(margin, Math.min(r.left, window.innerWidth - width - margin)),
        width,
        maxHeight,
        ...(up ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap }),
      });
    };

    place();

    const outside = (e: PointerEvent) => {
      const path = e.composedPath();
      if (!path.includes(trigger.current!) && !path.includes(menu.current!)) {
        close();
      }
    };

    const scroll = (e: Event) => {
      if (!e.composedPath().includes(menu.current!)) {
        place();
      }
    };

    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);

    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, options.length]);
  useEffect(() => {
    const popup = menu.current;
    const option = popup?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!open || !popup || !option) {
      return;
    }
    // Scroll only the menu; scrollIntoView can also move the underlying workspace.
    if (option.offsetTop < popup.scrollTop) {
      popup.scrollTop = option.offsetTop;
    } else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight) {
      popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight;
    }
  }, [open, active]);
  useEffect(() => {
    if (disabled) {
      close();
    }
  }, [disabled]);
  // Keep the popup in the current dialog's focus/inert scope, above clipping panels.
  const host = trigger.current?.closest('[role="dialog"]') ?? trigger.current?.closest(".w-app");

  return (
    <span className={`w-select ${className ?? ""}`}>
      <select
        {...rest}
        className="w-select-native"
        value={value}
        disabled={disabled}
        ref={native}
        hidden
        tabIndex={-1}
        aria-hidden="true"
      >
        {children}
      </select>
      <button
        ref={trigger}
        type="button"
        className="w-select-trigger"
        role="combobox"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        title={options[selected]?.label}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
              close();

              return;
            }
            if (e.key === "Enter" || e.key === " ") {
              if (open) {
                choose(active);
              } else {
                show();
              }

              return;
            }
            if (!open) {
              show(e.key === "End");
              if (e.key === "Home") {
                setActive(options.findIndex((o) => !o.disabled));
              }
              if (e.key === "End") {
                setActive(
                  options
                    .map((o, i) => (o.disabled ? -1 : i))
                    .filter((i) => i >= 0)
                    .at(-1) ?? -1,
                );
              }

              return;
            }
            const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
            const index = enabled.indexOf(active);
            if (!enabled.length) {
              return;
            }
            setActive(
              e.key === "Home"
                ? enabled[0]
                : e.key === "End"
                  ? enabled.at(-1)!
                  : enabled[
                      (index + (e.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length
                    ],
            );
          } else if (e.key === "Tab") {
            close();
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const now = Date.now();
            prefix.current = {
              text:
                (now - prefix.current.time < 700 ? prefix.current.text : "") + e.key.toLowerCase(),
              time: now,
            };

            const next = options.findIndex(
              (o) => !o.disabled && o.label.toLowerCase().startsWith(prefix.current.text),
            );

            if (next >= 0) {
              e.preventDefault();
              if (!open) {
                setOpen(true);
              }
              setActive(next);
            }
          }
        }}
      >
        <span>{options[selected]?.label ?? "请选择…"}</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
        />
      </button>
      {open &&
        host &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="listbox"
            aria-label={label}
            className="w-select-menu"
            style={position}
            onPointerDown={(e) => e.preventDefault()}
          >
            {options.map((option, i) => (
              <div
                id={`${id}-${i}`}
                key={option.value}
                role="option"
                aria-selected={selected === i}
                aria-disabled={option.disabled || undefined}
                data-index={i}
                className={`${active === i ? "is-active" : ""} ${selected === i ? "is-selected" : ""}`}
                onPointerMove={() => {
                  if (!option.disabled) {
                    setActive(i);
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  choose(i);
                }}
              >
                <span>{option.label}</span>
                {selected === i && (
                  <Check
                    size={14}
                    aria-hidden="true"
                  />
                )}
              </div>
            ))}
          </div>,
          host,
        )}
    </span>
  );
}
