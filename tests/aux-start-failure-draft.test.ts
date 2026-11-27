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
  auxSelectionItems,
  clearAuxSelectionBucket,
  removeAuxSelection,
  resetAuxSelectionsForTest,
} from "@/stores/auxSelections"
import { useConversationSelectionsStore } from "@/stores/conversationSelections"

/**
 * aux 的**启动失败**路径不能把这次提交的文本弄丢（TZD-155 复验 P1）。
 *
 * 缺陷链：创建期间发送 → 等 `ready` 时进程起不来 → 实例转 `error` → 面板整块换成错误页，
 * `ChatComposer` 在同一帧卸载（`bridge` 变 `null`）→ `useChatSendControl` 里原有的
 * `bridge.value?.setTextInput(...)` 成了空操作 → 而 `useAuxDraft` 的 `initialDraft` 是
 * 面板 setup 时的一次性快照，重试重挂载后输入框仍是空的。aux 没有 session 文件，用户
 * 输入无从找回。
 *
 * 这里用**真实** composable（`useAuxDraft` / 草稿 store / 转译后的 `useChatSendControl`）
 * 跑完整链条：失败时文本落草稿，重试重挂载后输入框里是那次提交的原文。
 */
function harness(runtimeId = "aux:failed") {
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
    "@/stores/codeComments": {
      useCodeCommentsStore: () => reactive({ project: "repo", comments: [], clear: vi.fn() }),
    },
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
  // 面板的输入区：失败态卸载时整块连同 `bridge` 一起消失，所以这里用 `null` 建模。
  const bridge = ref<{ textInput: string; files: unknown[]; setTextInput: (val: string) => void } | null>({
    textInput: "",
    files: [],
    setTextInput: vi.fn(),
  })
  const onStartFailed = vi.fn()
  const ensureStarted = vi.fn(async () => false)
  let controls
  scope.run(() => {
    controls = exports.useChatSendControl({
      session,
      ui,
      workspace,
      bridge,
      project: () => "repo",
      connecting: () => false,
      editBusy: () => false,
      knownSessions: () => [],
      workspaceSelection: () => null,
      ensureStarted,
      // 与 `AuxChatPane` 的接线一致：失败且输入区已卸载时把文本存回本实例草稿。
      onStartFailed: text => {
        onStartFailed(text)
        saveDraft(runtimeId, text)
      },
      newSession: vi.fn(),
      onSent: vi.fn(),
      contexts: "aux",
    })
  })
  return { scope, controls, session, ui, bridge, onStartFailed, ensureStarted }
}

const { auxDraftFor, clearAuxDraft, saveAuxDraft } = await import("@/stores/auxDrafts")
const { useAuxDraft } = await import("@/composables/useAuxDraft")

/** 与面板的 `onStartFailed` 同一份写法（保留已挂载的附件，不覆盖）。 */
function saveDraft(runtimeId: string, text: string) {
  saveAuxDraft(runtimeId, { text, files: auxDraftFor(runtimeId).files })
}

afterEach(() => {
  resetAuxSelectionsForTest()
  setActivePinia(createPinia())
  clearAuxDraft("aux:failed")
})

test("a submit that fails after the composer unmounted keeps the text in the instance draft", async () => {
  setActivePinia(createPinia())
  const h = harness()
  try {
    // 失败发生在等待就绪期间：文本已经从输入区里被摘走（`PromptInput` 的 submitForm 行为），
    // 随后失败态把 composer 换成错误页 —— 这里建模成 `bridge` 已为 null。
    h.bridge.value = null
    await expect(h.controls.onSubmit({ text: "创建期间提交的原文" })).rejects.toThrow("completion.startFailed")
    // 原实现（只调 `bridge.value?.setTextInput`）在这里什么都不写：草稿没有、输入框也没有。
    expect(h.onStartFailed).toHaveBeenCalledWith("创建期间提交的原文")
    expect(auxDraftFor("aux:failed").text).toBe("创建期间提交的原文")
    expect(h.session.send).not.toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test("retry remounts the composer with that exact text in the input", async () => {
  // 上一条的产物：失败时存下的草稿。
  saveDraft("aux:failed", "创建期间提交的原文")
  const scope = effectScope()
  const bridge = ref<{
    textInput: string
    files: unknown[]
    setTextInput: (val: string) => void
    addFiles: (files: File[]) => void
  } | null>(null)
  // 重试后实例回到 `ready`，`ChatComposer` 重新挂载 —— 输入框的初值来自 `useAuxDraft`。
  const draft = scope.run(() => useAuxDraft("aux:failed", bridge as never))!
  // `initialDraft` 必须是**当前**草稿（旧实现是面板 setup 时的一次性快照，重挂载后为空）。
  expect(draft.initialDraft.value).toBe("创建期间提交的原文")
  // 同一面板内再次挂载输入区时，草稿文本就是重试后输入框里的原文。
  bridge.value = { textInput: "", files: [], setTextInput: vi.fn(), addFiles: vi.fn() }
  await nextTick()
  expect(draft.initialDraft.value).toBe("创建期间提交的原文")
  scope.stop()
  // 卸载时的 `persist()` 不会把这段文本弄丢（空输入不会覆盖草稿的文字）。
  expect(auxDraftFor("aux:failed").text).toBe("创建期间提交的原文")
})

test("a failed start with the composer still mounted keeps using setTextInput", async () => {
  setActivePinia(createPinia())
  const h = harness()
  try {
    // 主会话/`creating` 期间输入框还在：走原有回填，不触碰 aux 专属钩子。
    await expect(h.controls.onSubmit({ text: "还在创建中的提问" })).rejects.toThrow("completion.startFailed")
    expect(h.bridge.value?.setTextInput).toHaveBeenCalledWith("还在创建中的提问")
    expect(h.onStartFailed).not.toHaveBeenCalled()
    expect(auxDraftFor("aux:failed").text).toBe("")
  } finally {
    h.scope.stop()
  }
})
