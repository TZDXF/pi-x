import { test, expect } from "vitest"
import { sessionChanges, changedLines } from "@/lib/sessionChanges"
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args })
const history = (block, isError = false) => [
  { role: "assistant", content: [block] },
  { role: "toolResult", toolCallId: block.id, isError },
]
const collect = h => sessionChanges(h, [], [], {})
test("counts only successful edits and ignores reads", () => {
  const c = call("a", "edit", { path: "a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" })
  const result = collect(history(c))
  expect(result[0].added).toBe(2)
  expect(result[0].removed).toBe(1)
  expect(collect(history(c, true)).length).toBe(0)
  expect(collect([history(c)[0]]).length).toBe(0)
  expect(collect(history(call("r", "read", { path: "a" }))).length).toBe(0)
})
test("write without a baseline counts all lines as additions", () => {
  const [change] = collect(history(call("w", "write", { path: "a", content: "hello\nworld" })))
  expect(change.unknownBefore).toBe(true)
  // 未知原内容按"全部为新增"统计（与 ZCode 的 before ?? "" 口径一致）。
  expect(change.added).toBe(2)
  expect(change.lines.length).toBe(2)
})
test("history and materialized live calls deduplicate by call id", () => {
  const c = call("a", "edit", { path: "a", oldText: "x", newText: "y" })
  const block = { type: "toolCall", callId: "a", name: "edit", argsText: JSON.stringify(c.arguments) }
  expect(
    sessionChanges(history(c), [{ kind: "assistant", blocks: [block] }], [block], {
      a: { id: "a", state: "output-available" },
    }).length,
  ).toBe(1)
})
test("multi edits, aliases, empty files and malformed input", () => {
  const result = collect(
    history(
      call("a", "MultiEdit", {
        file_path: "a",
        edits: [
          { old_string: "a", new_string: "" },
          { old_string: "", new_string: "b" },
        ],
      }),
    ),
  )
  expect(result.length).toBe(2)
  expect(result[0].removed).toBe(1)
  expect(result[1].added).toBe(1)
  expect(collect(history(call("b", "edit", null))).length).toBe(0)
  expect(collect(history(call("c", "edit", "{"))).length).toBe(0)
})
test("diff preserves unchanged interior lines and normalizes CRLF", () => {
  const result = changedLines("a\r\nkeep\r\nb\r\n", "x\nkeep\ny\n")
  expect(result.filter(l => l.kind === "add").length).toBe(2)
  expect(result.filter(l => l.kind === "remove").length).toBe(2)
  expect(changedLines("", "").length).toBe(0)
})

test("null streaming blocks are valid for idle and completed sessions", () => {
  expect(sessionChanges([], [], null, {}).length).toBe(0)
  const c = call("done", "edit", { path: "a.ts", oldText: "old", newText: "new" })
  const changes = sessionChanges(history(c), [], null, {})
  expect(changes.length).toBe(1)
  expect(changes[0].added).toBe(1)
  expect(changes[0].removed).toBe(1)
})
