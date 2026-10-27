import { createLocalPreference } from "@/lib/localPreference"

export type ThemePreference = "light" | "dark" | "system"
const STORAGE_KEY = "pix.theme"
const DEFAULT_THEME: ThemePreference = "system"
const isTheme = (value: unknown): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system"

/**
 * 首屏主题完全由 CSS 决定：系统偏好走 `prefers-color-scheme`，`light` / `dark` 类
 * 只用于显式选择（`light` 同时负责抵消系统暗色）。因此这里不需要在脚本之前
 * 预先设置类名，index.html 里也无需内联脚本。
 */
function applyTheme(value: ThemePreference) {
  const { classList } = document.documentElement
  classList.toggle("dark", value === "dark")
  classList.toggle("light", value === "light")
}

const preference = createLocalPreference<ThemePreference>({
  key: STORAGE_KEY,
  defaultValue: DEFAULT_THEME,
  validate: isTheme,
  onChange: applyTheme,
})
export const theme = preference.value

export function setTheme(value: ThemePreference) {
  if (!isTheme(value)) return
  preference.set(value)
}
