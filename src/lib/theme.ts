import { readonly, ref } from "vue"

export type ThemePreference = "light" | "dark" | "system"
const STORAGE_KEY = "pix.theme"
const isTheme = (value: unknown): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system"

function initialTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (isTheme(value)) return value
  } catch {
    /* Storage is optional. */
  }
  return "dark"
}

const preference = ref<ThemePreference>(initialTheme())
export const theme = readonly(preference)
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")

function applyTheme() {
  document.documentElement.classList.toggle(
    "dark",
    preference.value === "system" ? systemTheme.matches : preference.value === "dark",
  )
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
systemTheme.addEventListener("change", applyTheme)
window.addEventListener("storage", syncTheme)
applyTheme()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    systemTheme.removeEventListener("change", applyTheme)
    window.removeEventListener("storage", syncTheme)
  })
}
