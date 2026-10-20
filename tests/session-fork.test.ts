import { readFileSync } from "node:fs"
import { expect, test, vi } from "vitest"
import * as vue from "vue"
import ts from "typescript"

function harness(entries = [{ kind: "user", text: "question" }, { kind: "assistant" }]) {
  const duplicate = vi.fn(async () => "copy.jsonl")
  const rpc = vi.fn(async () => ({ success: true }))
  const session = {
    entries,
    sessionFile: "original.jsonl",
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
  return { fork: exports.useSessionFork(session, ui, rpc), session, ui, rpc, duplicate }
}

test("forking the final answer copies the session and loads the copy", async () => {
  const h = harness()
  await h.fork.forkFromAnswer(1)
  expect(h.duplicate).toHaveBeenCalledWith("original.jsonl")
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith({ type: "switch_session", sessionPath: "copy.jsonl" })
  expect(h.session.clear).toHaveBeenCalledOnce()
  expect(h.session.refreshState).toHaveBeenCalledOnce()
  expect(h.session.loadHistory).toHaveBeenCalledOnce()
  expect(h.ui.pushToast).toHaveBeenCalledWith("chat.toastForked", "info")
})

test.each(["cancelled", "failed", "copy failed", "missing file"])(
  "final answer fork preserves the displayed session when %s",
  async outcome => {
    const h = harness()
    if (outcome === "cancelled") h.rpc.mockResolvedValue({ success: true, data: { cancelled: true } })
    if (outcome === "failed") h.rpc.mockResolvedValue({ success: false, error: "switch failed" })
    if (outcome === "copy failed") h.duplicate.mockRejectedValue(new Error("copy failed"))
    if (outcome === "missing file") h.session.sessionFile = null
    await h.fork.forkFromAnswer(1)
    expect(h.session.clear).not.toHaveBeenCalled()
    expect(h.session.loadHistory).not.toHaveBeenCalled()
    expect(h.ui.pushToast).toHaveBeenCalledOnce()
    expect(h.ui.pushToast.mock.calls[0][1]).toBe(outcome === "cancelled" ? "info" : "error")
  },
)

test("earlier answers still fork before the next prompt, matching repeated questions by occurrence", async () => {
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
  expect(h.duplicate).not.toHaveBeenCalled()
  expect(h.rpc).toHaveBeenLastCalledWith({ type: "fork", entryId: "second" })
  expect(h.session.loadHistory).toHaveBeenCalledOnce()
})
