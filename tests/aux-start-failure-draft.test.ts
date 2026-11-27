import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, reactive, ref } from "vue"
import * as vueRuntime from "vue"
import ts from "typescript"
import { createPinia, setActivePinia } from "pinia"
import { chatSource } from "./fixtures/chatSources"
import { parseSendDelay, stepSendDelayWheel } from "@/lib/sendDelay"
import { dataUrlToImage, draftFilesFromSubmit, isImageAttachment, isImageUrl } from "@/lib/attachments"
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
 * aux 的**启动失败**路径不能把这次提交的输入弄丢（TZD-155 复验 P1）。
 *
 * 缺陷链：创建期间发送 → 等 `ready` 时进程起不来 → 实例转 `error` → 面板整块换成错误页，
 * `ChatComposer` 在同一帧卸载（`bridge` 变 `null`）→ `useChatSendControl` 里原有的
 * `bridge.value?.setTextInput(...)` 成了空操作 → 而 `useAuxDraft` 的 `initialDraft` 是
 * 面板 setup 时的一次性快照，重试重挂载后输入框仍是空的。aux 没有 session 文件，用户
 * 输入（**文本与图片**）无从找回。
 *
 * 这里用**真实** composable（`useAuxDraft` / 草稿 store / 真实的 `draftFilesFromSubmit` /
 * 转译后的 `useChatSendControl`）跑完整链条：失败时文本与附件落草稿，重试重挂载后回填。
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
      // 与 `AuxChatPane` 的接线一致：失败且输入区已卸载时把**文本与附件**存回本实例草稿
      // （同一份真实实现，不是测试里另写一份）。
      onStartFailed: failed => {
        onStartFailed(failed)
        saveFailedSubmitDraft(runtimeId, failed)
      },
      newSession: vi.fn(),
      onSent: vi.fn(),
      contexts: "aux",
    })
  })
  return { scope, controls, session, ui, bridge, onStartFailed, ensureStarted }
}

const { auxDraftFor, clearAuxDraft, saveAuxDraft, saveFailedSubmitDraft } = await import("@/stores/auxDrafts")
const { useAuxDraft } = await import("@/composables/useAuxDraft")

/** 一张真的 1×1 PNG（base64 与 `dataUrlToImage` 互逆）。 */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
const pngImage = () => ({ url: `data:image/png;base64,${PNG_BASE64}`, mediaType: "image/png", filename: "dot.png" })

/** 与面板联系的真实草稿读法（附件按原始 `File` 优先）。 */
function draftFileNames(runtimeId: string) {
  return auxDraftFor(runtimeId).files.map(file => file.name)
}

afterEach(() => {
  resetAuxSelectionsForTest()
  setActivePinia(createPinia())
  clearAuxDraft("aux:failed")
})

test("a text-only submit that fails after the composer unmounted keeps the text in the instance draft", async () => {
  setActivePinia(createPinia())
  const h = harness()
  try {
    // 失败发生在等待就绪期间：文本已经从输入区里被摘走（`PromptInput` 的 submitForm 行为），
    // 随后失败态把 composer 换成错误页 —— 这里建模成 `bridge` 已为 null。
    h.bridge.value = null
    await expect(h.controls.onSubmit({ text: "创建期间提交的原文" })).rejects.toThrow("completion.startFailed")
    // 原实现（只调 `bridge.value?.setTextInput`）在这里什么都不写：草稿没有、输入框也没有。
    expect(h.onStartFailed).toHaveBeenCalledWith(expect.objectContaining({ text: "创建期间提交的原文" }))
    expect(auxDraftFor("aux:failed").text).toBe("创建期间提交的原文")
    expect(h.session.send).not.toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test("an image-only submit that fails keeps the attachment, and the retry mounts it again", async () => {
  setActivePinia(createPinia())
  const h = harness()
  try {
    // 只有图、没有字：`else if (text)` 那种守卫会让整条钩子不触发（图与文本一起丢）。
    h.bridge.value = null
    await expect(h.controls.onSubmit({ text: "", files: [pngImage()] })).rejects.toThrow("completion.startFailed")
    expect(h.onStartFailed).toHaveBeenCalledTimes(1)
    const failed = h.onStartFailed.mock.calls[0]![0] as {
      text: string
      images: { data: string; mimeType: string }[]
      files: { filename?: string }[]
    }
    expect(failed.images).toEqual([{ data: PNG_BASE64, mimeType: "image/png" }])
    // 草稿里必须有那张图（重挂载的 `addFiles` 从这里取原始 `File`）。
    expect(auxDraftFor("aux:failed").text).toBe("")
    expect(auxDraftFor("aux:failed").files).toHaveLength(1)
    expect(auxDraftFor("aux:failed").files[0]!.type).toBe("image/png")

    // Retry 后输入区重新挂载：`useAuxDraft` 把草稿里的附件放回输入框。
    const scope = effectScope()
    const bridge = ref(null)
    const addFiles = vi.fn()
    const draft = scope.run(() => useAuxDraft("aux:failed", bridge as never))!
    bridge.value = { textInput: "", files: [], setTextInput: vi.fn(), addFiles } as never
    await nextTick()
    expect(addFiles).toHaveBeenCalledTimes(1)
    const restored = addFiles.mock.calls[0]![0] as File[]
    expect(restored).toHaveLength(1)
    expect(restored[0]!.type).toBe("image/png")
    // 同一份字节：重建出来的文件与提交时的图片是同一张。
    expect(await restored[0]!.arrayBuffer()).toBeTruthy()
    expect(draft.initialDraft.value).toBe("")
    scope.stop()
  } finally {
    h.scope.stop()
  }
})

test("a submit with both text and an image keeps both and recovers both on retry", async () => {
  setActivePinia(createPinia())
  const h = harness()
  try {
    h.bridge.value = null
    await expect(h.controls.onSubmit({ text: "看图解释一下", files: [pngImage()] })).rejects.toThrow(
      "completion.startFailed",
    )
    expect(auxDraftFor("aux:failed").text).toBe("看图解释一下")
    expect(draftFileNames("aux:failed")).toHaveLength(1)

    const scope = effectScope()
    const bridge = ref(null)
    const addFiles = vi.fn()
    const draft = scope.run(() => useAuxDraft("aux:failed", bridge as never))!
    // 文本来自 `initialDraft`（输入框初值），附件由 `addFiles` 放回。
    expect(draft.initialDraft.value).toBe("看图解释一下")
    bridge.value = { textInput: "", files: [], setTextInput: vi.fn(), addFiles } as never
    await nextTick()
    expect(addFiles).toHaveBeenCalledTimes(1)
    expect((addFiles.mock.calls[0]![0] as File[]).map(file => file.type)).toEqual(["image/png"])
    scope.stop()
  } finally {
    h.scope.stop()
  }
})

test("the initial draft is read at mount time, so a draft written afterwards comes back too", async () => {
  // 顺序才是关键：面板先挂载（那一刻草稿为空）→ 提交失败才写草稿 → 输入区重新挂载。
  // `initialDraft` 若是 `ref(auxDraftFor(...).text)` 的一次性快照，这里永远是空字符串。
  const scope = effectScope()
  const bridge = ref(null)
  const draft = scope.run(() => useAuxDraft("aux:failed", bridge as never))!
  expect(draft.initialDraft.value).toBe("")

  // 失败态写草稿（`AuxChatPane` 的 `onStartFailed` 做的事）。
  saveAuxDraft("aux:failed", { text: "失败也要留住的草稿", files: [] })
  expect(draft.initialDraft.value).toBe("失败也要留住的草稿")

  // 重试回到 `ready`：输入区重新挂载，初值就是这段原文。
  bridge.value = { textInput: "", files: [], setTextInput: vi.fn(), addFiles: vi.fn() } as never
  await nextTick()
  expect(draft.initialDraft.value).toBe("失败也要留住的草稿")
  scope.stop()
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

test("the draft recovers the submitted attachments instead of re-reading the just-cleared draft", async () => {
  // 回归点：`PromptInput.submitForm` 在提交瞬间清空输入区，`useAuxDraft.persist()` 那一拍
  // 刚写过 `files: []`；从草稿里回读附件只会拿到空数组，因此接线必须用调用方给的提交件。
  const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })
  const rebuilt = draftFilesFromSubmit([{ ...pngImage(), file }], [{ data: PNG_BASE64, mimeType: "image/png" }])
  expect(rebuilt).toEqual([file])
  const fromImages = draftFilesFromSubmit([pngImage()], [{ data: PNG_BASE64, mimeType: "image/png" }])
  expect(fromImages).toHaveLength(1)
  expect(fromImages[0]!.type).toBe("image/png")

  // 真实接线：先让草稿处于"提交瞬间被清空"的状态，再让失败提交写回 —— 附件必须还在。
  saveAuxDraft("aux:failed", { text: "", files: [] })
  expect(auxDraftFor("aux:failed").files).toHaveLength(0)
  saveFailedSubmitDraft("aux:failed", {
    text: "",
    images: [{ data: PNG_BASE64, mimeType: "image/png" }],
    files: [pngImage()],
  })
  expect(auxDraftFor("aux:failed").files).toHaveLength(1)
  expect(auxDraftFor("aux:failed").files[0]!.type).toBe("image/png")
})
