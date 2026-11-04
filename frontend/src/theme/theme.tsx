import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const MODE_KEY = "mas-workspace.theme-mode";
const MOTION_KEY = "mas-workspace.reduced-motion";

function readStoredMode(): ThemeMode {
  // 允许通过 ?theme=dark 临时强制主题，便于截图与课堂演示，不写入偏好
  const forced = new URLSearchParams(window.location.search).get("theme");
  if (forced === "light" || forced === "dark") return forced;
  const raw = localStorage.getItem(MODE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function readStoredMotion(): boolean {
  return localStorage.getItem(MOTION_KEY) === "true";
}

/** 读取语义 token 的当前计算值。图表必须走这里，不得在组件内写死色值。 */
export interface TokenColors {
  bg: string;
  panel: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  risk: string;
  warn: string;
  ok: string;
  grid: string;
  selection: string;
  categories: string[];
}

function readTokens(): TokenColors {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bg: get("--bg"),
    panel: get("--panel"),
    border: get("--border"),
    text: get("--text"),
    textMuted: get("--text-muted"),
    textFaint: get("--text-faint"),
    accent: get("--accent"),
    risk: get("--risk"),
    warn: get("--warn"),
    ok: get("--ok"),
    grid: get("--grid"),
    selection: get("--selection"),
    categories: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => get(`--cat-${i}`)),
  };
}

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  reducedMotion: boolean;
  setMode: (mode: ThemeMode) => void;
  setReducedMotion: (value: boolean) => void;
  colors: TokenColors;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [reducedMotion, setMotionState] = useState<boolean>(readStoredMotion);
  const [systemDark, setSystemDark] = useState<boolean>(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme = mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
  }, [resolved, mode]);

  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(reducedMotion);
    localStorage.setItem(MOTION_KEY, String(reducedMotion));
  }, [reducedMotion]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    localStorage.setItem(MODE_KEY, next);
  }, []);

  // 主题变化后重新读取计算值，图表据此重绘；筛选与选中状态由各自 state 保留
  const colors = useMemo(() => readTokens(), [resolved]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, reducedMotion, setMode, setReducedMotion: setMotionState, colors }),
    [mode, resolved, reducedMotion, setMode, colors],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}
