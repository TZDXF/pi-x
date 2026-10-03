import { expect, test, vi } from "vitest"
import { effectScope, nextTick, reactive, ref } from "vue"
import * as vueRuntime from "vue"
import ts from "typescript"
import { chatSource } from "./fixtures/chatSources"
import { parseSendDelay, stepSendDelayWheel } from "@/lib/sendDelay"
import { dataUrlToImage, isImageUrl } from "@/lib/attachments"
import { withSessionReferences, desktopCommands } from "@/lib/completion"
import { buildPromptWithCodeComments, commentFilePath } from "@/lib/codeComments"
import { serializeComposerPromptContexts } from "@/lib/promptContexts"

// Execute the production composable with real Vue reactivity and pure helpers,
// replacing only application boundaries (RPC/config, i18n, project comments).
function harness(config = Promise.resolve({})) {
  const comments = reactive({ project: "repo", comments: [], clear: vi.fn() })
  const selections = reactive({ scope: "repo", items: [], clear: vi.fn() })
  const imports = {
    vue: vueRuntime,
    "vue-i18n": { useI18n: () => ({ t: key => key }) },
    "@/api/piClient": { getConfig: () => config },
    "@/lib/sendDelay": { parseSendDelay, stepSendDelayWheel },
    "@/lib/attachments": { dataUrlToImage, isImageUrl },
    "@/lib/completion": { withSessionReferences, desktopCommands },
    "@/lib/codeComments": { commentFilePath },
    "@/lib/promptContexts": { serializeComposerPromptContexts },
    "@/lib/runningBehavior": { runningBehavior: ref("steer") },
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
    })
  })
  return { scope, controls, session, ui, workspace, bridge, flags, comments, selection, ensureStarted, newSession }
}
const image = "data:image/png;base64,aGVsbG8="

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

test("edit, connection and git guards do not dispatch or prepare a send", async () => {
  const h = harness()
  try {
    h.flags.editing = true
    await h.controls.onSubmit({ text: "blocked" })
    h.flags.editing = false
    h.flags.connecting = true
    await h.controls.onSubmit({ text: "blocked" })
    h.flags.connecting = false
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
