// PI_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { createServer } from "vite"
const { chromium } = await import(
  process.env.PI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PI_PLAYWRIGHT_MODULE).href : "playwright"
)
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/zh-CN.ts'
import SettingsPage from '/src/components/SettingsPage.vue'
import '/src/style.css'
const app = createApp({ render: () => h(SettingsPage, { project: 'C:/demo' }) })
app.use(createPinia()).use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': messages } }))
app.mount('#app')
</script></body></html>`
const server = await createServer({
  server: { port: 1448, strictPort: true },
  plugins: [
    {
      name: "retry-test",
      configureServer(server) {
        server.middlewares.use("/__retry_test", async (req, res, next) => {
          try {
            res.setHeader("Content-Type", "text/html")
            res.end(await server.transformIndexHtml("/__retry_test", html))
          } catch (e) {
            next(e)
          }
        })
      },
    },
  ],
})
await server.listen()
const browser = await chromium.launch({ channel: process.env.PI_BROWSER_CHANNEL || "msedge", headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
const errors = []
page.on("pageerror", error => errors.push(error.message))
await page.addInitScript(() => {
  window.isTauri = true
  window.calls = []
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.calls.push({ command, args })
      if (command === "pi_settings_get") {
        return { defaultProvider: "test", defaultModel: "test-model", skills: [], retry: { maxRetries: 3 } }
      }
      if (command === "pi_settings_save") return null
      return {}
    },
  }
})
const saved = () =>
  page.evaluate(() => window.calls.filter(c => c.command === "pi_settings_save").map(c => c.args.settings))
// Toasts render in App.vue, which this harness does not mount.
const toasts = () =>
  page.evaluate(async () => {
    const { useUiStore } = await import("/src/stores/conversations.ts")
    return useUiStore().toasts.map(toast => toast.message)
  })
// Saving runs the installed Pi SDK, so the panel stays disabled until it returns.
const waitForSaves = async count => {
  await page.waitForFunction(n => window.calls.filter(c => c.command === "pi_settings_save").length >= n, count)
  await page.waitForFunction(() => {
    const fieldset = document.querySelector("fieldset")
    return !!fieldset && !fieldset.disabled
  })
}
try {
  await page.goto("http://localhost:1448/__retry_test#/settings/general")
  await page.getByRole("heading", { name: "常规", level: 1 }).waitFor()
  assert.equal(
    await page.getByRole("button", { name: "自动重试", exact: true }).count(),
    0,
    "retry is embedded instead of listed as a separate page",
  )

  const attempts = page.getByRole("spinbutton", { name: "重试次数" })
  assert.equal(await attempts.inputValue(), "3")

  // Type like a user so the input's change event (the commit trigger) fires.
  async function editNumber(input, text) {
    await input.click()
    await input.press("Control+a")
    if (text) await input.pressSequentially(text)
    else await input.press("Backspace")
    await input.press("Tab")
  }

  await editNumber(attempts, "5")
  await waitForSaves(1)
  assert.deepEqual(await saved(), [{ retry: { maxRetries: 5 } }], "only the retry count is written")

  await editNumber(attempts, "99")
  await page.waitForTimeout(300)
  assert.equal(await saved().then(list => list.length), 1, "an out-of-range count is not saved")
  assert.equal(await attempts.inputValue(), "5", "the input falls back to the saved value")
  assert.ok((await toasts()).includes("请输入 0–20 之间的整数。"), "invalid input is reported in the current language")

  await editNumber(attempts, "")
  await page.waitForTimeout(300)
  assert.equal(await saved().then(list => list.length), 1, "an empty input is not saved as 0")

  await editNumber(attempts, "0")
  await waitForSaves(2)
  assert.deepEqual(await saved(), [{ retry: { maxRetries: 5 } }, { retry: { maxRetries: 0 } }])
  if (process.env.PI_RETRY_SCREENSHOT) await page.screenshot({ path: process.env.PI_RETRY_SCREENSHOT })
  assert.deepEqual(errors, [])
  console.log("retry settings page: ok")
} finally {
  await browser.close()
  await server.close()
}
