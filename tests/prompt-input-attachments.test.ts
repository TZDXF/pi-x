import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { usePromptInputProvider } from "@/components/ai-elements/prompt-input/context"
import { dataUrlToImage } from "@/lib/attachments"
import { mountBrowserComposable } from "./browserTestHarness"

const cleanup: (() => void)[] = []
let failRead = false
let abortRead = false
const imageUrl = "data:image/png;base64,aGVsbG8="

// Exercise real Blob bytes without a DOM or network. CSP-blocked blob fetches
// must not affect attachments added by the picker, drag/drop, or clipboard.
class TestFileReader {
  result: string | null = null
  onload: (() => void) | null = null
  onloadend: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then(buffer => {
      if (abortRead) this.onabort?.()
      else if (failRead) this.onerror?.()
      else {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buffer).toString("base64")}`
        this.onload?.()
      }
      this.onloadend?.()
    })
  }
}

beforeEach(() => {
  failRead = false
  abortRead = false
  vi.stubGlobal("FileReader", TestFileReader)
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Blocked by connect-src")))
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/attachment")
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  for (const unmount of cleanup.splice(0)) unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function harness() {
  const onSubmit = vi.fn(async (_message: { text: string; files: { url: string }[] }) => {})
  const onError = vi.fn()
  const { result: input, unmount } = mountBrowserComposable(() => usePromptInputProvider({ onSubmit, onError }))
  let mounted = true
  const dispose = () => {
    if (mounted) {
      mounted = false
      unmount()
    }
  }
  cleanup.push(dispose)
  return { input, onSubmit, onError, unmount: dispose }
}

test.each(["look at this", ""])(
  "sends original image bytes with text %j even when blob fetch is blocked",
  async text => {
    const { input, onSubmit, onError } = harness()
    input.setTextInput(text)
    input.addFiles([new File(["hello"], "photo.png", { type: "image/png" })])

    await input.submitForm()

    expect(fetch).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledOnce()
    const message = onSubmit.mock.calls[0]![0]
    expect(message.text).toBe(text)
    expect(message.files[0]!.url).toBe(imageUrl)
    expect(dataUrlToImage(message.files[0]!.url)).toEqual({ data: "aGVsbG8=", mimeType: "image/png" })
    expect(input.textInput.value).toBe("")
    expect(input.files.value).toEqual([])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/attachment")
  },
)

test.each(["error", "abort"])(
  "a file read %s prevents sending and preserves the draft and attachment for retry",
  async kind => {
    const { input, onSubmit, onError } = harness()
    input.setTextInput("draft")
    input.addFiles([new File(["hello"], "photo.png", { type: "image/png" })])
    failRead = kind === "error"
    abortRead = kind === "abort"

    await input.submitForm()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "attachment_read_error" }))
    expect(input.textInput.value).toBe("draft")
    expect(input.files.value).toHaveLength(1)
    expect(input.isLoading.value).toBe(false)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    failRead = abortRead = false
    await input.submitForm()
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(input.files.value).toEqual([])
  },
)

test("a blob-only attachment that cannot be read is not silently submitted or cleared", async () => {
  const { input, onSubmit, onError } = harness()
  input.setTextInput("draft")
  input.files.value.push({
    id: "external",
    type: "file",
    url: "blob:http://localhost/external",
    mediaType: "image/png",
  })

  await input.submitForm()

  expect(onSubmit).not.toHaveBeenCalled()
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "attachment_read_error" }))
  expect(input.textInput.value).toBe("draft")
  expect(input.files.value).toHaveLength(1)
})

test("blob-only attachments still convert when the blob is accessible", async () => {
  const { input, onSubmit } = harness()
  vi.mocked(fetch).mockResolvedValue(new Response(new Blob(["hello"], { type: "image/png" })))
  input.files.value.push({
    id: "external",
    type: "file",
    url: "blob:http://localhost/external",
    mediaType: "image/png",
  })

  await input.submitForm()

  expect(onSubmit.mock.calls[0]![0].files[0]!.url).toBe(imageUrl)
  expect(input.files.value).toEqual([])
})

test("already encoded attachments need no blob fetch or conversion", async () => {
  const { input, onSubmit } = harness()
  input.files.value.push({ id: "encoded", type: "file", url: imageUrl, mediaType: "image/png" })

  await input.submitForm()

  expect(fetch).not.toHaveBeenCalled()
  expect(onSubmit.mock.calls[0]![0].files[0]!.url).toBe(imageUrl)
})

test("one unreadable attachment prevents a partial send of the other attachments", async () => {
  const { input, onSubmit } = harness()
  input.setTextInput("both images")
  input.addFiles([new File(["hello"], "photo.png", { type: "image/png" })])
  input.files.value.push({
    id: "external",
    type: "file",
    url: "blob:http://localhost/external",
    mediaType: "image/png",
  })

  await input.submitForm()

  expect(onSubmit).not.toHaveBeenCalled()
  expect(input.textInput.value).toBe("both images")
  expect(input.files.value).toHaveLength(2)
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
})

test("a downstream send failure preserves the original image for retry", async () => {
  const { input, onSubmit, onError } = harness()
  input.setTextInput("draft")
  input.addFiles([new File(["hello"], "photo.png", { type: "image/png" })])
  onSubmit.mockRejectedValueOnce(new Error("send failed"))

  await input.submitForm()

  expect(onError).toHaveBeenCalledWith({ code: "submit_error", message: "send failed" })
  expect(input.textInput.value).toBe("draft")
  expect(input.files.value[0]!.file).toBeInstanceOf(File)
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()

  await input.submitForm()
  expect(onSubmit.mock.calls[1]![0].files[0]!.url).toBe(imageUrl)
  expect(input.files.value).toEqual([])
})

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test.each(["with an image", ""])(
  "clears text %j and attachments together before reading or sending finishes",
  async text => {
    const { input, onSubmit } = harness()
    const sending = deferred()
    const started = deferred()
    onSubmit.mockImplementationOnce(async () => {
      started.resolve()
      await sending.promise
    })
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce("blob:http://localhost/submitted")
      .mockReturnValueOnce("blob:http://localhost/next")
    input.setTextInput(text)
    input.addFiles([new File(["hello"], "photo.png", { type: "image/png" })])

    const submission = input.submitForm()
    try {
      // These must clear synchronously, even before FileReader finishes.
      expect(input.textInput.value).toBe("")
      expect(input.files.value).toEqual([])
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()
      await started.promise
      expect(onSubmit.mock.calls[0]![0].files[0]!.url).toBe(imageUrl)
      expect(input.files.value).toEqual([])

      // A new draft belongs to the next send, not the in-flight submission.
      input.setTextInput("next draft")
      input.addFiles([new File(["next"], "next.png", { type: "image/png" })])
    } finally {
      sending.resolve()
      await submission
    }

    expect(input.textInput.value).toBe("next draft")
    expect(input.files.value.map(file => file.filename)).toEqual(["next.png"])
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:http://localhost/submitted")
  },
)

test("a failed pending send restores its attachments without overwriting the next draft", async () => {
  const { input, onSubmit } = harness()
  const sending = deferred()
  const started = deferred()
  onSubmit.mockImplementationOnce(async () => {
    started.resolve()
    await sending.promise
  })
  input.setTextInput("original draft")
  input.addFiles([new File(["hello"], "photo.png", { type: "image/png" })])
  const originalId = input.files.value[0]!.id

  const submission = input.submitForm()
  await started.promise
  input.setTextInput("next draft")
  input.addFiles([new File(["next"], "next.png", { type: "image/png" })])
  sending.reject(new Error("send failed"))
  await submission

  expect(input.textInput.value).toBe("next draft")
  expect(input.files.value.map(file => file.filename)).toEqual(["photo.png", "next.png"])
  expect(input.files.value[0]!.id).toBe(originalId)
  expect(new Set(input.files.value.map(file => file.id)).size).toBe(2)
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
})

test.each(["success", "failure"])("unmount cleans up hidden in-flight attachments after send %s", async outcome => {
  const { input, onSubmit, unmount } = harness()
  const sending = deferred()
  const started = deferred()
  onSubmit.mockImplementationOnce(async () => {
    started.resolve()
    await sending.promise
  })
  vi.mocked(URL.createObjectURL)
    .mockReturnValueOnce("blob:http://localhost/submitted")
    .mockReturnValueOnce("blob:http://localhost/next")
  input.addFiles([new File(["hello"], "photo.png", { type: "image/png" })])

  const submission = input.submitForm()
  await started.promise
  input.addFiles([new File(["next"], "next.png", { type: "image/png" })])
  unmount()
  const remainingIds = input.files.value.map(file => file.id)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/submitted")
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/next")
  if (outcome === "success") sending.resolve()
  else sending.reject(new Error("send failed"))
  await submission

  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  expect(input.files.value.map(file => file.id)).toEqual(remainingIds)
})
