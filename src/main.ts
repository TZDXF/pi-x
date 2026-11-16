import { createApp } from "vue"
import { createPinia } from "pinia"
import RemoteEntry from "./components/RemoteEntry.vue"
import { i18n } from "./i18n"
import { isDeveloperModeEnabled } from "./lib/developerMode"
import { initializeConfigPreferences } from "./lib/configPreference"
import { ignoreInvalidKeyboardEvent } from "./lib/keyboardEvents"
import "./style.css"
import "./lib/theme"

// Desktop gets the saved theme/locale/developer preference before first render.
// An unauthenticated remote client retries this from App after login.
await initializeConfigPreferences()

// 必须先于 element-source-dev 的 document 捕获监听器注册。
window.addEventListener("keydown", ignoreInvalidKeyboardEvent, true)
window.addEventListener("keyup", ignoreInvalidKeyboardEvent, true)

if (import.meta.env.DEV || isDeveloperModeEnabled()) {
  const { default: elementDev } = await import("element-source-dev")
  elementDev()
}

// 禁用 WebView 默认右键菜单；reka-ui 自定义 ContextMenu 的触发器自行处理 contextmenu 事件，不受影响
window.addEventListener("contextmenu", e => e.preventDefault())

createApp(RemoteEntry).use(createPinia()).use(i18n).mount("#app")
