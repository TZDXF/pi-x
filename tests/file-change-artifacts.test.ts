import { test, expect } from "vitest"
import {
  fileChangeArtifactFromEntry,
  mergeArtifactChanges,
  turnFileChangesFromArtifacts,
} from "@/lib/fileChangeArtifacts"
const block = (callId, name) => ({ type: "toolCall", callId, name, argsText: "{}" })
const run = callId => ({
  [callId]: { id: callId, name: "write", argsText: "", outputText: "", state: "output-available" },
})

test("parses custom entries and replaces tool-argument snippets", () => {
  const artifact = fileChangeArtifactFromEntry({
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

  const merged = mergeArtifactChanges(
    [
      { id: "call-1:0", path: "src/a.ts", tool: "write", lines: [], added: 1, removed: 0, unknownBefore: true },
      { id: "legacy:0", path: "legacy.ts", tool: "edit", lines: [], added: 1, removed: 0, unknownBefore: false },
    ],
    [artifact],
  )
  expect(merged.map(change => change.id)).toEqual(["legacy:0", "artifact:entry-1:0"])
  expect(merged[1].added).toBe(1)
  expect(merged[1].unknownBefore).toBe(false)
})

test("builds idempotent delete and exact restore operations", () => {
  const created = fileChangeArtifactFromEntry({
    id: "entry-create",
    customType: "pix-file-change",
    data: {
      toolCallId: "create",
      toolName: "write",
      files: [{ path: "new.ts", existedBefore: false, beforeContent: null, afterContent: "hello\n" }],
    },
  })
  const changed = fileChangeArtifactFromEntry({
    id: "entry-edit",
    customType: "pix-file-change",
    data: {
      toolCallId: "edit",
      toolName: "write",
      files: [{ path: "old.ts", existedBefore: true, beforeContent: "before\n", afterContent: "after\n" }],
    },
  })
  const files = turnFileChangesFromArtifacts(
    [block("create", "write"), block("edit", "write")],
    { ...run("create"), ...run("edit") },
    [created, changed],
  )
  expect(files.map(file => file.path)).toEqual(["new.ts", "old.ts"])
  expect(files.every(file => !("ops" in file))).toBe(true)
  expect(files.every(file => file.revertible)).toBeTruthy()
})

test("turn totals use the final before/after state instead of summing every write", () => {
  const first = fileChangeArtifactFromEntry({
    id: "first",
    customType: "pix-file-change",
    data: {
      toolCallId: "first",
      toolName: "write",
      files: [{ path: "a.ts", existedBefore: false, beforeContent: null, afterContent: "a\nb\n" }],
    },
  })
  const second = fileChangeArtifactFromEntry({
    id: "second",
    customType: "pix-file-change",
    data: {
      toolCallId: "second",
      toolName: "write",
      files: [{ path: "a.ts", existedBefore: true, beforeContent: "a\nb\n", afterContent: "c\n" }],
    },
  })
  const [file] = turnFileChangesFromArtifacts(
    [block("first", "write"), block("second", "write")],
    { ...run("first"), ...run("second") },
    [first, second],
  )
  expect(file.added).toBe(1)
  expect(file.removed).toBe(0)
})

const artifact = (toolCallId, beforeContent, afterContent, options = {}) =>
  fileChangeArtifactFromEntry({
    id: `entry-${toolCallId}`,
    customType: "pix-file-change",
    data: {
      version: 1,
      toolCallId,
      toolName: "write",
      ...options,
      files: [{ path: "a.ts", existedBefore: beforeContent !== null, beforeContent, afterContent }],
    },
  })

test("shell artifacts and artifacts for other, failed or running calls are excluded", () => {
  const blocks = [block("ok", "write"), block("shell", "bash"), block("failed", "write")]
  const files = turnFileChangesFromArtifacts(
    blocks,
    { ...run("ok"), ...run("shell"), failed: { state: "output-error" } },
    [
      artifact("ok", "before", "after"),
      artifact("other", null, "other"),
      artifact("shell", "before", "pulled", { toolName: "bash" }),
      artifact("failed", null, "failed"),
    ],
  )
  expect(files.length).toBe(1)
  expect(files[0].revertible).toBe(true)
})

test("replayed artifact entries do not double-count an operation", () => {
  const captured = artifact("call", "before", "after")
  const once = turnFileChangesFromArtifacts([block("call", "write")], run("call"), [captured])
  expect(turnFileChangesFromArtifacts([block("call", "write")], run("call"), [captured, captured])).toEqual(once)
})

test("capture timestamps preserve operation order after history replay", () => {
  const first = artifact("first", null, "middle", { createdAt: "2026-10-09T02:17:00Z" })
  const second = artifact("second", "middle", "after", { createdAt: "2026-10-09T02:18:00Z" })
  expect(
    turnFileChangesFromArtifacts(
      [block("first", "write"), block("second", "write")],
      { ...run("first"), ...run("second") },
      [second, first],
    ),
  ).toEqual([{ path: "a.ts", added: 1, removed: 0, unknown: false, revertible: true }])
})

test("external edits between captured operations make a file unsafe", () => {
  const [file] = turnFileChangesFromArtifacts(
    [block("a", "write"), block("b", "write")],
    { ...run("a"), ...run("b") },
    [artifact("a", "before", "middle"), artifact("b", "external", "after")],
  )
  expect(file.unknown).toBe(true)
  expect(file.revertible).toBe(false)
})

test("net-zero tool changes do not produce a modification card", () => {
  expect(
    turnFileChangesFromArtifacts([block("a", "write"), block("b", "write")], { ...run("a"), ...run("b") }, [
      artifact("a", "before", "middle"),
      artifact("b", "middle", "before"),
    ]),
  ).toEqual([])
})

test("missing snapshot content is unsupported, not interpreted as an absent file", () => {
  const malformed = fileChangeArtifactFromEntry({
    customType: "pix-file-change",
    data: {
      toolCallId: "call",
      toolName: "write",
      files: [{ path: "a.ts", existedBefore: true, afterContent: "after" }],
    },
  })
  expect(malformed.files[0].unsupportedReason).toBe("incomplete_artifact")
  expect(turnFileChangesFromArtifacts([block("call", "write")], run("call"), [malformed])[0].revertible).toBe(false)
})

test("empty-file creation and deletion are real changes even without changed lines", () => {
  for (const [before, after] of [
    [null, ""],
    ["", null],
  ]) {
    const [file] = turnFileChangesFromArtifacts([block("call", "write")], run("call"), [
      artifact("call", before, after),
    ])
    expect(file).toEqual({ path: "a.ts", added: 0, removed: 0, unknown: false, revertible: true })
  }
})
