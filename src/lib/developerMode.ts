import { readonly, ref } from "vue"

/**
 * 开发者模式开关，持久化到 localStorage 并经 storage 事件跨窗口同步。
 * 开启后：允许打开 webview devtools（F12 / Ctrl+Shift+I），并在应用启动时
 * 加载 element-source-dev（后者需重启应用后生效）。debug 构建自带
 * devtools；打包版本需以 `--features devtools` 编译，否则后端会拒绝。
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
