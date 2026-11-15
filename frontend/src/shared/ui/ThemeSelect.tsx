import { Moon, Sun, Monitor } from "lucide-react";
import { setThemePreference, useTheme, type ThemePreference } from "../lib/theme";

export function ThemeSelect() {
  const { preference, resolved } = useTheme();
  const Icon = preference === "system" ? Monitor : resolved === "dark" ? Moon : Sun;

  return (
    <label className="theme-select">
      <Icon
        size={15}
        aria-hidden="true"
      />
      <select
        aria-label="界面主题"
        value={preference}
        onChange={(event) => setThemePreference(event.target.value as ThemePreference)}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">暗色</option>
      </select>
    </label>
  );
}
