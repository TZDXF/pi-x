import { test, expect } from "vitest"
import { turnFileChanges } from "@/lib/turnChanges"

const block = (callId, name, args) => ({ type: "toolCall", callId, name, argsText: JSON.stringify(args) })
const ok = callId => ({
  [callId]: { id: callId, name: "tool", argsText: "", outputText: "", state: "output-available" },
})

test("legacy successful edit snippets are grouped for review but never undoable", () => {
  const files = turnFileChanges(
    [
      block("a", "edit", { path: "src/a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" }),
      block("b", "edit", { path: "src/a.ts", oldText: "c", newText: "e" }),
    ],
    { ...ok("a"), ...ok("b") },
  )
  expect(files).toEqual([{ path: "src/a.ts", added: 3, removed: 2, unknown: false, revertible: false }])
  expect(files[0]).not.toHaveProperty("ops")
})

test("ignores failed, running, malformed and terminal calls", () => {
  const edit = block("a", "edit", { path: "a", oldText: "x", newText: "y" })
  for (const state of ["output-error", "input-available"]) {
    expect(turnFileChanges([edit], { a: { ...ok("a").a, state } })).toEqual([])
  }
  expect(turnFileChanges([edit], {})).toEqual([])
  expect(turnFileChanges([{ ...edit, argsText: "{" }], ok("a"))).toEqual([])
  expect(turnFileChanges([block("r", "read", { path: "a" })], ok("r"))).toEqual([])
  expect(turnFileChanges([block("s", "bash", { command: "git pull", path: "a" })], ok("s"))).toEqual([])
})

test("legacy create and overwrite calls cannot infer safe undo from arguments", () => {
  for (const name of ["create_file", "write"]) {
    const [file] = turnFileChanges([block("w", name, { path: "a.ts", content: "hello\nworld" })], ok("w"))
    expect(file.revertible).toBe(false)
    expect(file.added).toBe(2)
    expect(file).not.toHaveProperty("ops")
  }
})

test("multi-edit aliases and normalized paths retain read-only summaries", () => {
  const [file] = turnFileChanges(
    [
      block("m", "MultiEdit", {
        file_path: "src\\a.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "b", new_string: "c" },
        ],
      }),
    ],
    ok("m"),
  )
  expect(file).toEqual({ path: "src/a.ts", added: 2, removed: 2, unknown: false, revertible: false })
})
