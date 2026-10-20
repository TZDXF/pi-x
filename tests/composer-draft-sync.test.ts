import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { nextTick, reactive, ref } from "vue"
import { useComposerDraftSync } from "@/composables/useComposerDraftSync"
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

function mountComposer(file: string | null = `${project}/one.jsonl`) {
  const session = reactive({ cwd: project, sessionFile: file })
  const selectedProject = ref(project)
  const bridge = ref(null)
  const onSubmit = vi.fn(async () => {})
  const { result: input, unmount } = mountBrowserComposable(() => {
    const { initialDraft } = useComposerDraftSync(session, () => selectedProject.value, bridge)
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
