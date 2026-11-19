import { expect, test, vi } from "vitest"
import { effectScope, nextTick, reactive, ref } from "vue"
import * as vueRuntime from "vue"
import ts from "typescript"
import { chatSource } from "./fixtures/chatSources"
import { parseSendDelay, stepSendDelayWheel } from "@/lib/sendDelay"
import { dataUrlToImage, isImageAttachment, isImageUrl } from "@/lib/attachments"
import { withSessionReferences, desktopCommands } from "@/lib/completion"
import { buildPromptWithCodeComments, commentFilePath } from "@/lib/codeComments"
import { appendComposerText } from "@/lib/composer"
import { serializeComposerPromptContexts } from "@/lib/promptContexts"
import { claimAuxParentContext, resetAuxParentContextForTest } from "@/stores/auxContext"

// Execute the production composable with real Vue reactivity and pure helpers,
// replacing only application boundaries (RPC/config, i18n, project comments).
function harness(config = Promise.resolve({}), extra = {}) {
  const behavior = ref("steer")
  const onSent = vi.fn()
  const comments = reactive({ project: "repo", comments: [], clear: vi.fn() })
  const selections = reactive({ scope: "repo", items: [], clear: vi.fn() })
  const imports = {
    vue: vueRuntime,
    "vue-i18n": { useI18n: () => ({ t: key => key }) },
    "@/api/piClient": { getConfig: () => config },
    "@/lib/sendDelay": { parseSendDelay, stepSendDelayWheel },
    "@/lib/attachments": { dataUrlToImage, isImageAttachment, isImageUrl },
    "@/lib/completion": { withSessionReferences, desktopCommands },
    "@/lib/codeComments": { commentFilePath },
    "@/lib/composer": { appendComposerText },
    "@/lib/promptContexts": { serializeComposerPromptContexts },
    "@/lib/runningBehavior": { runningBehavior: behavior },
    "@/stores/codeComments": { useCodeCommentsStore: () => comments },
    "@/stores/conversationSelections": { useConversationSelectionsStore: () => selections },
  }
  const code = ts.transpileModule(chatSource("composables/useChatSendControl.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  new Function("exports", "require", code)(exports, id => imports[id])
  const scope = effectScope()
  const session = reactive({
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
  const selection = { branch: "feature", worktree: false }
  const ensureStarted = vi.fn(async () => true)
  const newSession = vi.fn()
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
      workspaceSelection: () => selection,
      ensureStarted,
      newSession,
      onSent,
      ...extra,
    })
  })
  return {
    scope,
    controls,
    session,
    ui,
    workspace,
    bridge,
    flags,
    behavior,
    onSent,
    comments,
    selections,
    selection,
    ensureStarted,
    newSession,
  }
}

const parentContextBlock = (inner: string) => ["<aux_parent_context>", inner, "</aux_parent_context>"].join("\n")

/** 用真实的 `claimAuxParentContext`（模块级记账）包一层：返回值的“仅首轮”语义才是被测对象。 */
function injectedParentContext(runtimeId: string, inner: string, options: { hasUserEntry?: () => boolean } = {}) {
  return () =>
    claimAuxParentContext(runtimeId, {
      hasUserEntry: options.hasUserEntry ?? (() => false),
      collect: async () =>
        ({
          source: "entries",
          hasContext: true,
          omittedGroups: 0,
          overLimit: false,
          groupCount: 1,
          identity: "authoritative",
          inner,
          block: "",
          errors: [],
          attempts: { entries: 1, messages: 0, history: 0 },
        }) as never,
    })
}

test("aux parent context is injected only on the first turn of one aux runtime", async () => {
  // 连续三轮：首轮带块，第 2/3 轮 promptText 不含 `<aux_parent_context>`。
  resetAuxParentContextForTest()
  const h = harness(Promise.resolve({}), {
    parentContext: injectedParentContext("aux:first-turn", "父会话已提交内容"),
  })
  try {
    for (const text of ["第一轮", "第二轮", "第三轮"]) await h.controls.onSubmit({ text })
    const prompts = h.session.send.mock.calls.map(call => call[2])
    expect(prompts[0].startsWith(parentContextBlock("父会话已提交内容"))).toBe(true)
    expect(prompts[0]).toContain("第一轮")
    expect(prompts[1]).not.toContain("<aux_parent_context>")
    expect(prompts[2]).not.toContain("<aux_parent_context>")
    // 另一个 aux 实例有自己的记账：它的首轮仍然带块。
    const other = harness(Promise.resolve({}), {
      parentContext: injectedParentContext("aux:second-runtime", "另一份父上下文"),
    })
    try {
      await other.controls.onSubmit({ text: "另一个实例的首轮" })
      expect(other.session.send.mock.calls[0][2].startsWith(parentContextBlock("另一份父上下文"))).toBe(true)
    } finally {
      other.scope.stop()
    }
    // 已有 user 条目（重载/竞态）时永不再拼块，即便记账被清。
    resetAuxParentContextForTest()
    const reloaded = harness(Promise.resolve({}), {
      parentContext: injectedParentContext("aux:reloaded", "不该出现的父上下文", { hasUserEntry: () => true }),
    })
    try {
      await reloaded.controls.onSubmit({ text: "已有历史" })
      expect(reloaded.session.send.mock.calls[0][2]).toBe("已有历史")
    } finally {
      reloaded.scope.stop()
    }
    // 主会话不传 parentContext：promptText 保持原样（行为不变）。
    const main = harness()
    try {
      await main.controls.onSubmit({ text: "主会话提问" })
      expect(main.session.send.mock.calls[0][2]).toBe("主会话提问")
    } finally {
      main.scope.stop()
    }
  } finally {
    h.scope.stop()
  }
})

test("FAIL_concurrent_submit_*: 并发首轮等领头采集，先发者先落地且块在它身上", async () => {
  // 同一 aux 的两次首轮提交：第二次必须**等**第一次采集完成再发，否则对话区第一条
  // 是没有父上下文的（块随后才到）。断言两件事：顺序（发送调用次序 = 提交次序）与
  // 归属（块只在第一次那一条上）。
  resetAuxParentContextForTest()
  let release,
    collected = 0
  const gate = new Promise(resolve => {
    release = resolve
  })
  const h = harness(Promise.resolve({}), {
    parentContext: () =>
      claimAuxParentContext("aux:concurrent", {
        hasUserEntry: () => false,
        collect: async () => {
          collected++
          await gate
          return {
            source: "entries",
            hasContext: true,
            omittedGroups: 0,
            overLimit: false,
            groupCount: 1,
            identity: "authoritative",
            inner: "并发父上下文",
            block: "",
            errors: [],
            attempts: { entries: 1, messages: 0, history: 0 },
          } as never
        },
      }),
  })
  try {
    const first = h.controls.onSubmit({ text: "先发者" })
    // 让第一次提交先进入采集（等待闸门），再发起第二次。
    await Promise.resolve()
    const second = h.controls.onSubmit({ text: "后发者" })
    await Promise.resolve()
    // 采集还没放行：第二次提交**不能**先发出去。
    expect(h.session.send).toHaveBeenCalledTimes(0)
    release()
    await Promise.all([first, second])
    const prompts = h.session.send.mock.calls.map(call => [call[0], call[2]])
    expect(prompts.map(row => row[0])).toEqual(["先发者", "后发者"])
    // 先发者带块，后发者不带（同一段父上下文只进一次）。
    expect(prompts[0][1]).toContain("<aux_parent_context>")
    expect(prompts[0][1]).toContain("并发父上下文")
    expect(prompts[1][1]).toBe("后发者")
    // 并发只采集一次（不是各拼一份）。
    expect(collected).toBe(1)
  } finally {
    h.scope.stop()
  }
})

test("a failing parent-context read never blocks the send and says so", async () => {
  const h = harness(Promise.resolve({}), {
    parentContext: async () => {
      throw new Error("collect failed")
    },
  })
  try {
    await h.controls.onSubmit({ text: "仍然要发出去" })
    expect(h.session.send).toHaveBeenCalledOnce()
    expect(h.session.send.mock.calls[0][2]).toBe("仍然要发出去")
    // 降级必须**如实**：先发者不会“无声无块”，至少有一条 warning 说明原因。
    expect(h.ui.pushToast).toHaveBeenCalledWith("chat.parentContextFailed", "warning")
  } finally {
    h.scope.stop()
  }
})
const image = "data:image/png;base64,aGVsbG8="

test.each(["", "Keep this draft"])("rejects non-image attachments without consuming text or files", async text => {
  const h = harness()
  const file = { url: "data:text/plain;base64,bm90ZXM=", mediaType: "text/plain", filename: "notes.txt" }
  h.bridge.value.textInput = text
  h.bridge.value.files = [{ id: "notes", ...file }]
  try {
    await expect(h.controls.onSubmit({ text, files: [file] })).rejects.toThrow("chat.imageAttachmentsOnly")
    expect(h.ui.pushToast).toHaveBeenCalledExactlyOnceWith("chat.imageAttachmentsOnly", "error")
    expect(h.session.send).not.toHaveBeenCalled()
    expect(h.session.schedulePrompt).not.toHaveBeenCalled()
    expect(h.ensureStarted).not.toHaveBeenCalled()
    expect(h.bridge.value.textInput).toBe(text)
    expect(h.bridge.value.files).toEqual([{ id: "notes", ...file }])
  } finally {
    h.scope.stop()
  }
})

test("sending scrolls back to the bottom; queued and delayed sends keep the reading position", async () => {
  const h = harness()
  try {
    await h.controls.onSubmit({ text: "hello" })
    expect(h.session.send).toHaveBeenCalledOnce()
    expect(h.onSent).toHaveBeenCalledOnce()

    // 运行中且偏好本地排队：消息不进对话流，不打断当前阅读位置
    h.onSent.mockClear()
    h.session.isStreaming = true
    h.behavior.value = "queue"
    await h.controls.onSubmit({ text: "queued" })
    expect(h.session.send).toHaveBeenCalledTimes(2)
    expect(h.onSent).not.toHaveBeenCalled()

    // steer 行为下消息进入对话流，回底展示新问题
    h.behavior.value = "steer"
    await h.controls.onSubmit({ text: "steered" })
    expect(h.session.send).toHaveBeenCalledTimes(3)
    expect(h.onSent).toHaveBeenCalledOnce()

    // 延迟发送进本地队列，不回底
    h.onSent.mockClear()
    h.controls.delayedSend.value = true
    h.controls.sendDelayMinutes.value = 0
    h.controls.sendDelaySeconds.value = 5
    await h.controls.onSubmit({ text: "later" })
    expect(h.session.schedulePrompt).toHaveBeenCalledWith("later", 5000, undefined, "later")
    expect(h.onSent).not.toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test.each([
  { streaming: false, behavior: "queue" },
  { streaming: false, behavior: "steer" },
  { streaming: true, behavior: "queue" },
  { streaming: true, behavior: "steer" },
])("compacting keeps the reading position for $behavior with streaming=$streaming", async ({ streaming, behavior }) => {
  const h = harness()
  try {
    h.session.isCompacting = true
    h.session.isStreaming = streaming
    h.behavior.value = behavior
    await h.controls.onSubmit({ text: "next", files: [{ url: image }] })
    expect(h.session.send).toHaveBeenCalledWith("next", [{ data: "aGVsbG8=", mimeType: "image/png" }], "next", behavior)
    expect(h.onSent).not.toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test("send controls and extension editor text stay in their owning split pane", async () => {
  const left = harness()
  const right = harness()
  try {
    left.session.isStreaming = right.session.isStreaming = true
    expect(left.controls.showStopButton.value).toBe(true)
    right.bridge.value.textInput = "draft"
    expect(right.controls.showStopButton.value).toBe(false)
    left.controls.delayedSend.value = true
    expect(right.controls.delayedSend.value).toBe(false)
    left.ui.pendingEditorText = "plugin text"
    await nextTick()
    expect(left.bridge.value.setTextInput).toHaveBeenCalledWith("plugin text")
    expect(right.bridge.value.setTextInput).not.toHaveBeenCalled()
    await right.controls.abort()
    expect(right.bridge.value.setTextInput).toHaveBeenCalledWith("restored draft")
    expect(left.session.abortAndRestore).not.toHaveBeenCalled()
    await right.controls.onSubmit({ text: "send right", files: [{ url: image }] })
    expect(right.session.send).toHaveBeenCalledWith(
      "send right",
      [{ data: "aGVsbG8=", mimeType: "image/png" }],
      "send right",
      "steer",
    )
    expect(left.session.send).not.toHaveBeenCalled()
  } finally {
    left.scope.stop()
    right.scope.stop()
  }
})

test("preparation failure restores text without consuming attachments or comments", async () => {
  const h = harness()
  try {
    h.bridge.value.files.push({ id: "pending", url: image })
    h.ensureStarted.mockResolvedValue(false)
    await expect(h.controls.onSubmit({ text: "  draft  ", files: [{ url: image }] })).rejects.toThrow(
      "completion.startFailed",
    )
    expect(h.ensureStarted).toHaveBeenCalledWith(h.selection)
    expect(h.bridge.value.setTextInput).toHaveBeenCalledWith("draft")
    expect(h.bridge.value.files).toHaveLength(1)
    expect(h.comments.clear).not.toHaveBeenCalled()
    expect(h.session.send).not.toHaveBeenCalled()
    h.session.entries.push({ kind: "user", id: 1, text: "earlier" })
    h.ensureStarted.mockResolvedValue(true)
    await h.controls.onSubmit({ text: "next" })
    expect(h.ensureStarted).toHaveBeenLastCalledWith(null)
  } finally {
    h.scope.stop()
  }
})

test("delayed sending validates before startup and preserves extension commands and annotations", async () => {
  const h = harness()
  try {
    h.controls.delayedSend.value = true
    h.controls.sendDelayMinutes.value = 0
    h.controls.sendDelaySeconds.value = 0
    await expect(h.controls.onSubmit({ text: "draft" })).rejects.toThrow("chat.invalidSendDelay")
    expect(h.ensureStarted).not.toHaveBeenCalled()
    expect(h.controls.delayedSend.value).toBe(true)
    h.controls.sendDelaySeconds.value = 5
    h.session.commands.push({ name: "delegate", source: "extension" })
    h.comments.comments.push({
      id: "c",
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      comment: "check this",
      selectedText: "x",
    })
    await h.controls.onSubmit({ text: "/delegate task", files: [{ url: image }] })
    expect(h.session.schedulePrompt).toHaveBeenCalledWith(
      "/delegate task",
      5000,
      [{ data: "aGVsbG8=", mimeType: "image/png" }],
      buildPromptWithCodeComments("/delegate task", h.comments.comments),
    )
    expect(h.session.send).not.toHaveBeenCalled()
    expect(h.comments.clear).toHaveBeenCalledOnce()
    expect(h.controls.delayedSend.value).toBe(false)
  } finally {
    h.scope.stop()
  }
})

test("code comments anchored outside the session folder are addressed with their root path", async () => {
  const h = harness()
  try {
    h.comments.comments.push(
      {
        id: "local",
        path: "src/in-session.ts",
        startLine: 1,
        endLine: 2,
        comment: "same folder",
        selectedText: "a",
      },
      {
        id: "cross",
        path: "src/other.ts",
        root: "C:\\code\\repo-b\\",
        startLine: 3,
        endLine: 4,
        comment: "other folder",
        selectedText: "b",
      },
    )
    await h.controls.onSubmit({ text: "review please" })
    const prompt = h.session.send.mock.calls[0][2]
    expect(prompt).toContain("File: src/in-session.ts")
    expect(prompt).toContain("File: C:/code/repo-b/src/other.ts")
  } finally {
    h.scope.stop()
  }
})

test("desktop slash commands reject scheduling but compact remains queued while running", async () => {
  const h = harness()
  try {
    h.controls.delayedSend.value = true
    await expect(h.controls.onSubmit({ text: "/new" })).rejects.toThrow("chat.delayedCommandUnsupported")
    expect(h.newSession).not.toHaveBeenCalled()
    h.controls.delayedSend.value = false
    h.session.isStreaming = true
    await h.controls.onSubmit({ text: "/compact brief" })
    expect(h.session.send).toHaveBeenCalledWith("/compact brief", undefined, undefined, "steer")
    expect(h.session.abortAndRestore).not.toHaveBeenCalled()
    await h.controls.onSubmit({ text: "/new" })
    expect(h.newSession).toHaveBeenCalledOnce()
  } finally {
    h.scope.stop()
  }
})

test.each(["/szls", "/szls 这只是消息开头", "/some/path 请检查这个路径"])(
  "unknown slash prefix is sent as ordinary text: %s",
  async text => {
    const h = harness()
    try {
      await h.controls.onSubmit({ text, files: [{ url: image }] })
      expect(h.session.send).toHaveBeenCalledWith(text, [{ data: "aGVsbG8=", mimeType: "image/png" }], text, "steer")
      expect(h.ui.pushToast).not.toHaveBeenCalled()
      expect(h.ui.pendingUserMessage).toBeNull()

      h.controls.delayedSend.value = true
      await h.controls.onSubmit({ text })
      expect(h.session.schedulePrompt).toHaveBeenCalledWith(text, 600000, undefined, text)
      expect(h.ui.pushToast).not.toHaveBeenCalled()
    } finally {
      h.scope.stop()
    }
  },
)

test("edit and git guards do not dispatch or prepare a send", async () => {
  const h = harness()
  try {
    h.flags.editing = true
    await h.controls.onSubmit({ text: "blocked" })
    h.flags.editing = false
    h.workspace.gitBusy = true
    await h.controls.onSubmit({ text: "blocked" })
    expect(h.ensureStarted).not.toHaveBeenCalled()
    expect(h.session.send).not.toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test("disabling built-in delayed send resets its controls without affecting another pane", async () => {
  const off = harness(Promise.resolve({ builtinDelayedSend: false }))
  const on = harness()
  try {
    off.controls.delayedSend.value = true
    await Promise.resolve()
    expect(off.controls.delayedSendEnabled.value).toBe(false)
    expect(off.controls.delayedSend.value).toBe(false)
    expect(on.controls.delayedSendEnabled.value).toBe(true)
  } finally {
    off.scope.stop()
    on.scope.stop()
  }
})

test("first message in a fresh conversation is echoed while the worker starts", async () => {
  let release
  const gate = new Promise(r => {
    release = r
  })
  const h = harness()
  h.ensureStarted.mockReturnValue(gate)
  try {
    const sending = h.controls.onSubmit({ text: "hello", files: [{ url: image }] })
    await new Promise(r => setImmediate(r))
    expect(h.ui.pendingUserMessage).toEqual({ text: "hello", images: [{ url: image }] })
    expect(h.session.send).not.toHaveBeenCalled()
    release(true)
    await sending
    expect(h.ui.pendingUserMessage).toBeNull()
    expect(h.session.send).toHaveBeenCalledWith(
      "hello",
      [{ data: "aGVsbG8=", mimeType: "image/png" }],
      "hello",
      "steer",
    )
  } finally {
    h.scope.stop()
  }
})

test("startup failure removes the echo and restores the composer text", async () => {
  const h = harness()
  h.ensureStarted.mockResolvedValue(false)
  try {
    await expect(h.controls.onSubmit({ text: "draft" })).rejects.toThrow("completion.startFailed")
    expect(h.ui.pendingUserMessage).toBeNull()
    expect(h.bridge.value.setTextInput).toHaveBeenCalledWith("draft")
    expect(h.session.send).not.toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test("startup failure restores the submitted draft before text inserted while waiting", async () => {
  const h = harness()
  const inserted = "## Comment 1\nFile: src/a.ts\nComment: keep this"
  h.ensureStarted.mockImplementation(async () => {
    // 模拟等待启动时从文件预览引入批注：输入框已有新内容，不能再被旧草稿覆盖。
    h.bridge.value.textInput = inserted
    return false
  })
  try {
    await expect(h.controls.onSubmit({ text: "original draft" })).rejects.toThrow("completion.startFailed")
    expect(h.bridge.value.setTextInput).toHaveBeenCalledExactlyOnceWith(`original draft\n\n${inserted}`)
    expect(h.session.send).not.toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test("desktop commands do not echo into the conversation area", async () => {
  const h = harness()
  try {
    await h.controls.onSubmit({ text: "/new" })
    expect(h.ui.pendingUserMessage).toBeUndefined()
    expect(h.newSession).toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test.each([
  { failure: "startup false", text: "draft", error: "completion.startFailed", restoreText: true },
  { failure: "startup throw", text: "draft", error: "worker failed", restoreText: false },
  { failure: "command refresh", text: "/known", error: "refresh failed", restoreText: false },
])(
  "$failure clears the first-message echo without consuming pending contexts",
  async ({ failure, text, error, restoreText }) => {
    const h = harness()
    try {
      const file = { id: "pending", url: image }
      h.bridge.value.files.push(file)
      h.comments.comments.push({
        id: "comment",
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        comment: "keep",
        selectedText: "x",
      })
      h.selections.items.push({ id: "selection", text: "keep selection" })
      h.ensureStarted.mockImplementation(async () => {
        expect(h.ui.pendingUserMessage).toEqual({ text, images: [{ url: image }] })
        if (failure === "startup throw") throw new Error(error)
        return failure !== "startup false"
      })
      if (failure === "command refresh") {
        h.session.commands.push({ name: "known", source: "extension" })
        h.session.refreshCommands.mockImplementation(async () => {
          expect(h.ui.pendingUserMessage).toEqual({ text, images: [{ url: image }] })
          throw new Error(error)
        })
      }
      await expect(h.controls.onSubmit({ text: `  ${text}  `, files: [{ url: image }] })).rejects.toThrow(error)
      expect(h.ui.pendingUserMessage).toBeNull()
      expect(h.ensureStarted).toHaveBeenCalledWith(h.selection)
      expect(h.session.refreshCommands).toHaveBeenCalledTimes(text.startsWith("/") ? 1 : 0)
      expect(h.session.send).not.toHaveBeenCalled()
      expect(h.session.schedulePrompt).not.toHaveBeenCalled()
      expect(h.bridge.value.files).toEqual([file])
      expect(h.comments.comments).toHaveLength(1)
      expect(h.selections.items).toHaveLength(1)
      expect(h.comments.clear).not.toHaveBeenCalled()
      expect(h.selections.clear).not.toHaveBeenCalled()
      if (restoreText) expect(h.bridge.value.setTextInput).toHaveBeenCalledWith(text)
      else expect(h.bridge.value.setTextInput).not.toHaveBeenCalled()
    } finally {
      h.scope.stop()
    }
  },
)

test("send failure also clears the first-message echo", async () => {
  const h = harness()
  try {
    h.session.send.mockImplementation(async () => {
      expect(h.ui.pendingUserMessage).toEqual({ text: "draft", images: [] })
      throw new Error("send failed")
    })
    await expect(h.controls.onSubmit({ text: "draft" })).rejects.toThrow("send failed")
    expect(h.ui.pendingUserMessage).toBeNull()
  } finally {
    h.scope.stop()
  }
})

test("unsupported picker or drop files show the same localized image-only error", () => {
  const h = harness()
  try {
    h.controls.onInputError({ code: "accept" })
    expect(h.ui.pushToast).toHaveBeenCalledExactlyOnceWith("chat.imageAttachmentsOnly", "error")
  } finally {
    h.scope.stop()
  }
})

test("attachment read failures show a localized error without duplicating other submit errors", () => {
  const h = harness()
  try {
    h.controls.onInputError({ code: "attachment_read_error" })
    expect(h.ui.pushToast).toHaveBeenCalledExactlyOnceWith("chat.attachmentReadFailed", "error")
    h.controls.onInputError({ code: "submit_error" })
    expect(h.ui.pushToast).toHaveBeenCalledOnce()
  } finally {
    h.scope.stop()
  }
})

test("submitting during navigation waits for the connection instead of dropping the message", async () => {
  const h = harness()
  try {
    h.flags.connecting = true
    const sending = h.controls.onSubmit({ text: "during switch" })
    expect(h.ensureStarted).not.toHaveBeenCalled()
    h.flags.connecting = false
    await sending
    expect(h.session.send).toHaveBeenCalledWith("during switch", undefined, "during switch", "steer")
  } finally {
    h.scope.stop()
  }
})

test("unmounting cancels a submit waiting for navigation", async () => {
  const h = harness()
  h.flags.connecting = true
  const sending = h.controls.onSubmit({ text: "cancelled" })
  h.scope.stop()
  await sending
  expect(h.ensureStarted).not.toHaveBeenCalled()
  expect(h.session.send).not.toHaveBeenCalled()
})

test("navigation does not disable the editor or submit button", () => {
  const composer = chatSource("components/chat/ChatComposer.vue")
  expect(composer).not.toContain(':disabled="editBusy || gitBusy ||')
  expect(composer.match(/:disabled="editBusy \|\| gitBusy"/g)).toHaveLength(2)
})
