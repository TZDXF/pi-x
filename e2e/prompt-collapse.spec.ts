import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-138：提问正文超过 6 个**视觉行**折叠，点击/按钮展开全文。
 *
 * 单测钉住判定函数与 class 契约；"折叠后到底剩 6 个视觉行、含 chip 的行盒更高时 6 行
 * 是否被误裁、裁剪区里的引用能否被定位"只有真实布局能回答，因此这里渲染真实的
 * `ChatUserPrompt` / `CollapsiblePromptText`，在窄面板与常规面板里逐层量矩形。
 *
 * 覆盖：
 * - `short`：3 行 —— 不折叠、无按钮；
 * - `long`：12 行 —— 折叠到 6 行高，点击后回到完整高度，再点收起；
 * - `chips6`：**恰好 6 行、每行一个文件引用 chip**（QA P2 复现形态）—— 不折叠、无按钮，
 *   第 6 行完整可见；
 * - `chips7`：7 行、每行一个 chip —— 折叠，且第 6 行（更高的 chip 行盒）完整可见；
 * - `wrap`：窄面板里自动折行的同一段文本 —— 按视觉行折叠，宽度变化后重算；
 * - `clip`：收起态下划词引用位于裁剪区 —— 徽标不画；点摘要定位先展开正文再落徽标。
 *
 * fixture 的每行都足够短，保证 380px 与 640px 下"逻辑行 = 视觉行"，只有 `wrap` 故意折行。
 */
const LINE_HEIGHT = 20

const html = `<!doctype html><html><body style="margin:0"><div id="app"></div><script type="module">
import { createApp, h, reactive, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import messages from '/src/i18n/locales/zh-CN.ts'
import { Conversation, ConversationContent } from '/src/components/ai-elements/conversation'
import Message from '/src/components/ai-elements/message/Message.vue'
import ChatUserPrompt from '/src/components/chat/ChatUserPrompt.vue'
import VirtualMessage from '/src/components/VirtualMessage.vue'
import SelectionAnchorBadges from '/src/components/chat/SelectionAnchorBadges.vue'
import { useSelectionQuotes } from '/src/composables/useSelectionQuotes'
import { useConversationSelectionsStore } from '/src/stores/conversationSelections'
import '/src/style.css'
const q = new URLSearchParams(location.search)
const pane = Number(q.get('w') || 640)
const kind = q.get('k') || 'long'
const lines = Number(q.get('n') || 12)
// 短行：任意面板宽度下都是"一行文字 = 一个视觉行"。
const plain = index => 'Q' + (index + 1) + '. ' + 'keep this short '
// chip 行：短文字 + 一个文件引用 chip（message 模式下渲染成 chip，行盒比正文行高更高）。
const chipped = index => 'Q' + (index + 1) + ' @s' + index + '.ts'
const wrapped = '这一整段没有任何换行符，全靠容器宽度自动折行；' + '开发板部署是手工 tar 同步的，'.repeat(40)
const count = kind === 'short' ? 3 : kind === 'chips6' ? 6 : kind === 'chips7' ? 7 : lines
const text = kind === 'wrap' ? wrapped
  : kind === 'chips6' || kind === 'chips7' ? Array.from({ length: count }, (_, i) => chipped(i)).join('\\n')
  : Array.from({ length: count }, (_, i) => plain(i)).join('\\n')
const entry = { kind: 'user', id: 1, text }
const expanded = reactive({ value: false })
const expandedIds = reactive(new Set())
const width = ref(pane)
const edit = reactive({ editedPrompt: null, editedText: '', editBusy: false, editBlocked: true, lastUserPromptId: null })
window.copyCalls = []
window.toggleCalls = 0
window.locateCalls = 0
window.setPane = px => { width.value = px }
const pinia = createPinia()
setActivePinia(pinia)
createApp({ setup() {
  const rootEl = ref(null)
  const conversation = ref(null)
  const store = useConversationSelectionsStore()
  // 引用落在第 11 行（收起态下被裁掉的那几行里）：字符偏移取自正文本身。
  const clipStart = text.indexOf('Q11.')
  const clipEnd = clipStart + 8
  store.add('session', { text: text.slice(clipStart, clipEnd), source: 'user', messageId: 1, startOffset: clipStart, endOffset: clipEnd })
  // 与 ChatTurnList 同构的展开入口：按 entry id 记、幂等。
  function revealClippedPrompt(id) {
    if (expandedIds.has(id)) return false
    expandedIds.add(id)
    expanded.value = true
    return true
  }
  const quotes = useSelectionQuotes({
    session: { sessionFile: 'session' },
    ui: { pushToast() {} },
    project: () => 'project',
    renderedEntries: () => [],
    conversation: conversation,
    revealClippedPrompt,
  })
  window.locateClip = async () => {
    window.locateCalls++
    await quotes.locateSelection(store.items[0].id)
  }
  window.anchorCount = () => quotes.anchorOverlays.value.size
  // $el 是真实的 DOM 根（划词锚点按它做坐标换算）；气泡只有一个，无需滚动。
  conversation.value = { get $el() { return rootEl.value }, scrollToMessage: async () => {} }
  return () => h('div', { id: 'pane', ref: rootEl, style: 'width:' + width.value + 'px;height:640px;display:flex;flex-direction:column;overflow:hidden;font-size:14px;line-height:' + ${LINE_HEIGHT} + 'px' }, [
    h(Conversation, { initial: 'instant', style: 'flex:1;min-height:0' }, { default: () =>
      h(ConversationContent, { class: 'conversation-column mx-auto w-full max-w-3xl gap-5 px-6 py-6 min-h-full pl-[42px]' }, { default: () =>
        h(VirtualMessage, { enabled: true, pinned: true }, { default: () =>
          h(Message, { 'data-message-id': 1, from: 'user' }, { default: () =>
            h('div', { 'data-selection-source': 'user', class: 'relative flex min-w-0 flex-col items-end' }, [
              h(ChatUserPrompt, {
                entry, edit,
                promptExpanded: expanded.value,
                onTogglePrompt: () => { window.toggleCalls++; expanded.value = !expanded.value },
                onCopyText: text => window.copyCalls.push(text),
              }),
              // 与 ChatTurnList 同构：引用徽标覆盖层挂在消息行内、气泡之后。
              h(SelectionAnchorBadges, {
                badges: quotes.anchorOverlays.value.get(1) ?? [],
                onEdit: () => {},
              }),
            ])
          })
        })
      })
    }),
  ])
}}).use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': messages } })).use(pinia).mount('#app')
</script></body></html>`

let harness: VueHarness | null = null
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "prompt-collapse", port: 1522, html })
})
test.afterAll(async () => {
  await harness?.close()
})

/** 量正文容器与**实际视觉行**（行盒取同一行所有矩形并集，含更高的 chip 行盒）。 */
async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const body = document.querySelector("[data-prompt-text]") as HTMLElement
    const style = getComputedStyle(body)
    const bodyRect = body.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(body)
    const rects = [...range.getClientRects()].filter(rect => rect.height > 0)
    const lines: { top: number; bottom: number }[] = []
    for (const rect of rects.sort((a, b) => a.top - b.top)) {
      const last = lines[lines.length - 1]
      if (last && rect.top < last.bottom - 0.5) {
        last.top = Math.min(last.top, rect.top)
        last.bottom = Math.max(last.bottom, rect.bottom)
      } else lines.push({ top: rect.top, bottom: rect.bottom })
    }
    const visible = lines.filter(line => line.bottom - bodyRect.top <= body.clientHeight + 0.5)
    const badge = document.querySelector("sup[data-selection-anchor]") as HTMLElement | null
    return {
      lineHeight: Number.parseFloat(style.lineHeight),
      clientHeight: body.clientHeight,
      scrollHeight: body.scrollHeight,
      collapsed: body.dataset.promptCollapsed,
      lineCount: Number(body.dataset.promptLines),
      measuredLines: lines.length,
      visibleLines: visible.length,
      // 可见区里的每一行都必须**整行**可见（下半截被裁就算违约）。
      visibleLinesWhole: visible.every(line => line.top - bodyRect.top >= -0.5),
      toggle: document.querySelectorAll("[data-prompt-toggle]").length,
      chips: document.querySelectorAll("[data-prompt-text] .border-primary\\/20").length,
      textLength: (body.textContent ?? "").trim().length,
      toggleCalls: (window as unknown as { toggleCalls: number }).toggleCalls,
      anchors: (window as unknown as { anchorCount: () => number }).anchorCount(),
      anchorElements: document.querySelectorAll("sup[data-selection-anchor]").length,
      anchorVisible:
        !!badge &&
        badge.getBoundingClientRect().height > 0 &&
        badge.getBoundingClientRect().top >= bodyRect.top - 0.5 &&
        badge.getBoundingClientRect().bottom <= bodyRect.bottom + 0.5,
    }
  })
}

/** 折叠态：可见 6 个整行，高度不超过 6 行（含 chip 行盒时略高，但绝不到第 7 行）。 */
async function expectSixWholeLines(page: import("@playwright/test").Page) {
  const m = await measure(page)
  expect(m.collapsed, "collapsed state").toBe("true")
  expect(m.visibleLines, "exactly six visible lines").toBe(6)
  expect(m.visibleLinesWhole, "no half-clipped sixth line").toBe(true)
  expect(m.lineCount, "component counts the same visual lines").toBe(m.measuredLines)
  expect(m.lineCount).toBeGreaterThan(6)
  expect(m.clientHeight, "clamp stays within the sixth line box").toBeLessThanOrEqual(m.scrollHeight - 0.5)
  expect(m.toggle, "one toggle button").toBe(1)
  return m
}

for (const pane of [380, 640]) {
  test(`long prompts collapse to six lines inside a ${pane}px pane`, async ({ page }) => {
    await page.goto(`${harness!.url}?w=${pane}&k=long&n=12`)
    await page.waitForSelector("[data-prompt-toggle]")
    const m = await expectSixWholeLines(page)
    expect(m.lineCount, "twelve logical lines").toBe(12)
    // 正文没有被截断：完整原文仍在 DOM 里（折叠只裁高度）。
    expect(m.textLength).toBeGreaterThan(60)
  })

  test(`short prompts keep their full height without a toggle at ${pane}px`, async ({ page }) => {
    await page.goto(`${harness!.url}?w=${pane}&k=short`)
    await page.waitForSelector("[data-prompt-text]")
    const m = await measure(page)
    expect(m.lineCount).toBe(3)
    expect(m.collapsed).toBe("false")
    expect(m.toggle, "no toggle for three lines").toBe(0)
    expect(m.clientHeight).toBe(m.scrollHeight)
    expect(m.visibleLines).toBe(3)
  })

  // QA P2 的复现形态：6 行、每行一个文件引用 chip。chip 的行盒比 line-height 更高
  // （实测 22px vs 20px），按"6 × line-height"裁剪会把第 6 行切掉下半截并给出折叠按钮。
  test(`exactly six chip lines stay fully visible without a toggle at ${pane}px`, async ({ page }) => {
    await page.goto(`${harness!.url}?w=${pane}&k=chips6`)
    await page.waitForSelector("[data-prompt-text] .border-primary\\/20")
    const m = await measure(page)
    expect(m.chips, "chip rows render").toBeGreaterThanOrEqual(6)
    expect(m.lineCount, "six visual lines").toBe(6)
    expect(m.measuredLines).toBe(6)
    // 关键回归：恰好 6 行 → 不折叠、没有按钮，且第 6 行没有被裁掉任何像素。
    expect(m.collapsed).toBe("false")
    expect(m.toggle, "no toggle at exactly six chip lines").toBe(0)
    expect(m.clientHeight).toBe(m.scrollHeight)
    expect(m.visibleLines).toBe(6)
    // 行盒确实比正文行高更高 —— 证明这个 fixture 真的复现了 P2 的条件。
    expect(m.scrollHeight).toBeGreaterThan(m.lineHeight * 6)
  })
}

test("seven chip lines collapse without clipping the sixth line", async ({ page }) => {
  await page.goto(`${harness!.url}?w=640&k=chips7`)
  await page.waitForSelector("[data-prompt-toggle]")
  const m = await expectSixWholeLines(page)
  expect(m.chips, "seven chip rows").toBeGreaterThanOrEqual(7)
  expect(m.lineCount).toBe(7)
  // 裁剪高度按第 6 行的真实下边界，因此比 6 × line-height 更高（含 chip 的行盒）。
  expect(m.clientHeight).toBeGreaterThan(m.lineHeight * 6)
})

test("clicking the collapsed body expands it and restores the full height", async ({ page }) => {
  await page.goto(`${harness!.url}?w=640&k=long&n=12`)
  await page.waitForSelector("[data-prompt-toggle]")
  const before = await measure(page)
  await page.click("[data-prompt-text]")
  await page.waitForFunction(() => (window as unknown as { toggleCalls: number }).toggleCalls === 1)
  const after = await measure(page)
  expect(after.collapsed).toBe("false")
  expect(after.clientHeight).toBe(before.scrollHeight)
  expect(after.visibleLines).toBe(12)
  const button = page.locator("[data-prompt-toggle]")
  await expect(button).toHaveCount(1)
  await expect(button).toHaveAttribute("aria-expanded", "true")
  await button.click()
  const collapsedAgain = await measure(page)
  expect(collapsedAgain.collapsed).toBe("true")
  expect(collapsedAgain.visibleLines).toBe(6)
})

test("a non-empty text selection is not mistaken for an expand click", async ({ page }) => {
  await page.goto(`${harness!.url}?w=640&k=long&n=12`)
  await page.waitForSelector("[data-prompt-toggle]")
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
  expect((await measure(page)).collapsed).toBe("true")
  await page.hover("[data-prompt-text]")
  await page.getByRole("button", { name: "复制提问" }).click()
  const copied = await page.evaluate(() => (window as unknown as { copyCalls: string[] }).copyCalls)
  expect(copied).toHaveLength(1)
  expect(copied[0].split("\n")).toHaveLength(12)
  expect(copied[0]).not.toContain("…")
})

test("auto-wrapped text folds by visual lines and re-measures on width change", async ({ page }) => {
  // 只有一行文本，靠在窄面板里自动折行占十几行：仍必须折叠，且宽度变化后重新判定。
  await page.goto(`${harness!.url}?w=380&k=wrap`)
  await page.waitForSelector("[data-prompt-toggle]")
  const narrow = await expectSixWholeLines(page)
  expect(narrow.measuredLines).toBeGreaterThan(6)
  // 变宽后单行能容下更多字，行数下降；组件必须跟着重测（`ResizeObserver`）。
  await page.evaluate(() => (window as unknown as { setPane: (px: number) => void }).setPane(1200))
  await page.waitForFunction(
    (previous: number) =>
      Number(document.querySelector("[data-prompt-text]")?.getAttribute("data-prompt-lines")) < previous,
    narrow.lineCount,
  )
  const wide = await measure(page)
  expect(wide.lineCount, "re-measured after widening").toBeLessThan(narrow.lineCount)
  // 再收窄回去，行数恢复（不是"一次性判定"）。
  await page.evaluate(() => (window as unknown as { setPane: (px: number) => void }).setPane(380))
  await page.waitForFunction(
    (previous: number) =>
      Number(document.querySelector("[data-prompt-text]")?.getAttribute("data-prompt-lines")) > previous,
    wide.lineCount,
  )
})

test("a reference clipped by the collapsed prompt is revealed before locating", async ({ page }) => {
  // QA P2 的第二种形态：收起态下第 11 行的引用没有可见锚点。收起时不该画徽标；
  // 点摘要定位时先展开正文、再重算锚点并把徽标落回可见正文里。
  await page.goto(`${harness!.url}?w=640&k=long&n=12`)
  await page.waitForSelector("[data-prompt-toggle]")
  const collapsed = await measure(page)
  expect(collapsed.collapsed).toBe("true")
  expect(collapsed.anchorElements, "no badge for a clipped reference while collapsed").toBe(0)
  await page.evaluate(() => (window as unknown as { locateClip: () => Promise<void> }).locateClip())
  await page.waitForSelector("sup[data-selection-anchor]")
  const revealed = await measure(page)
  expect(revealed.collapsed, "locating expanded the prompt").toBe("false")
  expect(revealed.anchorElements).toBe(1)
  // 徽标落在可见正文区域内（展开后第 11 行可见），而不是气泡下方空白处。
  expect(revealed.anchorVisible, "badge sits inside the visible prompt body").toBe(true)
  expect(revealed.visibleLines).toBe(revealed.measuredLines)
})
