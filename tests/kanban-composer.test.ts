import { afterEach, expect, test, vi } from "vitest"
import { nextTick, reactive, ref } from "vue"
import { boardDraftFiles, serializeBoardAttachments } from "@/lib/boardDraftAttachments"
import { useBoardComposerDraft } from "@/composables/useBoardComposerDraft"
import { useComposerDraftSync } from "@/composables/useComposerDraftSync"
import { mountBrowserComposable } from "./browserTestHarness"
import type { SessionStore } from "@/stores/session"
import type { useWorkspaceStore } from "@/stores/workspace"
import type { BoardDraft } from "@/lib/workspaceState"

const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach(dispose => dispose())
  vi.useRealTimers()
})

test("board attachments preserve image and document bytes without retaining preview URLs", async () => {
  const files = [
    new File(["hello"], "photo.png", { type: "image/png" }),
    new File(["你好"], "notes.txt", { type: "text/plain" }),
  ]
  const saved = await serializeBoardAttachments(files.map(file => ({ file, url: "blob:expires-with-editor" })))
  expect(saved[0]).toEqual({ filename: "photo.png", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8=" })
  const restored = boardDraftFiles(JSON.parse(JSON.stringify(saved)))
  expect(await Promise.all(restored.map(file => file.text()))).toEqual(["hello", "你好"])
  expect(restored.map(file => [file.name, file.type])).toEqual([
    ["photo.png", "image/png"],
    ["notes.txt", "text/plain"],
  ])
  expect(await serializeBoardAttachments(saved)).toEqual(saved)
  await expect(serializeBoardAttachments([{ url: "blob:missing-original" }])).rejects.toThrow()
})

function mountDraft(attachments: BoardDraft["attachments"], initialSelection?: BoardDraft["selection"]) {
  const draft: BoardDraft = {
    id: "composer-options",
    project: "/composer-options",
    message: "Task",
    createdAt: 1,
    updatedAt: 1,
    attachments,
    selection: initialSelection,
  }
  const session = reactive({
    runtimeId: draft.id,
    cwd: draft.project,
    sessionFile: null,
    isStreaming: false,
    entries: [],
    desiredModelKey: "test/reasoner",
    desiredThinkingLevel: "high",
    thinkingLevel: "off",
  })
  const workspace = reactive({
    boardDrafts: { [draft.id]: draft },
    upsertBoardDraft: vi.fn((next: BoardDraft) => {
      workspace.boardDrafts[next.id] = next
    }),
  })
  const selection = ref(initialSelection ?? null)
  const bridge = ref<{
    textInput: string
    files: { file: File }[]
    isLoading: boolean
    setTextInput(text: string): void
    addFiles(files: File[]): void
  } | null>(null)
  const mounted = mountBrowserComposable(() => {
    const options = useBoardComposerDraft(
      session as unknown as SessionStore,
      workspace as unknown as ReturnType<typeof useWorkspaceStore>,
      bridge,
      selection,
    )
    useComposerDraftSync(session as unknown as SessionStore, () => draft.project, bridge, options)
    bridge.value = {
      textInput: "",
      files: [],
      isLoading: false,
      setTextInput(text) {
        this.textInput = text
      },
      addFiles(files) {
        this.files = files.map(file => ({ file }))
      },
    }
  })
  cleanup.push(mounted.unmount)
  return { session, workspace, bridge, selection }
}

test("a reopened todo restores durable files and saves attachment-only and model edits", async () => {
  vi.useFakeTimers()
  const { session, workspace, bridge } = mountDraft([
    { filename: "photo.png", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8=" },
  ])
  expect(bridge.value!.textInput).toBe("Task")
  expect(await bridge.value!.files[0]!.file.text()).toBe("hello")
  bridge.value!.textInput = ""
  session.desiredModelKey = "test/other"
  await nextTick()
  await vi.advanceTimersByTimeAsync(350)
  expect(workspace.boardDrafts[session.runtimeId]).toMatchObject({
    message: "",
    modelKey: "test/other",
    thinkingLevel: "high",
    attachments: [{ filename: "photo.png" }],
  })
  bridge.value!.files = []
  await nextTick()
  await vi.advanceTimersByTimeAsync(350)
  expect(workspace.boardDrafts[session.runtimeId].attachments).toEqual([])
})

test("a reopened todo keeps and autosaves its Git environment selection", async () => {
  vi.useFakeTimers()
  const initial = { project: "/composer-options", worktree: true, branch: "main" }
  const { workspace, selection } = mountDraft([], initial)
  expect(selection.value).toEqual(initial)
  selection.value = { project: "/composer-options", worktree: false, branch: "feature/todo" }
  await nextTick()
  await vi.advanceTimersByTimeAsync(350)
  expect(workspace.boardDrafts["composer-options"].selection).toEqual(selection.value)
})

test("assigning a session file after submit never restores the original attachment", async () => {
  const { session, bridge } = mountDraft([
    { filename: "photo.png", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8=" },
  ])
  bridge.value!.isLoading = true
  bridge.value!.textInput = ""
  bridge.value!.files = []
  session.isStreaming = true
  session.sessionFile = "/started.jsonl"
  await nextTick()
  expect(bridge.value!.files).toEqual([])
  expect(bridge.value!.textInput).toBe("")
})
