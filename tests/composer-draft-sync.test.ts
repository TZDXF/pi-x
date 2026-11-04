import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { nextTick, reactive, ref } from "vue"
import { useComposerDraftSync } from "@/composables/useComposerDraftSync"
import { useBoardComposerDraft } from "@/composables/useBoardComposerDraft"
import { usePromptInputProvider } from "@/components/ai-elements/prompt-input/context"
import { composerDraftFiles, composerDraftText, recordComposerDraft } from "@/stores/composerDrafts"
import { mountBrowserComposable } from "./browserTestHarness"

const cleanup: (() => void)[] = []
let sequence = 0
let project: string

beforeEach(() => {
  project = `C:/draft-test-${sequence++}`
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:http://localhost/draft-${sequence++}`)
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  vi.stubGlobal(
    "FileReader",
    class {
      result = "data:image/png;base64,aGVsbG8="
      onload: (() => void) | null = null
      readAsDataURL() {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
})

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mountComposer(file: string | null = `${project}/one.jsonl`, options = {}) {
  const session = reactive({ cwd: project, sessionFile: file })
  const selectedProject = ref(project)
  const bridge = ref(null)
  const onSubmit = vi.fn(async () => {})
  const { result: input, unmount } = mountBrowserComposable(() => {
    const { initialDraft } = useComposerDraftSync(session, () => selectedProject.value, bridge, options)
    const input = usePromptInputProvider({ initialInput: initialDraft, onSubmit })
    bridge.value = reactive(input)
    return input
  })
  let mounted = true
  const dispose = () => {
    if (!mounted) return
    mounted = false
    unmount()
  }
  cleanup.push(dispose)
  return { input, session, selectedProject, onSubmit, unmount: dispose }
}

const photo = () => new File(["hello"], "photo.png", { type: "image/png" })

function mountBoardDraft() {
  const session = reactive({ runtimeId: "board-one", isStreaming: false, entries: [] })
  const workspace = reactive({
    boardDrafts: { "board-one": { id: "board-one", project, message: "Original task", createdAt: 1, updatedAt: 1 } },
    upsertBoardDraft: vi.fn(draft => {
      workspace.boardDrafts[draft.id] = draft
    }),
  })
  const bridge = ref({
    textInput: "Original task",
    isLoading: false,
    setTextInput(text) {
      this.textInput = text
    },
  })
  const mounted = mountBrowserComposable(() => useBoardComposerDraft(session, workspace, bridge))
  cleanup.push(mounted.unmount)
  return { workspace, bridge, session }
}

test("board draft autosave preserves its message while submission temporarily clears the composer", async () => {
  vi.useFakeTimers()
  try {
    const { workspace, bridge, session } = mountBoardDraft()
    bridge.value.textInput = "Edited task"
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(workspace.boardDrafts["board-one"].message).toBe("Edited task")
    bridge.value.textInput = ""
    bridge.value.isLoading = true
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(workspace.boardDrafts["board-one"].message).toBe("Edited task")
    session.entries.push({ kind: "user" })
    bridge.value.isLoading = false
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(workspace.boardDrafts["board-one"].message).toBe("Edited task")
  } finally {
    vi.useRealTimers()
  }
})

test("remote board draft edits refresh an untouched composer without overwriting local edits", async () => {
  vi.useFakeTimers()
  try {
    const { workspace, bridge } = mountBoardDraft()
    workspace.boardDrafts["board-one"].message = "Changed on another client"
    await nextTick()
    expect(bridge.value.textInput).toBe("Changed on another client")
    vi.advanceTimersByTime(400)
    expect(workspace.upsertBoardDraft).not.toHaveBeenCalled()
    bridge.value.textInput = "My local edit"
    workspace.boardDrafts["board-one"].message = "Second remote edit"
    await nextTick()
    expect(bridge.value.textInput).toBe("My local edit")
    vi.advanceTimersByTime(400)
    expect(workspace.boardDrafts["board-one"].message).toBe("My local edit")
  } finally {
    vi.useRealTimers()
  }
})

test("unstarted board drafts in the same project keep independent text and attachments", () => {
  const first = mountComposer(null, { scope: "board-draft:first", initialText: "First todo" })
  expect(first.input.textInput.value).toBe("First todo")
  first.input.setTextInput("Edited first todo")
  const image = photo()
  first.input.addFiles([image])
  first.unmount()
  const second = mountComposer(null, { scope: "board-draft:second", initialText: "Second todo" })
  expect(second.input.textInput.value).toBe("Second todo")
  expect(second.input.files.value).toEqual([])
  second.unmount()
  const restored = mountComposer(null, { scope: "board-draft:first", initialText: "First todo" })
  expect(restored.input.textInput.value).toBe("Edited first todo")
  expect(restored.input.files.value[0]!.file).toBe(image)
})

test("a board todo's original prompt is not restored after its worker reserves a real file", async () => {
  const composer = mountComposer(null, { scope: "board-draft:starting", initialText: "Run this task" })
  await composer.input.submitForm()
  expect(composer.input.textInput.value).toBe("")
  composer.session.sessionFile = `${project}/started.jsonl`
  await nextTick()
  expect(composer.input.textInput.value).toBe("")
})

test.each(["streaming", "submitted", "bound"])(
  "reopening a %s board task keeps the submitted prompt out of the composer",
  async state => {
    const id = `board-started-${sequence++}`
    const session = reactive({
      cwd: project,
      runtimeId: id,
      sessionFile: null,
      isStreaming: false,
      entries: [],
    })
    const workspace = reactive({
      boardDrafts: {
        [id]: { id, project, message: "Run this task", createdAt: 1, updatedAt: 1 },
      },
      upsertBoardDraft: vi.fn(),
    })
    function open() {
      const bridge = ref(null)
      const mounted = mountBrowserComposable(() => {
        const options = useBoardComposerDraft(session, workspace, bridge)
        const { initialDraft } = useComposerDraftSync(session, () => project, bridge, options)
        const input = usePromptInputProvider({ initialInput: initialDraft, onSubmit: async () => {} })
        bridge.value = reactive(input)
        return input
      })
      cleanup.push(mounted.unmount)
      return mounted
    }

    const first = open()
    expect(first.result.textInput.value).toBe("Run this task")
    await first.result.submitForm()
    if (state === "streaming") session.isStreaming = true
    else {
      session.sessionFile = `${project}/started.jsonl`
      if (state === "bound") workspace.boardDrafts[id].sessionFile = session.sessionFile
      else session.entries.push({ kind: "user" })
    }
    await nextTick()
    first.unmount()

    const reopened = open()
    expect(reopened.result.textInput.value).toBe("")
    reopened.result.setTextInput("Unsent follow-up")
    reopened.unmount()
    expect(open().result.textInput.value).toBe("Unsent follow-up")
    expect(workspace.boardDrafts[id].message).toBe("Run this task")
  },
)

test.each(["draft text", ""])(
  "switching sessions restores image drafts with text %j using fresh preview URLs",
  async text => {
    const image = photo()
    const first = mountComposer()
    first.input.setTextInput(text)
    first.input.addFiles([image])
    const preview = first.input.files.value[0]!.url
    // No nextTick: adding a file and immediately navigating must still save it.
    expect(composerDraftFiles(project, `${project}/one.jsonl`)).toEqual([image])
    first.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(preview)

    const other = mountComposer(`${project}/other.jsonl`)
    expect(other.input.textInput.value).toBe("")
    expect(other.input.files.value).toEqual([])
    other.input.setTextInput("other draft")
    other.input.addFiles([new File(["other"], "other.png", { type: "image/png" })])
    other.unmount()

    const restored = mountComposer()
    expect(restored.input.textInput.value).toBe(text)
    expect(restored.input.files.value).toHaveLength(1)
    expect(restored.input.files.value[0]!.file).toBe(image)
    expect(restored.input.files.value[0]!.url).not.toBe(preview)
    expect(await restored.input.files.value[0]!.file!.text()).toBe("hello")
    expect(composerDraftText(project, `${project}/other.jsonl`)).toBe("other draft")
    expect(composerDraftFiles(project, `${project}/other.jsonl`)[0]!.name).toBe("other.png")
  },
)

test("removing a restored image updates the draft so it does not return on the next switch", () => {
  const first = mountComposer()
  first.input.setTextInput("keep text")
  first.input.addFiles([photo()])
  first.unmount()

  const restored = mountComposer()
  expect(restored.input.files.value).toHaveLength(1)
  restored.input.removeFile(restored.input.files.value[0]!.id)
  restored.unmount()

  const again = mountComposer()
  expect(again.input.textInput.value).toBe("keep text")
  expect(again.input.files.value).toEqual([])
})

test("submitting a restored image clears its draft immediately and sends the encoded image", async () => {
  const first = mountComposer()
  first.input.addFiles([photo()])
  first.unmount()
  const restored = mountComposer()

  const submission = restored.input.submitForm()
  expect(restored.input.files.value).toEqual([])
  expect(composerDraftFiles(project, `${project}/one.jsonl`)).toEqual([])
  await submission
  expect(restored.onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      files: [expect.objectContaining({ url: "data:image/png;base64,aGVsbG8=" })],
    }),
  )
  restored.unmount()

  const again = mountComposer()
  expect(again.input.files.value).toEqual([])
  expect(again.input.textInput.value).toBe("")
})

test("late session loading restores text and images together and reconnect keeps the saved-session key", async () => {
  const file = `${project}/loaded.jsonl`
  const image = photo()
  recordComposerDraft(project, file, "saved text", [image])
  const composer = mountComposer(null)
  expect(composer.input.files.value).toEqual([])

  composer.session.sessionFile = file
  await nextTick()
  expect(composer.input.textInput.value).toBe("saved text")
  expect(composer.input.files.value[0]!.file).toBe(image)

  composer.session.sessionFile = null
  await nextTick()
  composer.input.addFiles([new File(["second"], "second.png", { type: "image/png" })])
  expect(composerDraftFiles(project, file)).toHaveLength(2)
  expect(composerDraftFiles(project, null)).toEqual([])
  composer.session.sessionFile = file
  await nextTick()
  expect(composer.input.files.value).toHaveLength(2)
})

test("new-session image drafts follow deferred project changes", async () => {
  const composer = mountComposer(null)
  composer.input.addFiles([photo()])
  const next = `${project}-next`
  composer.session.cwd = next
  composer.selectedProject.value = next
  await nextTick()

  expect(composerDraftFiles(project, null)).toEqual([])
  expect(composerDraftFiles(next, null)).toHaveLength(1)
  composer.unmount()
  project = next
  const restored = mountComposer(null)
  expect(restored.input.files.value[0]!.filename).toBe("photo.png")
})

test("failed sends restore the image draft for later session switches", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const composer = mountComposer()
  const image = photo()
  composer.input.setTextInput("retry this")
  composer.input.addFiles([image])
  composer.onSubmit.mockRejectedValueOnce(new Error("send failed"))

  await composer.input.submitForm()
  expect(composerDraftText(project, `${project}/one.jsonl`)).toBe("retry this")
  expect(composerDraftFiles(project, `${project}/one.jsonl`)).toEqual([image])
  composer.unmount()

  const restored = mountComposer()
  expect(restored.input.textInput.value).toBe("retry this")
  expect(restored.input.files.value[0]!.file).toBe(image)
})
