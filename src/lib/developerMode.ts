import { createLocalPreference } from "@/lib/localPreference"

/**
 * 开发者模式开关，持久化到 localStorage 并经 storage 事件跨窗口同步。
 * 开启后：允许打开 webview devtools（F12 / Ctrl+Shift+I），并在应用启动时
 * 加载 element-source-dev（后者需重启应用后生效）。debug 构建自带
 * devtools；打包版本需以 `--features devtools` 编译，否则后端会拒绝。
 */
const STORAGE_KEY = "pix.developerMode"

const preference = createLocalPreference<boolean>({
  key: STORAGE_KEY,
  defaultValue: false,
  read: raw => raw === "1",
  serialize: value => (value ? "1" : "0"),
})

/** 响应式的开发者模式状态，供设置页与快捷键判断使用。 */
export const developerModeEnabled = preference.value

/** 非响应式读取，供 main.ts 等应用初始化前的场景使用。 */
export function isDeveloperModeEnabled(): boolean {
  return preference.read()
}

export function setDeveloperMode(next: boolean) {
  preference.set(next)
}
