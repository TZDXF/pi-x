import { readFileSync } from "node:fs"
import { expect, test, vi } from "vitest"
import * as vue from "vue"
import ts from "typescript"

function harness(entries = [{ kind: "user", text: "question" }, { kind: "assistant" }]) {
  const duplicate = vi.fn(async () => "copy.jsonl")
  const rpc = vi.fn(async () => ({ success: true }))
  const openSession = vi.fn()
  const session = {
    entries,
    sessionFile: "original.jsonl",
    cwd: "C:/project",
    runtimeId: "source-runtime",
    isStreaming: true,
    partialBlocks: [{ type: "text", text: "still answering" }],
    promptQueue: [{ id: 1, text: "queued question" }],
    clear: vi.fn(),
    refreshState: vi.fn(async () => {}),
    loadHistory: vi.fn(async () => {}),
  }
  const ui = { pushToast: vi.fn() }
  const imports = {
    vue,
    "vue-i18n": { useI18n: () => ({ t: key => key }) },
    "@/api/piClient": { duplicateSessionFile: duplicate },
  }
  const source = readFileSync(new URL("../src/composables/useSessionFork.ts", import.meta.url), "utf8")
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  new Function("require", "exports", code)(id => imports[id], exports)
  return { fork: exports.useSessionFork(session, ui, rpc, openSession), session, ui, rpc, duplicate, openSession }
}

function expectSourceUntouched(h: ReturnType<typeof harness>) {
  expect(h.session.sessionFile).toBe("original.jsonl")
  expect(h.session.isStreaming).toBe(true)
  expect(h.session.partialBlocks).toEqual([{ type: "text", text: "still answering" }])
  expect(h.session.promptQueue).toEqual([{ id: 1, text: "queued question" }])
  expect(h.session.clear).not.toHaveBeenCalled()
  expect(h.session.refreshState).not.toHaveBeenCalled()
  expect(h.session.loadHistory).not.toHaveBeenCalled()
  expect(h.rpc.mock.calls.every(([command]) => command.type === "get_fork_messages")).toBe(true)
}

test("forking the final answer opens an independent copy while the source continues running", async () => {
  const h = harness()
  await h.fork.forkFromAnswer(1)
  expect(h.duplicate).toHaveBeenCalledExactlyOnceWith("original.jsonl", undefined, "source-runtime")
  expect(h.openSession).toHaveBeenCalledExactlyOnceWith("copy.jsonl", "C:/project")
  expect(h.rpc).not.toHaveBeenCalled()
  expect(h.ui.pushToast).toHaveBeenCalledWith("chat.toastForked", "info")
  expectSourceUntouched(h)
})

test.each(["copy failed", "missing file"])(
  "final answer fork preserves the displayed session when %s",
  async outcome => {
    const h = harness()
    if (outcome === "copy failed") h.duplicate.mockRejectedValue(new Error("copy failed"))
    if (outcome === "missing file") h.session.sessionFile = null
    await h.fork.forkFromAnswer(1)
    expect(h.session.clear).not.toHaveBeenCalled()
    expect(h.session.loadHistory).not.toHaveBeenCalled()
    expect(h.openSession).not.toHaveBeenCalled()
    expect(h.ui.pushToast).toHaveBeenCalledOnce()
    expect(h.ui.pushToast.mock.calls[0][1]).toBe("error")
  },
)

test("earlier answers copy before the next prompt, matching repeated questions without stopping the source", async () => {
  const h = harness([{ kind: "user", text: "repeat" }, { kind: "assistant" }, { kind: "user", text: "repeat" }])
  h.rpc.mockResolvedValueOnce({
    success: true,
    data: {
      messages: [
        { entryId: "first", text: "repeat" },
        { entryId: "second", text: "repeat" },
      ],
    },
  })
  await h.fork.forkFromAnswer(1)
  expect(h.duplicate).toHaveBeenCalledExactlyOnceWith("original.jsonl", "second", "source-runtime")
  expect(h.openSession).toHaveBeenCalledExactlyOnceWith("copy.jsonl", "C:/project")
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith({ type: "get_fork_messages" })
  expectSourceUntouched(h)
})

test("the prompt picker creates a separate branch and leaves the current run intact", async () => {
  const h = harness()
  h.fork.forkOpen.value = true
  await h.fork.doFork("question-entry")
  expect(h.duplicate).toHaveBeenCalledExactlyOnceWith("original.jsonl", "question-entry", "source-runtime")
  expect(h.openSession).toHaveBeenCalledExactlyOnceWith("copy.jsonl", "C:/project")
  expect(h.fork.forkOpen.value).toBe(false)
  expectSourceUntouched(h)
})

test("a failed branch copy keeps the picker open and can be retried", async () => {
  const h = harness()
  h.fork.forkOpen.value = true
  h.duplicate.mockRejectedValueOnce(new Error("copy failed"))
  await h.fork.doFork("question-entry")
  expect(h.fork.forkOpen.value).toBe(true)
  expect(h.openSession).not.toHaveBeenCalled()
  expect(h.ui.pushToast).toHaveBeenCalledWith("Error: copy failed", "error")
  expectSourceUntouched(h)
  await h.fork.doFork("question-entry")
  expect(h.openSession).toHaveBeenCalledOnce()
})

test("a failed fork-message lookup preserves the running source", async () => {
  const h = harness([{ kind: "assistant" }, { kind: "user", text: "next" }])
  h.rpc.mockResolvedValueOnce({ success: false, error: "list failed" })
  await h.fork.forkFromAnswer(0)
  expect(h.duplicate).not.toHaveBeenCalled()
  expect(h.openSession).not.toHaveBeenCalled()
  expect(h.ui.pushToast).toHaveBeenCalledWith("Error: list failed", "error")
  expectSourceUntouched(h)
})

test("unmatched history questions fall back to the picker without navigating the source", async () => {
  const h = harness([{ kind: "assistant" }, { kind: "user", text: "missing" }])
  h.rpc.mockResolvedValue({ success: true, data: { messages: [{ entryId: "other", text: "other" }] } })
  await h.fork.forkFromAnswer(0)
  expect(h.fork.forkOpen.value).toBe(true)
  expect(h.fork.forkMessages.value).toEqual([{ entryId: "other", text: "other" }])
  expect(h.duplicate).not.toHaveBeenCalled()
  expect(h.openSession).not.toHaveBeenCalled()
  expectSourceUntouched(h)
})

test("repeated clicks while copying create only one branch", async () => {
  const h = harness()
  let finishCopy: (file: string) => void
  h.duplicate.mockImplementation(
    () =>
      new Promise(resolve => {
        finishCopy = resolve
      }),
  )
  const pending = h.fork.forkFromAnswer(1)
  await h.fork.forkFromAnswer(1)
  await h.fork.doFork("question-entry")
  expect(h.duplicate).toHaveBeenCalledOnce()
  finishCopy!("copy.jsonl")
  await pending
  expect(h.openSession).toHaveBeenCalledOnce()
  expectSourceUntouched(h)
})
