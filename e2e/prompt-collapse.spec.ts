import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-138：提问正文超过 6 行折叠，点击/按钮展开全文。
 *
 * 单测只能钉住阈值与 class 契约；"折叠后到底剩 6 行、点击是否真的展开、展开后是否
 * 恢复成完整高度、复制/编辑用的还是原文"只有真实布局能回答，因此这里渲染真实的
 * `ChatUserPrompt`，在窄面板与常规面板里逐层量矩形。
 *
 * 覆盖的三类正文：
 * - `short`：3 行 —— 不折叠，也没有按钮（6 行以内不该有任何 UI 变化）；
 * - `long`：12 行（`lineCount` 可调）—— 折叠到 6 行高，展开后回到完整高度；
 * - `wrapped`：无换行的长段自动折行 —— 折叠判据是**视觉行**，不是 `\n` 计数。
 */
const LINE_HEIGHT = 20

const html = `<!doctype html><html><body style="margin:0"><div id="app"></div><script type="module">
import { createApp, h, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/zh-CN.ts'
import { Conversation, ConversationContent } from '/src/components/ai-elements/conversation'
import Message from '/src/components/ai-elements/message/Message.vue'
import ChatUserPrompt from '/src/components/chat/ChatUserPrompt.vue'
import VirtualMessage from '/src/components/VirtualMessage.vue'
import '/src/style.css'
const q = new URLSearchParams(location.search)
const pane = Number(q.get('w') || 640)
const kind = q.get('k') || 'long'
const lines = Number(q.get('n') || 12)
const line = index => '第' + (index + 1) + '行提问内容：请把这一段完整读完再回答，不要跳步。'
const text = kind === 'short' ? [0, 1, 2].map(line).join('\\n')
  : kind === 'wrapped' ? '这一整段没有任何换行符，全靠容器宽度自动折行；' + '开发板部署是手工 tar 同步的，'.repeat(40)
  : Array.from({ length: lines }, (_, i) => line(i)).join('\\n')
const entry = { kind: 'user', id: 1, text }
const expanded = reactive({ value: false })
const edit = reactive({ editedPrompt: null, editedText: '', editBusy: false, editBlocked: true, lastUserPromptId: null })
window.copyCalls = []
window.toggleCalls = 0
createApp({ setup() {
  return () => h('div', { id: 'pane', style: 'width:' + pane + 'px;height:640px;display:flex;flex-direction:column;overflow:hidden;font-size:14px;line-height:' + ${LINE_HEIGHT} + 'px' }, [
    h(Conversation, { initial: 'instant', style: 'flex:1;min-height:0' }, { default: () =>
      h(ConversationContent, { class: 'conversation-column mx-auto w-full max-w-3xl gap-5 px-6 py-6 min-h-full pl-[42px]' }, { default: () =>
        h(VirtualMessage, { enabled: true, pinned: true }, { default: () =>
          h(Message, { 'data-message-id': 1, from: 'user' }, { default: () =>
            h(ChatUserPrompt, {
              entry, edit,
              promptExpanded: expanded.value,
              onTogglePrompt: () => { window.toggleCalls++; expanded.value = !expanded.value },
              onCopyText: text => window.copyCalls.push(text),
            })
          })
        })
      })
    }),
  ])
}}).use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': messages } })).use(createPinia()).mount('#app')
</script></body></html>`

let harness: VueHarness | null = null
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "prompt-collapse", port: 1522, html })
})
test.afterAll(async () => {
  await harness?.close()
})

/** 量正文容器：折叠态必须恰好 6 行高，且内容全高超过阈值。 */
async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const body = document.querySelector("[data-prompt-text]") as HTMLElement
    const style = getComputedStyle(body)
    const lineHeight = Number.parseFloat(style.lineHeight)
    const maxHeight = Number.parseFloat(style.maxHeight)
    return {
      lineHeight,
      maxHeight,
      clientHeight: body.clientHeight,
      scrollHeight: body.scrollHeight,
      overflow: style.overflow,
      collapsed: body.dataset.promptCollapsed,
      toggle: document.querySelectorAll("[data-prompt-toggle]").length,
      textLength: (body.textContent ?? "").trim().length,
      toggleCalls: (window as unknown as { toggleCalls: number }).toggleCalls,
    }
  })
}

for (const pane of [380, 640]) {
  test(`long prompts collapse to six lines inside a ${pane}px pane`, async ({ page }) => {
    await page.goto(`${harness!.url}?w=${pane}&k=long&n=12`)
    await page.waitForSelector("[data-prompt-text]")
    await page.waitForSelector("[data-prompt-toggle]")
    const m = await measure(page)
    expect(m.lineHeight, "fixture sanity").toBe(LINE_HEIGHT)
    expect(m.collapsed, "collapsed state").toBe("true")
    // 折叠态：可见高度恰好 6 行，内容全高更多（第 7 行起被裁掉）。
    expect(m.maxHeight).toBe(LINE_HEIGHT * 6)
    expect(m.clientHeight).toBe(LINE_HEIGHT * 6)
    expect(m.scrollHeight).toBeGreaterThan(LINE_HEIGHT * 6)
    expect(m.toggle, "one toggle button").toBe(1)
    // 正文没有被截断成短文本：完整原文仍在 DOM 里（折叠只是裁剪可见高度）。
    expect(m.textLength).toBeGreaterThan(60)
  })

  test(`short prompts keep their full height without a toggle at ${pane}px`, async ({ page }) => {
    await page.goto(`${harness!.url}?w=${pane}&k=short`)
    await page.waitForSelector("[data-prompt-text]")
    const m = await measure(page)
    expect(m.collapsed, "not collapsed").toBe("false")
    expect(m.toggle, "no toggle for three lines").toBe(0)
    // 折叠容器虽然始终带 max-height，但内容不足 6 行时它就是内容高度，不裁任何东西。
    expect(m.clientHeight).toBeLessThanOrEqual(LINE_HEIGHT * 6)
    expect(m.scrollHeight).toBe(m.clientHeight)
  })
}

test("clicking the collapsed body expands it and restores the full height", async ({ page }) => {
  await page.goto(`${harness!.url}?w=640&k=long&n=12`)
  await page.waitForSelector("[data-prompt-toggle]")
  const before = await measure(page)
  await page.click("[data-prompt-text]")
  await page.waitForFunction(() => (window as unknown as { toggleCalls: number }).toggleCalls === 1)
  const after = await measure(page)
  expect(after.collapsed).toBe("false")
  expect(after.clientHeight).toBe(before.scrollHeight)
  expect(after.scrollHeight).toBe(before.scrollHeight)
  // 展开后按钮仍在（用于收回去），但文案与 aria 状态切换。
  const button = page.locator("[data-prompt-toggle]")
  await expect(button).toHaveCount(1)
  await expect(button).toHaveAttribute("aria-expanded", "true")
  // 再点一次按钮收起回 6 行。
  await button.click()
  const collapsedAgain = await measure(page)
  expect(collapsedAgain.collapsed).toBe("true")
  expect(collapsedAgain.clientHeight).toBe(LINE_HEIGHT * 6)
})

test("a non-empty text selection is not mistaken for an expand click", async ({ page }) => {
  await page.goto(`${harness!.url}?w=640&k=long&n=12`)
  await page.waitForSelector("[data-prompt-toggle]")
  // 用户正在划词引用时，click 事件不能顺手展开（否则选区会被布局变化打断）。
  const selected = await page.evaluate(() => {
    const body = document.querySelector("[data-prompt-text]") as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(body)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    body.click()
    return { collapsed: selection.isCollapsed, toggleCalls: (window as unknown as { toggleCalls: number }).toggleCalls }
  })
  expect(selected.collapsed).toBe(false)
  expect(selected.toggleCalls).toBe(0)
})

test("copy still yields the full original prompt while collapsed", async ({ page }) => {
  await page.goto(`${harness!.url}?w=640&k=long&n=12`)
  await page.waitForSelector("[data-prompt-toggle]")
  const collapsed = await measure(page)
  expect(collapsed.collapsed).toBe("true")
  // 悬停后才显示的复制按钮：点击后拿到的必须是完整原文，而不是 6 行。
  await page.hover("[data-prompt-text]")
  await page.getByRole("button", { name: "复制提问" }).click()
  const copied = await page.evaluate(() => (window as unknown as { copyCalls: string[] }).copyCalls)
  expect(copied).toHaveLength(1)
  expect(copied[0].split("\n")).toHaveLength(12)
  expect(copied[0]).not.toContain("…")
})

test("auto-wrapped text collapses by visual lines, not by newline count", async ({ page }) => {
  // 只有一行文本，但在窄面板里自动折成十几行：仍必须折叠。
  await page.goto(`${harness!.url}?w=380&k=wrapped`)
  await page.waitForSelector("[data-prompt-toggle]")
  const m = await measure(page)
  expect(m.collapsed).toBe("true")
  expect(m.clientHeight).toBe(LINE_HEIGHT * 6)
  expect(m.scrollHeight).toBeGreaterThan(LINE_HEIGHT * 6)
})
