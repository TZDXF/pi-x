import { test, expect } from "vitest"
import { fileChangeArtifactsModule } from "./lib/load-ts.mjs"

const artifacts = fileChangeArtifactsModule()
const plain = value => JSON.parse(JSON.stringify(value))
const block = (callId, name) => ({ type: "toolCall", callId, name, argsText: "{}" })
const run = callId => ({
  [callId]: { id: callId, name: "write", argsText: "", outputText: "", state: "output-available" },
})

test("parses custom entries and replaces tool-argument snippets", () => {
  const artifact = artifacts.fileChangeArtifactFromEntry({
    type: "custom",
    id: "entry-1",
    customType: "pix-file-change",
    data: {
      version: 1,
      toolCallId: "call-1",
      toolName: "write",
      files: [{ path: "src\\a.ts", existedBefore: false, beforeContent: null, afterContent: "a\n" }],
    },
  })
  expect(artifact.toolCallId).toBe("call-1")
  expect(artifact.entryId).toBe("entry-1")
  expect(artifact.files[0].path).toBe("src/a.ts")

  const merged = artifacts.mergeArtifactChanges(
    [
      { id: "call-1:0", path: "src/a.ts", tool: "write", lines: [], added: 1, removed: 0, unknownBefore: true },
      { id: "legacy:0", path: "legacy.ts", tool: "edit", lines: [], added: 1, removed: 0, unknownBefore: false },
    ],
    [artifact],
  )
  expect(plain(merged.map(change => change.id))).toEqual(["legacy:0", "artifact:entry-1:0"])
  expect(merged[1].added).toBe(1)
  expect(merged[1].unknownBefore).toBe(false)
})

test("builds idempotent delete and exact restore operations", () => {
  const created = artifacts.fileChangeArtifactFromEntry({
    id: "entry-create",
    customType: "pix-file-change",
    data: {
      toolCallId: "create",
      toolName: "write",
      files: [{ path: "new.ts", existedBefore: false, beforeContent: null, afterContent: "hello\n" }],
    },
  })
  const changed = artifacts.fileChangeArtifactFromEntry({
    id: "entry-edit",
    customType: "pix-file-change",
    data: {
      toolCallId: "edit",
      toolName: "write",
      files: [{ path: "old.ts", existedBefore: true, beforeContent: "before\n", afterContent: "after\n" }],
    },
  })
  const files = artifacts.turnFileChangesFromArtifacts(
    [block("create", "write"), block("edit", "write")],
    { ...run("create"), ...run("edit") },
    [created, changed],
  )
  expect(plain(files.find(file => file.path === "new.ts").ops)).toEqual([{ kind: "delete", content: "hello\n" }])
  expect(plain(files.find(file => file.path === "old.ts").ops)).toEqual([
    { kind: "restore", before: "after\n", after: "before\n" },
  ])
  expect(files.every(file => file.revertible)).toBeTruthy()
})

test("turn totals use the final before/after state instead of summing every write", () => {
  const first = artifacts.fileChangeArtifactFromEntry({
    id: "first",
    customType: "pix-file-change",
    data: {
      toolCallId: "first",
      toolName: "write",
      files: [{ path: "a.ts", existedBefore: false, beforeContent: null, afterContent: "a\nb\n" }],
    },
  })
  const second = artifacts.fileChangeArtifactFromEntry({
    id: "second",
    customType: "pix-file-change",
    data: {
      toolCallId: "second",
      toolName: "write",
      files: [{ path: "a.ts", existedBefore: true, beforeContent: "a\nb\n", afterContent: "c\n" }],
    },
  })
  const [file] = artifacts.turnFileChangesFromArtifacts(
    [block("first", "write"), block("second", "write")],
    { ...run("first"), ...run("second") },
    [first, second],
  )
  expect(file.added).toBe(1)
  expect(file.removed).toBe(0)
})
