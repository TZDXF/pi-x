import { test, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pixFileChanges from "../src-tauri/extensions/pix-file-changes.js"

function harness() {
  const handlers = new Map()
  const entries = []
  const pi = {
    on(name, handler) {
      handlers.set(name, handler)
    },
    appendEntry(customType, data) {
      entries.push({ customType, data })
    },
  }
  pixFileChanges(pi)
  return { handlers, entries }
}

test("records exact before and after content for a new file", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pix-file-change-"))
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const { handlers, entries } = harness()
  const file = join(dir, "new.ts")
  await handlers.get("tool_call")({ toolCallId: "call-1", toolName: "write", input: { path: file } }, { cwd: dir })
  writeFileSync(file, "export const value = 1\n")
  await handlers.get("tool_result")(
    { toolCallId: "call-1", toolName: "write", input: { path: file }, isError: false },
    { cwd: dir },
  )

  expect(entries.length).toBe(1)
  expect(entries[0].customType).toBe("pix-file-change")
  expect(entries[0].data.toolCallId).toBe("call-1")
  expect(entries[0].data.files[0].existedBefore).toBe(false)
  expect(entries[0].data.files[0].beforeContent).toBe(null)
  expect(entries[0].data.files[0].afterContent).toBe("export const value = 1\n")
})

test("records overwrite content and ignores failed tool results", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pix-file-change-"))
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const { handlers, entries } = harness()
  const file = join(dir, "existing.ts")
  writeFileSync(file, "before\n")
  await handlers.get("tool_call")({ toolCallId: "call-2", toolName: "edit", input: { path: file } }, { cwd: dir })
  writeFileSync(file, "after\n")
  await handlers.get("tool_result")(
    { toolCallId: "call-2", toolName: "edit", input: { path: file }, isError: false },
    { cwd: dir },
  )
  expect(entries[0].data.files[0].existedBefore).toBe(true)
  expect(entries[0].data.files[0].beforeContent).toBe("before\n")
  expect(entries[0].data.files[0].afterContent).toBe("after\n")

  await handlers.get("tool_call")({ toolCallId: "call-3", toolName: "write", input: { path: file } }, { cwd: dir })
  await handlers.get("tool_result")(
    { toolCallId: "call-3", toolName: "write", input: { path: file }, isError: true },
    { cwd: dir },
  )
  expect(entries.length).toBe(1)
})
