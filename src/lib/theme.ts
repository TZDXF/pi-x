import { readonly, ref } from "vue"

export type ThemePreference = "light" | "dark" | "system"
const STORAGE_KEY = "pix.theme"
const DEFAULT_THEME: ThemePreference = "system"
const isTheme = (value: unknown): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system"

function initialTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (isTheme(value)) return value
  } catch {
    /* Storage is optional. */
  }
  return DEFAULT_THEME
}

const preference = ref<ThemePreference>(initialTheme())
export const theme = readonly(preference)

/**
 * 首屏主题完全由 CSS 决定：系统偏好走 `prefers-color-scheme`，`light` / `dark` 类
 * 只用于显式选择（`light` 同时负责抵消系统暗色）。因此这里不需要在脚本之前
 * 预先设置类名，index.html 里也无需内联脚本。
 */
function applyTheme() {
  const { classList } = document.documentElement
  classList.toggle("dark", preference.value === "dark")
  classList.toggle("light", preference.value === "light")
}

export function setTheme(value: ThemePreference) {
  if (!isTheme(value)) return
  preference.value = value
  applyTheme()
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* Storage is optional. */
  }
}

function syncTheme(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  preference.value = initialTheme()
  applyTheme()
}
window.addEventListener("storage", syncTheme)
applyTheme()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener("storage", syncTheme)
  })
}
