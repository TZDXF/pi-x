import { createApp } from "vue"
import { createPinia } from "pinia"
import RemoteEntry from "./components/RemoteEntry.vue"
import { i18n } from "./i18n"
import { isDeveloperModeEnabled } from "./lib/developerMode"
import "./style.css"
import "./lib/theme"

if (import.meta.env.DEV || isDeveloperModeEnabled()) {
  const { default: elementDev } = await import("element-source-dev")
  elementDev()
}

createApp(RemoteEntry).use(createPinia()).use(i18n).mount("#app")
