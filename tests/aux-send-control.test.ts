import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, reactive, ref } from "vue"
import * as vueRuntime from "vue"
import ts from "typescript"
import { createPinia, setActivePinia } from "pinia"
import { chatSource } from "./fixtures/chatSources"
import { parseSendDelay, stepSendDelayWheel } from "@/lib/sendDelay"
import { dataUrlToImage, isImageAttachment, isImageUrl } from "@/lib/attachments"
import { withSessionReferences, desktopCommands } from "@/lib/completion"
import { commentFilePath } from "@/lib/codeComments"
import { serializeComposerPromptContexts } from "@/lib/promptContexts"
import {
  addAuxSelection,
  auxSelectionCount,
  auxSelectionItems,
  clearAuxSelectionBucket,
  removeAuxSelection,
  resetAuxSelectionsForTest,
} from "@/stores/auxSelections"
import { useConversationSelectionsStore } from "@/stores/conversationSelections"

/**
 * `useChatSendControl` 的 aux 分支（TZD-103）：**只打包自己的桶**、发送后只清本桶、
 * abort 不清、代码批注一律不消费。
 *
 * 用真实 Vue 响应式执行生产 composable，只替换应用边界（RPC/config/i18n/store 句柄），
 * 与 `chat-send-control.test.ts` 同一套做法；引用桶用**真实实现**，主会话单例也用真实
 * Pinia store —— 这样"互不消费"才是被验证的行为，而不是被替身假装出来的。
 */
function harness(contexts: "shared" | "aux" | "none", runtimeId = "aux:one") {
  const onSent = vi.fn()
  const comments = reactive({ project: "repo", comments: [], clear: vi.fn() })
  const imports = {
    vue: vueRuntime,
    "vue-i18n": { useI18n: () => ({ t: key => key }) },
    "@/api/piClient": { getConfig: () => Promise.resolve({}) },
    "@/lib/sendDelay": { parseSendDelay, stepSendDelayWheel },
    "@/lib/attachments": { dataUrlToImage, isImageAttachment, isImageUrl },
    "@/lib/completion": { withSessionReferences, desktopCommands },
    "@/lib/codeComments": { commentFilePath },
    "@/lib/promptContexts": { serializeComposerPromptContexts },
    "@/lib/runningBehavior": { runningBehavior: reactive({ value: "steer" }).value },
    "@/stores/auxSelections": { addAuxSelection, auxSelectionItems, clearAuxSelectionBucket, removeAuxSelection },
    "@/stores/codeComments": { useCodeCommentsStore: () => comments },
    "@/stores/conversationSelections": { useConversationSelectionsStore: () => useConversationSelectionsStore() },
  }
  const code = ts.transpileModule(chatSource("composables/useChatSendControl.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  new Function("exports", "require", code)(exports, id => imports[id])
  const scope = effectScope()
  const session = reactive({
    runtimeId,
    sessionFile: "session-1",
    entries: [],
    commands: [],
    isStreaming: false,
    isCompacting: false,
    dispositionNotice: null,
    refreshCommands: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    schedulePrompt: vi.fn(),
    abortAndRestore: vi.fn(async () => "restored draft"),
  })
  const ui = reactive({ pendingEditorText: null, pushToast: vi.fn() })
  const workspace = reactive({ gitBusy: false })
  const bridge = ref({ textInput: "", files: [], setTextInput: vi.fn() })
  const flags = reactive({ connecting: false, editing: false, project: "repo" })
  let controls
  scope.run(() => {
    controls = exports.useChatSendControl({
      session,
      ui,
      workspace,
      bridge,
      project: () => flags.project,
      connecting: () => flags.connecting,
      editBusy: () => flags.editing,
      knownSessions: () => [],
      workspaceSelection: () => null,
      ensureStarted: async () => true,
      newSession: vi.fn(),
      onSent,
      contexts,
    })
  })
  return { scope, controls, session, ui, comments, onSent, bridge }
}

afterEach(() => {
  resetAuxSelectionsForTest()
  setActivePinia(createPinia())
})

test("aux sends only its own bucket and serializes it as a userselect block", async () => {
  setActivePinia(createPinia())
  addAuxSelection("aux:one", { text: "选中的回复", source: "assistant", messageId: 3, startOffset: 0, endOffset: 5 })
  const main = useConversationSelectionsStore()
  main.add("session-1", { text: "主会话的引用", source: "user", messageId: 1, startOffset: 0, endOffset: 6 })
  const h = harness("aux")
  try {
    expect(h.controls.pendingSelections.value.map(item => item.text)).toEqual(["选中的回复"])
    await h.controls.onSubmit({ text: "解释这段" })
    const prompt = h.session.send.mock.calls[0]![2] as string
    expect(prompt).toContain("解释这段")
    expect(prompt).toContain("# userselect:")
    expect(prompt).toContain("选中的回复")
    // 主会话的引用绝不随 aux 发出。
    expect(prompt).not.toContain("主会话的引用")
    // 发送后只清本桶。
    expect(auxSelectionCount("aux:one")).toBe(0)
    expect(main.items.map(item => item.text)).toEqual(["主会话的引用"])
  } finally {
    h.scope.stop()
  }
})

test("main session sends the shared singleton and leaves the aux bucket untouched", async () => {
  setActivePinia(createPinia())
  addAuxSelection("aux:one", { text: "aux 的引用" })
  const main = useConversationSelectionsStore()
  main.add("session-1", { text: "主会话的引用", source: "user", messageId: 1, startOffset: 0, endOffset: 6 })
  const h = harness("shared")
  try {
    await h.controls.onSubmit({ text: "继续" })
    const prompt = h.session.send.mock.calls[0]![2] as string
    expect(prompt).toContain("主会话的引用")
    expect(prompt).not.toContain("aux 的引用")
    expect(main.items).toHaveLength(0)
    expect(auxSelectionCount("aux:one")).toBe(1)
  } finally {
    h.scope.stop()
  }
})

test("aux never consumes project-level code comments", async () => {
  const h = harness("aux")
  try {
    h.comments.comments.push({
      id: "c",
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      comment: "检查这里",
      selectedText: "x",
    })
    addAuxSelection("aux:one", { text: "引用" })
    await h.controls.onSubmit({ text: "看下" })
    const prompt = h.session.send.mock.calls[0]![2] as string
    expect(prompt).toContain("# userselect:")
    expect(prompt).not.toContain("# Code comments:")
    expect(h.comments.clear).not.toHaveBeenCalled()
    // 摘要里也不该出现代码批注。
    expect(h.controls.pendingComments.value).toEqual([])
  } finally {
    h.scope.stop()
  }
})

test("abort keeps the aux bucket (the draft can be restored with Esc)", async () => {
  addAuxSelection("aux:one", { text: "引用" })
  const h = harness("aux")
  try {
    await h.controls.abort()
    expect(h.bridge.value.setTextInput).toHaveBeenCalledWith("restored draft")
    expect(auxSelectionCount("aux:one")).toBe(1)
  } finally {
    h.scope.stop()
  }
})

test("delayed sending also clears only the aux bucket", async () => {
  addAuxSelection("aux:one", { text: "引用" })
  const h = harness("aux")
  try {
    h.controls.delayedSend.value = true
    h.controls.sendDelayMinutes.value = 0
    h.controls.sendDelaySeconds.value = 5
    await h.controls.onSubmit({ text: "稍后" })
    const prompt = h.session.schedulePrompt.mock.calls[0]![3] as string
    expect(prompt).toContain("# userselect:")
    expect(auxSelectionCount("aux:one")).toBe(0)
    await nextTick()
  } finally {
    h.scope.stop()
  }
})

test("a failed send consumes the bucket exactly like the main session does", async () => {
  // 与主会话**同源**的 clear 时机：清空发生在 `session.send` 之前（既有实现如此，
  // TZD-103 不另立一套时机）。这里把两边都跑一遍，钉住"aux 没有偷偷改成失败保留"。
  setActivePinia(createPinia())
  addAuxSelection("aux:one", { text: "引用" })
  const main = useConversationSelectionsStore()
  main.add("session-1", { text: "主会话的引用", source: "user", messageId: 1, startOffset: 0, endOffset: 6 })

  const aux = harness("aux")
  const shared = harness("shared")
  try {
    for (const h of [aux, shared]) {
      h.session.send.mockImplementation(async () => {
        throw new Error("send failed")
      })
      await expect(h.controls.onSubmit({ text: "发不出去" })).rejects.toThrow("send failed")
    }
    expect(auxSelectionCount("aux:one")).toBe(0)
    expect(main.items).toHaveLength(0)
  } finally {
    aux.scope.stop()
    shared.scope.stop()
  }
})

test("isolated contexts read neither bucket and clear nothing", async () => {
  setActivePinia(createPinia())
  addAuxSelection("aux:one", { text: "aux 的引用" })
  const main = useConversationSelectionsStore()
  main.add("session-1", { text: "主会话的引用", source: "user", messageId: 1, startOffset: 0, endOffset: 6 })
  const h = harness("none")
  try {
    expect(h.controls.pendingSelections.value).toEqual([])
    await h.controls.onSubmit({ text: "x" })
    expect(h.session.send.mock.calls[0]![2]).toBe("x")
    expect(auxSelectionCount("aux:one")).toBe(1)
    expect(main.items).toHaveLength(1)
  } finally {
    h.scope.stop()
  }
})

test("the composer summary removes entries through the owner-aware handle", () => {
  const composer = chatSource("components/chat/ChatComposer.vue")
  const control = chatSource("composables/useChatSendControl.ts")
  // aux 的删除必须走桶操作：继续用 `conversationSelections.remove` 会删错桶。
  expect(composer).toMatch(/@remove="selections\.remove\(\$event\)"/)
  expect(control).toMatch(/if \(auxScoped\) removeAuxSelection\(session\.runtimeId, id\)/)
})
