import { expect, test, type Locator, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

interface RetrySettings {
  retry?: {
    maxRetries: number
  }
}

interface TauriCall {
  command: string
  args: Record<string, unknown>
}

interface RetryTestWindow {
  isTauri: boolean
  calls: TauriCall[]
  __TAURI_INTERNALS__: {
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
  }
}

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

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "retry", port: 1455, html })
})

test.afterAll(async () => {
  await harness?.close()
})

const savedSettings = async (page: Page): Promise<RetrySettings[]> =>
  await page.evaluate(() => {
    const scopedWindow = window as unknown as RetryTestWindow
    return scopedWindow.calls
      .filter(call => call.command === "pi_settings_save")
      .map(call => call.args.settings as RetrySettings)
  })

// Toasts render in App.vue, which this harness does not mount.
const toastMessages = async (page: Page): Promise<string[]> =>
  await page.evaluate(async () => {
    const conversationsPath = "/src/stores/conversations.ts"
    const conversations = (await import(conversationsPath)) as {
      useUiStore: () => {
        toasts: Array<{
          message: string
        }>
      }
    }
    return conversations.useUiStore().toasts.map(toast => toast.message)
  })

// Saving runs the installed Pi SDK, so the panel stays disabled until it returns.
const waitForSaves = async (page: Page, count: number): Promise<void> => {
  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => {
        const scopedWindow = window as unknown as RetryTestWindow
        return scopedWindow.calls.filter(call => call.command === "pi_settings_save").length
      })
      return calls
    })
    .toBeGreaterThanOrEqual(count)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const fieldset = document.querySelector("fieldset")
        return Boolean(fieldset) && !fieldset?.disabled
      }),
    )
    .toBe(true)
}

const editNumber = async (input: Locator, text: string): Promise<void> => {
  // Type like a user so the input's change event (the commit trigger) fires.
  await input.click()
  await input.press("Control+a")
  if (text) await input.pressSequentially(text)
  else await input.press("Backspace")
  await input.press("Tab")
}

test("retry settings updates, validation, and clearing", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.addInitScript(() => {
    const scopedWindow = window as unknown as RetryTestWindow
    scopedWindow.isTauri = true
    scopedWindow.calls = []
    scopedWindow.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        scopedWindow.calls.push({ command, args })
        if (command === "pi_settings_get") {
          return { defaultProvider: "test", defaultModel: "test-model", skills: [], retry: { maxRetries: 3 } }
        }
        if (command === "pi_settings_save") return null
        return {}
      },
    }
  })

  await page.goto(`${harness.url}#/settings/general`)
  await expect(page.getByRole("heading", { name: "常规", level: 1 })).toBeVisible()
  await expect(page.getByRole("button", { name: "自动重试", exact: true })).toHaveCount(0)

  const attempts = page.getByRole("spinbutton", { name: "重试次数" })
  await expect(attempts).toHaveValue("3")

  await editNumber(attempts, "5")
  await waitForSaves(page, 1)
  expect(await savedSettings(page), "only the retry count is written").toEqual([{ retry: { maxRetries: 5 } }])

  await editNumber(attempts, "99")
  await page.waitForTimeout(300)
  const invalidSaves = await savedSettings(page)
  expect(invalidSaves, "an out-of-range count is not saved").toEqual([{ retry: { maxRetries: 5 } }])
  await expect(attempts, "the input falls back to the saved value").toHaveValue("5")
  expect(await toastMessages(page), "invalid input is reported in the current language").toContain(
    "请输入 0–20 之间的整数。",
  )

  await editNumber(attempts, "")
  await page.waitForTimeout(300)
  expect(await savedSettings(page), "an empty input is not saved as 0").toEqual([{ retry: { maxRetries: 5 } }])

  await editNumber(attempts, "0")
  await waitForSaves(page, 2)
  expect(await savedSettings(page)).toEqual([{ retry: { maxRetries: 5 } }, { retry: { maxRetries: 0 } }])

  const screenshotPath = process.env.PI_RETRY_SCREENSHOT
  if (screenshotPath) await page.screenshot({ path: screenshotPath })
  expect(errors, "the retry page must not produce page errors").toEqual([])
})
