import { expect, test, vi } from "vitest"
import { reactive } from "vue"
import { useTurnChanges } from "@/composables/useTurnChanges"
import { responseTurns } from "@/lib/responseTurns"

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: key => key }) }))

const call = (callId, name = "write", args = {}) => ({ type: "toolCall", callId, name, argsText: JSON.stringify(args) })
const captured = (toolCallId, path = "a.ts") => ({
  version: 1,
  toolCallId,
  toolName: "write",
  entryId: `entry-${toolCallId}`,
  files: [{ path, existedBefore: true, beforeContent: "before", afterContent: "after" }],
})
const turn = (id, blocks) => ({ kind: "assistant", id, lastIndex: id, blocks })
function harness() {
  const session = reactive({
    sessionFile: "session.jsonl",
    entries: [],
    runs: {},
    fileChangeArtifacts: [],
    revertedFileChangeCalls: new Set(),
    // 即使旧进程/数据仍带有快照清单，也不能参与新文件撤销链路。
    turnCheckpointRecords: [
      {
        turnIndex: 1,
        files: Array.from({ length: 55 }, (_, index) => ({ path: `${index}.ts`, added: 1, removed: 0 })),
      },
    ],
    recordFileRewinds: vi.fn(),
  })
  const ui = { pushToast: vi.fn() }
  return { session, ui, ...useTurnChanges(session, ui) }
}
function succeed(session, ...ids) {
  for (const id of ids) session.runs[id] = { id, name: "write", state: "output-available" }
}

test("a question without tools and a subsequent git pull never show repository snapshot changes", () => {
  const h = harness()
  h.session.entries = [
    { kind: "user", id: 1, text: "更新代码" },
    { kind: "assistant", id: 2, blocks: [{ type: "text", text: "你想更新哪部分代码？" }] },
    { kind: "user", id: 3, text: "拉取远程代码" },
    { kind: "assistant", id: 4, blocks: [call("pull", "bash", { command: "git pull" })] },
  ]
  succeed(h.session, "pull")
  const turns = responseTurns(h.session.entries, false).filter(entry => entry.kind === "assistant")
  expect(turns.map(entry => h.changesForTurn(entry))).toEqual([[], []])
  expect(turns.map(entry => h.artifactsForTurn(entry))).toEqual([[], []])
})

test("precise changes stay with their tool calls across turns and history entry renumbering", () => {
  const h = harness()
  succeed(h.session, "first", "second")
  h.session.fileChangeArtifacts = [captured("second", "second.ts"), captured("first", "first.ts")]
  const first = turn(99, [call("first")])
  const second = turn(1, [call("second")])
  expect(h.changesForTurn(first).map(file => file.path)).toEqual(["first.ts"])
  expect(h.changesForTurn(second).map(file => file.path)).toEqual(["second.ts"])
  expect(h.artifactsForTurn(first).map(item => item.toolCallId)).toEqual(["first"])
})

test("late artifacts replace read-only snippets without a cache invalidation race", () => {
  const h = harness()
  succeed(h.session, "edit")
  const entry = turn(1, [call("edit", "edit", { path: "a.ts", oldText: "before", newText: "after" })])
  expect(h.changesForTurn(entry)[0].revertible).toBe(false)
  h.session.fileChangeArtifacts.push(captured("edit"))
  expect(h.changesForTurn(entry)[0].revertible).toBe(true)
})

test("same-length edited arguments cannot reuse a stale summary", () => {
  const h = harness()
  succeed(h.session, "edit")
  const entry = turn(1, [call("edit", "edit", { path: "a.ts", oldText: "before", newText: "after" })])
  expect(h.changesForTurn(entry)[0].path).toBe("a.ts")
  entry.blocks[0].argsText = entry.blocks[0].argsText.replace("a.ts", "b.ts")
  expect(h.changesForTurn(entry)[0].path).toBe("b.ts")
})

test("only pending successful non-shell artifacts can be applied", () => {
  const h = harness()
  succeed(h.session, "first", "second", "shell")
  h.session.fileChangeArtifacts = [
    captured("first"),
    captured("second", "b.ts"),
    { ...captured("shell"), toolName: "bash" },
  ]
  const entry = turn(1, [call("first"), call("second"), call("shell", "bash")])
  h.session.revertedFileChangeCalls.add("first")
  expect(h.artifactsForTurn(entry).map(item => item.toolCallId)).toEqual(["second"])
  expect(h.turnArtifactsReverted(entry)).toBe(false)
  h.session.revertedFileChangeCalls.add("second")
  expect(h.turnArtifactsReverted(entry)).toBe(true)
  h.onTurnRevertedAll("session.jsonl", ["first", "second"])
  expect(h.session.recordFileRewinds).toHaveBeenCalledWith("session.jsonl", ["first", "second"])
})
