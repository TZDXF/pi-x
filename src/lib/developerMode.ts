import { readonly, ref } from "vue"

/**
 * 开发者模式开关，持久化到 localStorage 并经 storage 事件跨窗口同步。
 * 开启后：打包版本中也允许打开 webview devtools（F12 / Ctrl+Shift+I），
 * 并在应用启动时加载 element-source-dev（后者需重启应用后生效）。
 */
const STORAGE_KEY = "pix.developerMode"

function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    /* Storage is optional. */
  }
  return false
}

const enabled = ref(readPreference())

/** 响应式的开发者模式状态，供设置页与快捷键判断使用。 */
export const developerModeEnabled = readonly(enabled)

/** 非响应式读取，供 main.ts 等应用初始化前的场景使用。 */
export function isDeveloperModeEnabled(): boolean {
  return readPreference()
}

export function setDeveloperMode(next: boolean) {
  enabled.value = next
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0")
  } catch {
    /* Storage is optional. */
  }
}

function syncPreference(event: StorageEvent) {
  if (event.key === STORAGE_KEY || event.key === null) enabled.value = readPreference()
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", syncPreference)
  if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", syncPreference))
}
