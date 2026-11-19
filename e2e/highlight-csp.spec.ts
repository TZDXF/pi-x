import { expect, test, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * 回归：桌面端 Tauri 给 webview 的是 `tauri.conf.json` 里那条 CSP（`script-src 'self'`，
 * 没有 `'wasm-unsafe-eval'`）。shiki 默认入口的 oniguruma 引擎要编译 WASM，会被 CSP 直接
 * 拒绝，异常被 preview 的 catch 吞掉后文件预览静默退化成纯文本 —— 浏览器 dev（无 CSP）
 * 下看不出来。这里把真实 CSP 头挂到 harness 上，断言桌面端那条路径仍然着色。
 * CSP 是浏览器行为，单元测试只能到"屏蔽 WebAssembly"这一层，因此保留一条 E2E。
 */
const TAURI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1430 ws://localhost:1421; " +
  "frame-src 'self' https: http:"

const fileText = ["interface Foo {", "  value: number", "}", "", "\treturn (", ")"].join("\n")

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import ProjectFilePreview from '/src/components/ProjectFilePreview.vue'
import '/src/style.css'
createApp({ render: () => h('div', { style: 'display:flex;height:420px;width:620px' }, [
  h(ProjectFilePreview, { project: 'C:/demo', path: 'src/demo.ts' }),
]) })
  .use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).use(createPinia()).mount('#app')
</script></body></html>`

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "highlight-csp", port: 1590, html })
})

test.afterAll(async () => {
  await harness?.close()
})

async function mockPreview(page: Page) {
  await page.addInitScript((text: string) => {
    Reflect.set(window, "isTauri", true)
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string) => {
        if (command === "read_file_preview") return { kind: "text", text, truncated: false, mime: null, data: null }
        throw Error("unexpected command: " + command)
      },
    })
  }, fileText)
}

async function applyCsp(page: Page, csp: string) {
  await page.route(new RegExp(`localhost:1590`), async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } })
  })
}

test("code preview stays highlighted under the desktop CSP", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await applyCsp(page, TAURI_CSP)
  await mockPreview(page)
  await page.goto(harness.url)

  const preview = page.locator('section[aria-label="File preview"]')
  await expect(preview).toBeVisible()

  // 着色是异步分词：等到 token 带上 shiki 的双主题颜色变量，而不是停在纯文本回退。
  const firstLine = preview.locator(".preview-code").first()
  await expect(firstLine.locator("span[style]")).not.toHaveCount(0)
  await expect(firstLine).toContainText("interface Foo {")
  const colors = await page.evaluate(() => {
    const code = document.querySelector(".preview-code") as HTMLElement | null
    return [...(code?.querySelectorAll("span[style]") ?? [])].map(span => getComputedStyle(span).color)
  })
  // 关键字与标识符必须拿到不同颜色，否则只是"没出错"的纯文本。
  expect(new Set(colors).size).toBeGreaterThan(1)

  const gutter = await preview.locator("[data-line]").count()
  expect(gutter).toBe(fileText.split("\n").length)
  expect(errors).toEqual([])
})

test("indentation and line alignment survive highlighting", async ({ page }) => {
  await mockPreview(page)
  await page.goto(harness.url)
  const preview = page.locator('section[aria-label="File preview"]')
  await expect(preview.locator(".preview-code").first().locator("span[style]")).not.toHaveCount(0)

  // 行内 token 不得丢空白/制表符：行号与源码必须逐行对齐，批注与定位才不错位。
  const lines = await page.evaluate(() =>
    [...document.querySelectorAll(".preview-code")].map(code => (code.textContent ?? "").replace(/\r/g, "")),
  )
  expect(lines.join("\n")).toBe(fileText)
})
