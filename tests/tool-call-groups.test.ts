import { expect, test } from "vitest"
import { toolCallGroups, toolGroupStatus } from "@/lib/toolCallGroups"
import type { Block, ToolCallBlock, ToolRun } from "@/stores/conversations"

const tool = (callId: string, name = "bash"): ToolCallBlock => ({
  type: "toolCall",
  callId,
  name,
  argsText: "{}",
})
const run = (block: ToolCallBlock, state: ToolRun["state"]): ToolRun => ({
  id: block.callId,
  name: block.name,
  argsText: block.argsText,
  outputText: "",
  state,
})

test("all tool types, including file changes and subagents, share one concise group", () => {
  const blocks = [tool("1"), tool("2", "read"), tool("3", "edit"), tool("4", "write"), tool("5", "subagent")]
  expect([...toolCallGroups(blocks)]).toEqual([[0, blocks]])
})

test("text and streaming thinking stay in place and split tool groups", () => {
  const first = tool("1")
  const second = tool("2")
  const third = tool("3")
  const blocks: Block[] = [
    { type: "text", text: "Checking" },
    first,
    { type: "text", text: "Fixing" },
    second,
    { type: "thinking", text: "Still thinking", streaming: true },
    third,
    { type: "text", text: "Done" },
  ]
  expect([...toolCallGroups(blocks)]).toEqual([
    [1, [first]],
    [3, [second]],
    [5, [third]],
  ])
})

test("completed hidden thinking does not fragment groups or become expanded tool content", () => {
  const first = tool("1")
  const second = tool("2")
  const blocks: Block[] = [
    { type: "thinking", text: "Before", streaming: false },
    first,
    { type: "thinking", text: "Between", streaming: false },
    second,
    { type: "thinking", text: "After", streaming: false },
  ]
  const original = structuredClone(blocks)
  expect([...toolCallGroups(blocks)]).toEqual([[1, [first, second]]])
  expect(blocks).toEqual(original)
  expect([...toolCallGroups([])]).toEqual([])
  expect([...toolCallGroups([{ type: "text", text: "No tools" }])]).toEqual([])
})

test("streaming tool arrivals keep the group anchor and update its count", () => {
  const blocks = [tool("1")]
  expect(toolCallGroups(blocks).get(0)).toEqual([blocks[0]])
  blocks.push(tool("2", "read"))
  expect([...toolCallGroups(blocks)]).toEqual([[0, blocks]])
})

test("pending and executing tools keep the collapsed summary active", () => {
  const blocks = [tool("1"), tool("2")]
  expect(toolGroupStatus(blocks, {})).toEqual({ running: true, errors: 0 })
  expect(
    toolGroupStatus(blocks, {
      "1": run(blocks[0]!, "output-available"),
      "2": run(blocks[1]!, "input-streaming"),
    }),
  ).toEqual({ running: true, errors: 0 })
  expect(
    toolGroupStatus(blocks, {
      "1": run(blocks[0]!, "output-error"),
      "2": run(blocks[1]!, "input-available"),
    }),
  ).toEqual({ running: true, errors: 1 })
})

test("completion stops the active indicator without hiding failures", () => {
  const blocks = [tool("1"), tool("2")]
  expect(
    toolGroupStatus(blocks, {
      "1": run(blocks[0]!, "output-available"),
      "2": run(blocks[1]!, "output-available"),
    }),
  ).toEqual({ running: false, errors: 0 })
  expect(
    toolGroupStatus(blocks, {
      "1": run(blocks[0]!, "output-error"),
      "2": run(blocks[1]!, "output-error"),
    }),
  ).toEqual({ running: false, errors: 2 })
})
