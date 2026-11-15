import { useSyncExternalStore } from "react";
import { writeStoredValue } from "./storage";

export type ThemePreference = "system" | "light" | "dark";

export type Theme = "light" | "dark";

const media =
  typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;

const listeners = new Set<() => void>();

const preference =
  typeof document !== "undefined" ? document.documentElement.dataset.themePreference : undefined;

let snapshot: { preference: ThemePreference; resolved: Theme } = {
  preference: preference === "light" || preference === "dark" ? preference : "system",
  resolved:
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light",
};

function apply(value: ThemePreference) {
  const resolved = value === "system" ? (media?.matches ? "dark" : "light") : value;
  const changed = snapshot.preference !== value || snapshot.resolved !== resolved;
  snapshot = changed ? { preference: value, resolved } : snapshot;
  document.documentElement.dataset.themePreference = value;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  if (changed) {
    listeners.forEach((listener) => listener());
  }
}

export function setThemePreference(value: ThemePreference) {
  writeStoredValue("mas-theme", value);
  apply(value);
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function useTheme() {
  return useSyncExternalStore(subscribeTheme, () => snapshot);
}

media?.addEventListener("change", () => {
  if (snapshot.preference === "system") {
    apply("system");
  }
});
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === "mas-theme" || event.key === null) {
      try {
        if (event.storageArea !== window.localStorage) {
          return;
        }
      } catch {
        return;
      }
      apply(event.newValue === "light" || event.newValue === "dark" ? event.newValue : "system");
    }
  });
}
