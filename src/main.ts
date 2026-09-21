import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { i18n } from "./i18n";
import "./style.css";

if (import.meta.env.DEV) {
  const { default: elementDev } = await import("element-source-dev");
  elementDev();
}

createApp(App).use(createPinia()).use(i18n).mount("#app");
