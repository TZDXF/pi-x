import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { responseTurns } from "@/lib/responseTurns"
const user = id => ({ kind: "user", id, text: "question" })
const text = text => ({ type: "text", text })
const assistant = (id, ...blocks) => ({ kind: "assistant", id, blocks })
const tool = { type: "toolCall", callId: "tool-1", name: "bash", argsText: "{}" }
const thinking = { type: "thinking", text: "reasoning", streaming: false }
const plain = value => JSON.parse(JSON.stringify(value))

test("completed turn folds earlier replies, reasoning and tools, retaining final summary", () => {
  const entries = [user(1), assistant(2, text("checking"), tool), assistant(3, thinking, text("done"), text("details"))]
  const original = JSON.stringify(entries)
  const result = responseTurns(entries, false)
  expect(result.length).toBe(2)
  expect(result[0]).toBe(entries[0])
  expect(plain(result[1].process)).toEqual([text("checking"), tool, thinking])
  expect(plain(result[1].summary)).toEqual([text("done"), text("details")])
  expect(result[1].lastIndex).toBe(2)
  expect(result[1].complete).toBe(true)
  expect(JSON.stringify(entries)).toBe(original)
})

test("streaming only keeps the latest turn expanded; completion collapses it", () => {
  const entries = [user(1), assistant(2, text("first")), user(3), assistant(4, tool), assistant(5, text("final"))]
  const active = responseTurns(entries, true)
  expect(active[1].complete).toBe(true)
  expect(active[3].complete).toBe(false)
  expect(responseTurns(entries, false)[3].complete).toBe(true)
  expect(active[3].lastIndex).toBe(4)
})

test("commentary preceding a trailing tool call is not a final summary", () => {
  const turn = responseTurns([user(1), assistant(2, text("working"), tool)], false)[1]
  expect(turn.summary.length).toBe(0)
  expect(plain(turn.blocks)).toEqual([text("working"), tool])
})

test("single-entry turn splits process from trailing text, but plain answers need no disclosure", () => {
  const turn = responseTurns([assistant(1, text("checking"), tool, thinking, text("done"))], false)[0]
  expect(plain(turn.summary)).toEqual([text("done")])
  expect(plain(turn.process)).toEqual([text("checking"), tool, thinking])
  expect(responseTurns([assistant(1, text("answer"))], false)[0].process.length).toBe(0)
})

test("empty history and pending questions are preserved", () => {
  expect(responseTurns([], true).length).toBe(0)
  expect(plain(responseTurns([user(1)], true))).toEqual([user(1)])
})

test("chat uses an initially closed process disclosure and original index for branching", () => {
  const chat = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const blocks = readFileSync(new URL("../src/components/AssistantBlocks.vue", import.meta.url), "utf8")
  expect(chat).toMatch(/entry.complete && entry.process.length && blocksText\(entry.summary\).trim\(\)/)
  expect(chat).toMatch(/<details[\s\S]*?class="response-process(?:\s[^"]*)?"/)
  expect(chat).not.toMatch(/response-process[^>]*\bopen\b/)
  expect(chat).toMatch(/forkFromAnswer\(entry.lastIndex\)/)
  expect(blocks).not.toMatch(/<Agent|ai-elements\/agent/)
})

test("streaming and completed answers share one render path so markdown never remounts", () => {
  const chat = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const blocks = readFileSync(new URL("../src/components/AssistantBlocks.vue", import.meta.url), "utf8")
  // The streaming-turn id is reserved in the store's event-ingestion submodule.
  const session = readFileSync(new URL("../src/stores/session/events.ts", import.meta.url), "utf8")
  // In-flight deltas fold into the last turn instead of a separate Message.
  expect(chat).not.toMatch(/<Message v-if="session.partialBlocks"/)
  expect(chat).toMatch(/blocks: \[\.\.\.last\.blocks, \.\.\.partial\]/)
  // The turn keeps a stable v-for key across completion via the reserved id.
  expect(session).toMatch(/streamingTurnId.value \?\?= nextId\(\)/)
  expect(session).toMatch(/id: streamingTurnId.value \?\? nextId\(\)/)
  // The summary tail reuses the streaming block keys instead of remounting.
  expect(blocks).toMatch(/keyOffset\??: number/)
  expect(blocks).toMatch(/:key="props.keyOffset \+ i"/)
  expect(chat).toMatch(/:key-offset="hasSummary\(entry\) \? entry.blocks.length - entry.summary.length : 0"/)
  // The collapsed process renders lazily, not on completion.
  expect(chat).toMatch(/@toggle="onProcessToggle\(entry.id, \$event\)"/)
})

test("turn statistics use recorded elapsed time and unique tool call IDs", () => {
  const first = { ...assistant(2, tool), startedAt: 1000, completedAt: 2000 }
  const last = { ...assistant(3, { ...tool, callId: "tool-2" }, text("done")), startedAt: 1000, completedAt: 4250 }
  const turn = responseTurns([user(1), first, last], false)[1]
  expect(turn.durationMs).toBe(3250)
  expect(turn.toolCallCount).toBe(2)
  const historical = responseTurns([assistant(1, tool, tool, text("done"))], false)[0]
  expect(historical.durationMs).toBe(null)
  expect(historical.toolCallCount).toBe(1)
})

test("duration spans the question to the last historical response, independently per turn", () => {
  const result = responseTurns(
    [
      { ...user(1), timestamp: 1000 },
      { ...assistant(2, tool), timestamp: 2500 },
      { ...assistant(3, text("done")), timestamp: 6500 },
      { ...user(4), timestamp: 10000 },
      { ...assistant(5, text("next")), timestamp: 12000 },
    ],
    false,
  )
  expect(result[1].durationMs).toBe(5500)
  expect(result[3].durationMs).toBe(2000)
})

test("live timing includes wait before agent start and uses actual completion", () => {
  const result = responseTurns(
    [
      { ...user(1), timestamp: 1000 },
      { ...assistant(2, text("done")), startedAt: 2000, timestamp: 2100, completedAt: 7000 },
    ],
    false,
  )
  expect(result[1].durationMs).toBe(6000)
})

test("missing, invalid and reversed timestamps never produce misleading durations", () => {
  for (const timestamp of [undefined, NaN, Infinity, 500]) {
    const result = responseTurns(
      [
        { ...user(1), timestamp: 1000 },
        { ...assistant(2, text("done")), timestamp },
      ],
      false,
    )
    expect(result[1].durationMs).toBe(null)
  }
})

test("compaction markers pass through and split assistant turns", () => {
  const compaction = { kind: "compaction", id: 9, summary: "collapsed" }
  const result = responseTurns([user(1), assistant(2, text("a")), compaction, user(3), assistant(4, text("b"))], false)
  expect(result.length).toBe(5)
  expect(result[2]).toBe(compaction)
  expect(result[3]).toBe(result.find(e => e.id === 3))
  expect(result[4].lastIndex).toBe(4)
})
