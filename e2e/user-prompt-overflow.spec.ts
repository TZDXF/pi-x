import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-119 回归：批注/上下文卡片内的超长文本必须在卡片内截断/换行，不得横向溢出。
 *
 * 单测只能钉住 class 契约；"是否真的没顶出容器、文本段是否还被压成 0 宽"只有布局能回答，
 * 因此这里渲染真实的 `ChatUserPrompt` / `ChatComposer`，在辅助对话面板那种几百像素宽的
 * 容器里逐层量矩形：
 *
 * 1. 任何元素都不得越过面板左右边界；
 * 2. 文本段（路径 / 行号 / 批注 / 划词引用）必须有**正宽度**（不跳过零尺寸元素）；
 * 3. 行号是独立后缀段，窄面板下也必须完整可读（`scrollWidth <= clientWidth`）；
 * 4. 有父上下文块与**没有**父上下文块两种 fixture 都要满足 —— 溢出断言不能依赖父块。
 */
const longToken = "X".repeat(400)
const longCjk = "开发板部署是手工同步的".repeat(30)
const longPath = "src/" + "deep_folder_with_long_name/".repeat(10) + "file.rs"
const realPath = "service/docs/AI_SERVER_DEPLOY.md"
const realComment =
  "开发板部署是手工 tar 同步的 app/ + web/dist，建议之后把开发板部署流程也写进 service/docs/AI_SERVER_DEPLOY.md，并把 build 产物目录与 tar 包命名规范一并补齐，避免每次口头传达。"
/** 与 fixture 里的 `startLine` / `endLine` 对应，行号段的期望文本。 */
const lineLabel = "120-132"

const html = `<!doctype html><html><body style="margin:0"><div id="app"></div><script type="module">
import { createApp, h, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/zh-CN.ts'
import { Conversation, ConversationContent } from '/src/components/ai-elements/conversation'
import Message from '/src/components/ai-elements/message/Message.vue'
import ChatUserPrompt from '/src/components/chat/ChatUserPrompt.vue'
import ChatComposer from '/src/components/chat/ChatComposer.vue'
import VirtualMessage from '/src/components/VirtualMessage.vue'
import { serializeComposerPromptContexts } from '/src/lib/promptContexts.ts'
import '/src/style.css'
const token = ${JSON.stringify(longToken)}
const cjk = ${JSON.stringify(longCjk)}
const longPath = ${JSON.stringify(longPath)}
const realPath = ${JSON.stringify(realPath)}
const realComment = ${JSON.stringify(realComment)}
const q = new URLSearchParams(location.search)
const pane = Number(q.get('w') || 470)
const surface = q.get('s') || 'bubble'
const kind = q.get('k') || 'token'
// 'p' = 是否把父上下文块拼进 prompt（TZD-119 之后气泡不渲染它，但两种 fixture 都要量）。
const withParent = q.get('p') === '1'
const text = kind === 'token' ? token : kind === 'cjk' ? cjk : kind === 'path' ? longPath : realComment
const path = kind === 'real' ? realPath : text + ':' + longPath
const comment = kind === 'real' ? realComment : text + cjk
const comments = [{ path, startLine: 120, endLine: 132, selectedText: '', comment }]
const selections = [{ id: 's1', text: comment, comment: path }]
const prompt = serializeComposerPromptContexts('总结开发板部署文档', { comments, selections, parentContext: withParent ? comment : null })
const entry = { kind: 'user', id: 1, text: prompt }
const edit = reactive({ editedPrompt: null, editedText: '', editBusy: false, editBlocked: true, lastUserPromptId: null })
const pendingComments = [{ id: 'p1', path, startLine: 120, endLine: 132, selectedText: '', comment }]
const controls = {
  pendingSelections: [], pendingComments, codeComments: { remove() {} }, selections: { remove() {} },
  delayedSend: false, delayedSendEnabled: false, sendDelayMinutes: 1, sendDelaySeconds: 5, showStopButton: false,
  onSendDelayWheel() {}, onSubmit() {}, abort() {}, onInputError() {},
}
const session = reactive({ sessionFile: null, entries: [{ kind: 'user', id: 1, text: 'hi' }], promptQueue: [], commands: [], models: [], thinkingLevel: 'off', availableThinking: [], started: true, runtimeId: 'aux:1', isStreaming: false, historyLoading: false })
const ui = reactive({ widgets: [], toasts: [], pushToast() {}, widget: null })
createApp({ setup() {
  const body = surface === 'composer'
    ? h(ChatComposer, { session, ui, runtimeId: 'aux:1', project: '', gitBusy: false, connecting: false, connected: true, editBusy: false, sessionDragOver: false, initialDraft: '', ensureStarted: async () => true, hideWorkspaceContext: true, controls, bridge: null, workspaceSelection: null })
    : h(Conversation, { initial: 'instant', style: 'flex:1;min-height:0' }, { default: () => h(ConversationContent, { class: 'conversation-column mx-auto w-full max-w-3xl gap-5 px-6 py-6 min-h-full pl-[42px]' }, { default: () => h(VirtualMessage, { enabled: true, pinned: true }, { default: () => h(Message, { 'data-message-id': 1, from: 'user' }, { default: () => h(ChatUserPrompt, { entry, edit }) }) }) }) })
  return () => h('div', { id: 'pane', style: 'width:' + pane + 'px;height:600px;display:flex;flex-direction:column;overflow:hidden' }, [body])
}}).use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': messages } })).use(createPinia()).mount('#app')
</script></body></html>`

let harness: VueHarness
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "user-prompt-overflow", port: 1521, html })
})
test.afterAll(async () => {
  await harness!.close()
})

/** canvas 里量过的布局事实；断言放在测试里，失败信息能直接指出哪一类元素违约。 */
async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const pane = document.querySelector("#pane")!.getBoundingClientRect()
    const escaped: string[] = []
    const zeroWidthText: string[] = []
    const spans: {
      label: string
      width: number
      height: number
      lineHeight: number
      whiteSpace: string
      textOverflow: string
      lines: number
      scroll: number
      client: number
      text: string
    }[] = []
    for (const el of document.querySelector("#pane")!.querySelectorAll("*")) {
      const rect = el.getBoundingClientRect()
      if (el.closest("svg")) continue
      if (rect.right > pane.right + 0.5 || rect.left < pane.left - 0.5)
        escaped.push(`${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`)
      // chip 文本段（`data-chip-text`）：必须有正宽度，否则"截断"变成了"消失"。
      // 只量 chip 内的段：气泡正文（`ComposerText`）本来就该换行，不属于"单行"范围。
      if (el.tagName === "SPAN" && el.hasAttribute("data-chip-text") && (el.textContent ?? "").trim()) {
        const label = el.getAttribute("data-code-comment-lines") !== null ? "lines" : "text"
        const style = getComputedStyle(el)
        const lineHeight = Number.parseFloat(style.lineHeight)
        spans.push({
          label,
          width: rect.width,
          height: rect.height,
          lineHeight,
          whiteSpace: style.whiteSpace,
          textOverflow: style.textOverflow,
          lines:
            Number.parseFloat(style.webkitLineClamp) || Number.parseFloat(style.getPropertyValue("line-clamp")) || 1,
          scroll: el.scrollWidth,
          client: el.clientWidth,
          text: (el.textContent ?? "").trim(),
        })
        if (rect.width <= 0) zeroWidthText.push(`${label}:${(el.textContent ?? "").trim().slice(0, 20)}`)
      }
    }
    // chip 容器里的文本段宽度：按 DOM 结构取（`[data-code-comment-tag]` 与划词卡片），
    // 不依赖本轮新增的 `data-chip-text` 标记，便于跨版本对照。
    const chipTextWidths: number[] = []
    const chipContainers = [
      ...document.querySelectorAll("[data-code-comment-tag]"),
      ...document.querySelectorAll("#pane .rounded-md.border"),
    ]
    for (const chip of chipContainers)
      for (const span of chip.querySelectorAll("span"))
        if ((span.textContent ?? "").trim()) chipTextWidths.push(span.getBoundingClientRect().width)
    return {
      paneWidth: pane.width,
      escaped,
      zeroWidthText,
      chipTextWidths,
      spans,
      lineLabels: [...document.querySelectorAll("[data-code-comment-lines]")].map(el => ({
        text: (el.textContent ?? "").trim(),
        width: el.getBoundingClientRect().width,
        scroll: el.scrollWidth,
        client: el.clientWidth,
      })),
    }
  })
}

for (const surface of ["bubble", "composer"]) {
  test(`${surface} keeps long-text cards inside a narrow aux pane`, async ({ page }) => {
    // token：完全无断行机会的长串；real：截图里的真实中英混排路径 + 批注。
    for (const kind of ["token", "real"]) {
      for (const pane of [380, 610]) {
        await page.goto(`${harness.url}?w=${pane}&s=${surface}&k=${kind}`)
        await page.waitForSelector(surface === "composer" ? "[data-slot=input-group]" : "[data-code-comment-tag]")
        const m = await measure(page)
        expect(m.paneWidth, "fixture sanity").toBe(pane)
        expect(m.escaped, `${surface}/${kind} at ${pane}px escapes the pane`).toEqual([])
        expect(m.zeroWidthText, `${surface}/${kind} at ${pane}px has zero-width text`).toEqual([])
      }
    }
  })
}

test("line numbers stay readable as their own suffix segment", async ({ page }) => {
  for (const surface of ["bubble", "composer"]) {
    for (const kind of ["token", "real"]) {
      await page.goto(`${harness.url}?w=380&s=${surface}&k=${kind}`)
      await page.waitForSelector("[data-code-comment-lines]")
      const m = await measure(page)
      expect(m.lineLabels.length, `${surface}/${kind}: one line-number segment`).toBe(1)
      const [lines] = m.lineLabels
      // 独立后缀段：文本完整、宽度为正、且没有被截断（scrollWidth 不超 clientWidth）。
      expect(lines.text, `${surface}/${kind}: line label text`).toBe(lineLabel)
      expect(lines.width, `${surface}/${kind}: line label width`).toBeGreaterThan(0)
      expect(lines.scroll, `${surface}/${kind}: line label not truncated`).toBeLessThanOrEqual(lines.client + 0.5)
    }
  }
})

test("chip text segments occupy exactly one line", async ({ page }) => {
  // 用户要求：截图里批注文本显示成两行 → 改为只显示一行。单行 = 不换行 + 省略号 + 高度不超过一行。
  for (const surface of ["bubble", "composer"]) {
    for (const kind of ["token", "real"]) {
      for (const pane of [380, 610]) {
        await page.goto(`${harness.url}?w=${pane}&s=${surface}&k=${kind}`)
        await page.waitForSelector(surface === "composer" ? "[data-slot=input-group]" : "[data-code-comment-tag]")
        const m = await measure(page)
        const textSpans = m.spans.filter(span => span.label === "text")
        expect(textSpans.length, `${surface}/${kind}/${pane}: text segments exist`).toBeGreaterThan(0)
        for (const span of textSpans) {
          expect(span.lines, `${surface}/${kind}/${pane}: line clamp must stay 1: ${span.text.slice(0, 12)}`).toBe(1)
          expect(span.whiteSpace, `${surface}/${kind}/${pane}: must not wrap: ${span.text.slice(0, 12)}`).toBe("nowrap")
          expect(span.textOverflow, `${surface}/${kind}/${pane}: must ellipsize`).toBe("ellipsis")
          // 单行高度上限：允许亚像素误差，但绝不接受两行（两行会是 ~2 * lineHeight）。
          expect(span.height, `${surface}/${kind}/${pane}: single-line height`).toBeLessThan(span.lineHeight * 1.5)
        }
      }
    }
  }
})

test("overflow assertions hold without a parent-context block", async ({ page }) => {
  // 无父块 fixture：证明气泡收束不依赖父上下文块存在（dev 上的红灯曾由父块造成）。
  for (const surface of ["bubble", "composer"]) {
    for (const pane of [380, 610]) {
      await page.goto(`${harness.url}?w=${pane}&s=${surface}&k=real&p=0`)
      await page.waitForSelector(surface === "composer" ? "[data-slot=input-group]" : "[data-code-comment-tag]")
      const m = await measure(page)
      expect(m.escaped, `${surface} without parent block at ${pane}px escapes the pane`).toEqual([])
      expect(m.zeroWidthText, `${surface} without parent block at ${pane}px zero-width text`).toEqual([])
      // 文本段确实有可见宽度（引用/批注两段都在，不是被压成 0 的残骸）。
      expect(
        m.chipTextWidths.length,
        `${surface} without parent block at ${pane}px: chip text spans`,
      ).toBeGreaterThanOrEqual(2)
      expect(
        m.chipTextWidths.filter(width => width > 0).length,
        `${surface} without parent block at ${pane}px: chip text widths`,
      ).toBe(m.chipTextWidths.length)
    }
  }
})

test("the aux parent-context chip is gone from the bubble", async ({ page }) => {
  for (const withParent of ["1", "0"]) {
    await page.goto(`${harness.url}?w=915&s=bubble&k=real&p=${withParent}`)
    await expect(page.locator("[data-code-comment-tag]")).toHaveCount(1)
    await expect(page.locator("[data-aux-parent-context]")).toHaveCount(0)
    await expect(page.getByRole("button", { name: /父会话上下文/ })).toHaveCount(0)
    // 块仍在 prompt 数据里（送模型 / 编辑重发），只是不再有 UI。
    await expect(page.getByText("总结开发板部署文档", { exact: true })).toBeVisible()
  }
})
