import { expect, test } from "vitest"
import { kanbanLivePreview } from "@/lib/kanbanLivePreview"
import type { Block, Entry, ToolRun } from "@/stores/session/types"

function session() {
  return {
    entries: [{ kind: "user", id: 1, text: "Current task" }] as Entry[],
    partialBlocks: null as Block[] | null,
    runs: {} as Record<string, ToolRun>,
    isStreaming: true,
    isCompacting: false,
    retryInfo: null as object | null,
  }
}
const call: Block = { type: "toolCall", callId: "tool-1", name: "bash", argsText: '{"command":"pnpm test"}' }

test("streaming previews use the newest text lines and read updates without changing the source", () => {
  const owner = session()
  owner.partialBlocks = [{ type: "text", text: "Old line\nWorking\nLatest progress" }]
  expect(kanbanLivePreview(owner)).toEqual({ kind: "text", text: "Working\nLatest progress" })
  owner.partialBlocks[0].text += " update"
  expect(kanbanLivePreview(owner)).toEqual({ kind: "text", text: "Working\nLatest progress update" })
  expect(owner.partialBlocks[0].text).toContain("Old line")
})

test("a new prompt and an empty new message do not reuse earlier replies", () => {
  const owner = session()
  owner.entries.unshift({ kind: "assistant", id: 0, blocks: [{ type: "text", text: "Old reply" }] })
  expect(kanbanLivePreview(owner)).toEqual({ kind: "thinking" })
  owner.entries.push({ kind: "assistant", id: 2, blocks: [{ type: "text", text: "Current commentary" }] })
  expect(kanbanLivePreview(owner)).toEqual({ kind: "text", text: "Current commentary" })
  owner.partialBlocks = []
  expect(kanbanLivePreview(owner)).toEqual({ kind: "thinking" })
})

test("thinking displays only a state, never raw reasoning text", () => {
  const owner = session()
  owner.partialBlocks = [{ type: "thinking", text: "Reasoning content", streaming: true }]
  expect(kanbanLivePreview(owner)).toEqual({ kind: "thinking" })
})

test("tool previews start with the command and follow the newest output line", () => {
  const owner = session()
  owner.entries.push({ kind: "assistant", id: 2, blocks: [call] })
  expect(kanbanLivePreview(owner)).toEqual({ kind: "tool", name: "bash", detail: "pnpm test" })
  owner.runs["tool-1"] = {
    id: "tool-1",
    name: "bash",
    argsText: call.argsText,
    outputText: "Starting\n5 passed\n10 passed",
    state: "input-available",
  }
  expect(kanbanLivePreview(owner)).toEqual({ kind: "tool", name: "bash", detail: "10 passed" })
  owner.runs["tool-1"].outputText += "\n20 passed"
  expect(kanbanLivePreview(owner)).toEqual({ kind: "tool", name: "bash", detail: "20 passed" })
  owner.partialBlocks = [{ type: "text", text: "Now checking the UI" }]
  expect(kanbanLivePreview(owner)).toEqual({ kind: "text", text: "Now checking the UI" })
})

test("file tools show their path and incomplete arguments remain safe", () => {
  const owner = session()
  owner.partialBlocks = [{ ...call, name: "read", argsText: '{"path":"src/App.vue"}' }]
  expect(kanbanLivePreview(owner)).toEqual({ kind: "tool", name: "read", detail: "src/App.vue" })
  owner.partialBlocks[0].argsText = '{"path":'
  expect(kanbanLivePreview(owner)).toEqual({ kind: "tool", name: "read", detail: "" })
})

test("compaction and retry take precedence and settled conversations have no live preview", () => {
  const owner = session()
  owner.partialBlocks = [{ type: "text", text: "Old stream" }]
  owner.retryInfo = { attempt: 1 }
  expect(kanbanLivePreview(owner)).toEqual({ kind: "retrying" })
  owner.isCompacting = true
  expect(kanbanLivePreview(owner)).toEqual({ kind: "compacting" })
  owner.isCompacting = false
  owner.retryInfo = null
  owner.isStreaming = false
  expect(kanbanLivePreview(owner)).toBeNull()
})
