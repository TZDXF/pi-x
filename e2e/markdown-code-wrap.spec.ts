import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

// 回归（TZD-133）：Markdown 代码块 header 增加「换行」按钮，点击一次对**所有**代码块
// 立即生效，并把偏好写进 ~/.pix/config.json；重新加载（模拟重启）后按钮状态与换行
// 行为都从配置恢复。这里用真实 Vite 模块图渲染两个独立的 MessageResponse，点击其中
// 一个代码块按钮后检查**另一个**代码块的 pre 也变了，以此证明是全局切换。

let harness: VueHarness | null = null

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import MessageResponse from '/src/components/ai-elements/message/MessageResponse.vue'
import { initializeConfigPreferences } from '/src/lib/configPreference.ts'
import '/src/style.css'

const first = 'Short block\\n\\n\\u0060\\u0060\\u0060ts\\nconst a = 1\\n\\u0060\\u0060\\u0060'
const second = 'Second block\\n\\n\\u0060\\u0060\\u0060ts\\nconst b = 2\\n\\u0060\\u0060\\u0060'

await initializeConfigPreferences()
createApp({ render: () => h('main', { style: 'padding:16px;width:900px' }, [
  h('section', { 'data-message': 'first' }, [h(MessageResponse, { content: first, mode: 'static' })]),
  h('section', { 'data-message': 'second' }, [h(MessageResponse, { content: second, mode: 'static' })]),
]) }).use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).use(createPinia()).mount('#app')
</script></body></html>`

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "markdown-code-wrap", port: 1545, html })
})

test.afterAll(async () => {
  await harness?.close()
})

/** 主机配置（config.json 的 preferences 段）用 sessionStorage 模拟：同一标签页重载后仍在。 */
async function installHostConfig(page: Page, initial: Record<string, string> = {}) {
  await page.addInitScript((defaults: Record<string, string>) => {
    const harnessWindow = window as Window & {
      isTauri: boolean
      __TAURI_INTERNALS__?: Record<string, unknown>
      __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
      __writes?: { key: string; value: string }[]
    }
    const readPreferences = (): Record<string, string> => {
      const map: Record<string, string> = { ...defaults }
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)!
        if (key.startsWith("pref:")) map[key.slice(5)] = sessionStorage.getItem(key)!
      }
      // 已写入过的默认值不覆盖：重启后仍读最后一次保存。
      return map
    }
    if (sessionStorage.getItem("__hostReady") !== "1") {
      for (const [key, value] of Object.entries(defaults)) sessionStorage.setItem(`pref:${key}`, value)
      sessionStorage.setItem("__hostReady", "1")
    }
    const callbacks = new Map<number, (payload: unknown) => void>()
    let nextId = 1
    harnessWindow.isTauri = true
    harnessWindow.__writes = []
    harnessWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    const internals = {
      transformCallback: (callback: (payload: unknown) => void) => {
        const id = nextId++
        callbacks.set(id, callback)
        return id
      },
      invoke: async (command: string, args: Record<string, string>) => {
        if (command === "app_config_get") return { preferences: readPreferences() }
        if (command === "app_preference_set") {
          harnessWindow.__writes!.push({ key: args.key, value: args.value })
          sessionStorage.setItem(`pref:${args.key}`, args.value)
          for (const callback of callbacks.values()) {
            callback({ event: "pi://app-config-changed", id: nextId, payload: { preferences: readPreferences() } })
          }
          return null
        }
        if (command === "plugin:event|listen") return nextId
        if (command === "plugin:event|unlisten") return null
        return null
      },
    }
    Reflect.set(harnessWindow, "__TAURI_INTERNALS__", internals)
  }, initial)
}

const wrapButtonName = (on: boolean) =>
  on
    ? "Turn off code block wrapping (applies to all code blocks)"
    : "Turn on code block wrapping (applies to all code blocks)"

async function preWrapState(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".stream-markdown pre")).map(
      element => getComputedStyle(element).whiteSpace,
    ),
  )
}

test("one click wraps every markdown code block and persists the preference", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await installHostConfig(page, { markdownCodeWrap: "1" })
  await page.goto(harness!.url)

  const blocks = page.locator(".stream-markdown pre")
  await expect(blocks).toHaveCount(2)
  // 默认换行：两个代码块都是 pre-wrap。
  expect(await preWrapState(page)).toEqual(["pre-wrap", "pre-wrap"])

  // 只在第一个消息体的代码块上点一次。
  await page
    .locator('[data-message="first"]')
    .getByRole("button", { name: wrapButtonName(true) })
    .click()
  // 全局即时生效：两个代码块都变成 nowrap，且按钮文案整体切换。
  await expect.poll(() => preWrapState(page)).toEqual(["pre", "pre"])
  expect(await page.getByRole("button", { name: wrapButtonName(false) }).count()).toBe(2)
  expect(await page.getByRole("button", { name: wrapButtonName(true) }).count()).toBe(0)

  // 偏好写入主机配置（~/.pix/config.json 的 preferences 段）。
  const writes = await page.evaluate(() => Reflect.get(window, "__writes"))
  expect(writes).toEqual([{ key: "markdownCodeWrap", value: "0" }])

  expect(errors).toEqual([])
})

test("a reload restores the saved wrapping preference", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await installHostConfig(page)
  await page.goto(harness!.url)

  await page
    .getByRole("button", { name: wrapButtonName(true) })
    .first()
    .click()
  await expect.poll(() => preWrapState(page)).toEqual(["pre", "pre"])

  // 模拟重启：同一标签页重新加载，配置从主机（sessionStorage 模拟）重新读取。
  await page.reload()
  await expect(page.locator(".stream-markdown pre")).toHaveCount(2)
  await expect.poll(() => preWrapState(page)).toEqual(["pre", "pre"])
  expect(await page.getByRole("button", { name: wrapButtonName(false) }).count()).toBe(2)

  // 再切回换行，同样立即作用于所有代码块。
  await page
    .locator('[data-message="second"]')
    .getByRole("button", { name: wrapButtonName(false) })
    .click()
  await expect.poll(() => preWrapState(page)).toEqual(["pre-wrap", "pre-wrap"])

  expect(errors).toEqual([])
})
