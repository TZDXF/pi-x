import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-119 回归：批注/上下文卡片内的超长文本必须在卡片内截断/换行，不得横向溢出。
 *
 * 单测只能钉住 class 契约；"是否真的没顶出容器"只有布局能回答，因此这里渲染真实的
 * `ChatUserPrompt` / `ChatComposer`，在辅助对话面板那种几百像素宽的容器里逐层量矩形。
 */
const longToken = "X".repeat(400)
const longCjk = "开发板部署是手工同步的".repeat(30)
const longPath = "src/" + "deep_folder_with_long_name/".repeat(10) + "file.rs"
const realPath = "service/docs/AI_SERVER_DEPLOY.md"
const realComment =
  "开发板部署是手工 tar 同步的 app/ + web/dist，建议之后把开发板部署流程也写进 service/docs/AI_SERVER_DEPLOY.md，并把 build 产物目录与 tar 包命名规范一并补齐，避免每次口头传达。"

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
const text = kind === 'token' ? token : kind === 'cjk' ? cjk : kind === 'path' ? longPath : realComment
const path = kind === 'real' ? realPath : text + ':' + longPath
const comment = kind === 'real' ? realComment : text + cjk
const comments = [{ path, startLine: 120, endLine: 132, selectedText: '', comment }]
const selections = [{ id: 's1', text: comment, comment: path }]
// 折叠块的父上下文也放进 prompt：TZD-119 之后气泡不该再为它渲染任何 UI。
const prompt = serializeComposerPromptContexts('总结开发板部署文档', { comments, selections, parentContext: comment })
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

for (const surface of ["bubble", "composer"]) {
  test(`${surface} keeps long-text cards inside a narrow aux pane`, async ({ page }) => {
    // token：完全无断行机会的长串；real：截图里的真实中英混排路径 + 批注。
    for (const kind of ["token", "real"]) {
      for (const pane of [380, 610]) {
        await page.goto(`${harness.url}?w=${pane}&s=${surface}&k=${kind}`)
        await page.waitForSelector(surface === "composer" ? "[data-slot=input-group]" : "[data-code-comment-tag]")
        // 逐层量矩形：任何元素越过面板左右边界都算"横向溢出被裁切"。
        const escaped = await page.evaluate(() => {
          const pane = document.querySelector("#pane")!.getBoundingClientRect()
          const out: string[] = []
          for (const el of document.querySelector("#pane")!.querySelectorAll("*")) {
            const rect = el.getBoundingClientRect()
            if (!rect.width || !rect.height || el.closest("svg")) continue
            if (rect.right > pane.right + 0.5 || rect.left < pane.left - 0.5)
              out.push(`${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`)
          }
          return out
        })
        expect(escaped, `${surface}/${kind} at ${pane}px`).toEqual([])
      }
    }
  })
}

test("the aux parent-context chip is gone from the bubble", async ({ page }) => {
  await page.goto(`${harness.url}?w=915&s=bubble&k=real`)
  await expect(page.locator("[data-code-comment-tag]")).toHaveCount(1)
  await expect(page.locator("[data-aux-parent-context]")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /父会话上下文/ })).toHaveCount(0)
  // 块仍在 prompt 数据里（送模型 / 编辑重发），只是不再有 UI。
  await expect(page.getByText("总结开发板部署文档", { exact: true })).toBeVisible()
})
