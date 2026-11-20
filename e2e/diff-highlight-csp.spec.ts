import { expect, test, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-136 验收回归（P2）：diff 里某一侧只有一个空行时，两侧分别 join("\n") 后那一侧就是
 * 空串。早前共享着色器把空串当"空输入"返回 null，`highlightDiffLines` 随即丢弃整份
 * diff 的着色 —— 有内容的那一侧也跟着变纯文本。这里在真实 diff 组件上双向验证，
 * 并把桌面端 CSP 一起挂上（两件事同一条路径）。
 */
const TAURI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1430 ws://localhost:1421; " +
  "frame-src 'self' https: http:"

const CODE = "export const fresh = 42"

/** 空行 → 一行代码（新增方向）与 一行代码 → 空行（删除方向）。 */
const cases = [
  {
    id: "add",
    label: "blank line replaced by code",
    lines: [
      { kind: "remove", text: "", oldLine: 1 },
      { kind: "add", text: CODE, newLine: 1 },
    ],
    colored: "add",
  },
  {
    id: "del",
    label: "code replaced by a blank line",
    lines: [
      { kind: "remove", text: CODE, oldLine: 1 },
      { kind: "add", text: "", newLine: 1 },
    ],
    colored: "del",
  },
] as const

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import SessionDiff from '/src/components/SessionDiff.vue'
import '/src/style.css'
const cases = ${JSON.stringify(cases)}
createApp({ render: () => h('div', { style: 'display:flex;gap:16px;width:1100px' }, cases.map(item =>
  h('div', { style: 'width:520px', 'data-case': item.id }, [
    h('p', { style: 'font-size:12px' }, item.label),
    h(SessionDiff, { change: { id: item.id, path: 'src/a.ts', tool: 'write', lines: item.lines, added: 1, removed: 1, unknownBefore: false }, split: false, word: false }),
  ]))) })
  .use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).mount('#app')
</script></body></html>`

let harness: VueHarness

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "diff-highlight-csp", port: 1591, html })
})

test.afterAll(async () => {
  await harness?.close()
})

async function applyCsp(page: Page, csp: string | null) {
  await page.route(/localhost:1591/, async route => {
    const response = await route.fetch()
    const headers = { ...response.headers() }
    if (csp) headers["content-security-policy"] = csp
    await route.fulfill({ response, headers })
  })
}

for (const scenario of [
  { name: "under the desktop CSP", csp: TAURI_CSP },
  { name: "in a browser without CSP", csp: null },
] as const) {
  test(`one blank diff side keeps the other side highlighted ${scenario.name}`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await applyCsp(page, scenario.csp)
    await page.goto(harness.url)

    for (const item of cases) {
      const card = page.locator(`[data-case="${item.id}"]`)
      // 有内容的那一侧必须拿到带双主题变量的 token。
      const coloredRow = card.locator(`.review-code-line.review-${item.colored}`)
      await expect(coloredRow.locator(".review-code-text")).toContainText(CODE)
      await expect(coloredRow.locator(".review-code-text span[style]")).not.toHaveCount(0, { timeout: 20_000 })
      const colors = await coloredRow.evaluate(row => {
        const code = row.querySelector(".review-code-text") as HTMLElement | null
        return [...(code?.querySelectorAll("span[style]") ?? [])].map(span => getComputedStyle(span).color)
      })
      // `export` 与标识符必须拿到不同颜色，否则只是"没报错"的纯文本。
      expect(new Set(colors).size, `${item.id} must have more than one color`).toBeGreaterThan(1)
      // 空行一侧保留一行（空）内容，而不是整行被丢掉（无 html 时组件回退渲染一个空格）。
      const blankRow = card.locator(`.review-code-line.review-${item.colored === "add" ? "del" : "add"}`)
      await expect(blankRow).toHaveCount(1)
      const blankText = (await blankRow.locator(".review-code-text").textContent()) ?? ""
      expect(blankText.replace(/\s/g, "")).toBe("")
    }
    expect(errors).toEqual([])
  })
}
