import { turnSources } from "./fixtures/chatSources"
import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { responseTurns } from "@/lib/responseTurns"
import { hasFoldedProcess } from "@/composables/useChatTurnList"
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
  const chat = turnSources()
  const blocks = readFileSync(new URL("../src/components/AssistantBlocks.vue", import.meta.url), "utf8")
  expect(chat).toMatch(/v-if="hasFoldedProcess\(entry\)"/)
  expect(chat).toMatch(/:blocks="hasFoldedProcess\(entry\) \? entry.summary : entry.blocks"/)
  expect(chat).toMatch(/<details[\s\S]*?class="response-process(?:\s[^"]*)?"/)
  expect(chat).not.toMatch(/response-process[^>]*\bopen\b/)
  expect(chat).toMatch(/emit\('fork', entry.lastIndex\)/)
  expect(blocks).not.toMatch(/<Agent|ai-elements\/agent/)
})

test("streaming and completed answers share one render path so markdown never remounts", () => {
  const chat = turnSources()
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
  expect(chat).toMatch(/:key-offset="hasFoldedProcess\(entry\) \? entry.blocks.length - entry.summary.length : 0"/)
  // The collapsed process renders lazily, not on completion.
  expect(chat).toMatch(/@toggle="onProcessToggle"/)
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

test("context edits from retried failed attempts never split the live turn", () => {
  // pi appends a context_edit after every 503-retried attempt; history replay
  // never sees these markers, so live grouping must survive them too.
  const edit = id => ({ kind: "context_edit", id, targetId: "x", replaced: false })
  const entries = [
    user(1),
    assistant(2, thinking, tool),
    edit(3),
    assistant(4, thinking, { ...tool, callId: "tool-2" }),
    edit(5),
    assistant(6, text("done")),
  ]
  const result = responseTurns(entries, false)
  expect(result.length).toBe(2)
  const turn = result[1]
  expect(turn.lastIndex).toBe(5)
  expect(turn.toolCallCount).toBe(2)
  expect(plain(turn.summary)).toEqual([text("done")])
})

test("a live model-switch annotation renders a divider before the next question without mutating store entries", () => {
  const question = {
    ...user(3),
    modelChange: { from: "old/model-a", to: "company/models/model-b" },
    timestamp: 1000,
    live: true,
  }
  const entries = [
    user(1),
    assistant(2, text("first answer")),
    question,
    { ...assistant(4, text("next answer")), timestamp: 1500 },
  ]
  const original = JSON.stringify(entries)
  const result = responseTurns(entries, false)
  expect(result.map(entry => entry.kind)).toEqual(["user", "assistant", "model_change", "user", "assistant"])
  expect(result[2]).toEqual({
    kind: "model_change",
    id: -4,
    provider: "company",
    modelId: "models/model-b",
    timestamp: 1000,
    live: true,
  })
  expect(result[3]).toBe(question)
  expect(result[4].lastIndex).toBe(3)
  expect(result[4].durationMs).toBe(500)
  expect(new Set(result.map(entry => entry.id)).size).toBe(result.length)
  expect(JSON.stringify(entries)).toBe(original)
  expect(responseTurns(entries, true)[2].id).toBe(result[2].id)
})

test("a model-switch annotation does not duplicate the matching live divider", () => {
  const marker = { kind: "model_change", id: 3, provider: "company", modelId: "model-b" }
  const entries = [
    user(1),
    assistant(2, text("first answer")),
    marker,
    { kind: "context_edit", id: 4, targetId: "x", replaced: false },
    { ...user(5), modelChange: { from: "old/model-a", to: "company/model-b" } },
  ]
  const result = responseTurns(entries, false)
  expect(result.map(entry => entry.kind)).toEqual(["user", "assistant", "model_change", "user"])
  expect(result[2]).toBe(marker)
})

test("initial and different recorded model dividers do not swallow a later live switch", () => {
  const entries = [
    { kind: "model_change", id: 1, provider: "old", modelId: "model-a" },
    user(2),
    assistant(3, text("first answer")),
    { ...user(4), modelChange: { from: "old/model-a", to: "company/model-b" } },
    assistant(5, text("next answer")),
    user(6),
  ]
  expect(responseTurns(entries, false).map(entry => entry.kind)).toEqual([
    "model_change",
    "user",
    "assistant",
    "model_change",
    "user",
    "assistant",
    "user",
  ])
  const consecutive = responseTurns([entries[0], entries[3]], false)
  expect(consecutive.map(entry => entry.kind)).toEqual(["model_change", "model_change", "user"])
})

test("completed replies without tool calls keep a thinking disclosure but show no elapsed-time label", () => {
  const turn = responseTurns(
    [
      { ...user(1), timestamp: 1000 },
      { ...assistant(2, thinking, text("answer")), timestamp: 2000 },
    ],
    false,
  )[1]
  expect(turn.complete).toBe(true)
  expect(turn.toolCallCount).toBe(0)
  expect(turn.durationMs).toBe(1000)
  expect(plain(turn.process)).toEqual([thinking])
  expect(plain(turn.summary)).toEqual([text("answer")])
  const chat = turnSources()
  const summary = chat.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1]
  expect(summary).toBeDefined()
  // Both known and unknown durations belong only to the tool-call branch.
  expect(summary).toMatch(
    /<template v-if="entry.toolCallCount > 0">[\s\S]*?chat.durationUnknown[\s\S]*?chat.executionDuration[\s\S]*?chat.toolCallCount[\s\S]*?<\/template>/,
  )
  expect(summary).toMatch(/<template v-else>\{\{ t\("chat.responseProcess"\) \}\}<\/template>/)
})

test.each([
  ["interrupted thinking", [assistant(2, thinking)]],
  ["interrupted tool call", [assistant(2, text("working"), tool)]],
  ["failed assistant message", [{ ...assistant(2, thinking, tool), failed: true }]],
  ["empty failed final entry", [assistant(2, thinking, tool), { ...assistant(3), failed: true }]],
])("%s folds its process after completion even without a final answer", (_name, replies) => {
  const entries = [user(1), ...replies]
  const active = responseTurns(entries, true)[1]
  expect(hasFoldedProcess(active)).toBe(false)
  const completed = responseTurns(entries, false)[1]
  expect(completed.summary).toEqual([])
  expect(completed.process).toEqual(completed.blocks)
  expect(hasFoldedProcess(completed)).toBe(true)
  // History replay and live entries use the same completion-based disclosure.
  const live = responseTurns(
    entries.map(entry => ({ ...entry, live: true })),
    false,
  )[1]
  expect(hasFoldedProcess(live)).toBe(true)
})

test("process disclosures keep trailing text visible and never wrap plain answers or empty turns", () => {
  const withAnswer = responseTurns([assistant(1, thinking, tool, text("answer"))], false)[0]
  expect(hasFoldedProcess(withAnswer)).toBe(true)
  expect(withAnswer.summary).toEqual([text("answer")])
  expect(withAnswer.process).toEqual([thinking, tool])
  const plainAnswer = responseTurns([assistant(1, text("answer"))], false)[0]
  expect(hasFoldedProcess(plainAnswer)).toBe(false)
  const emptyTurn = responseTurns([assistant(1)], false)[0]
  expect(hasFoldedProcess(emptyTurn)).toBe(false)
})

test("API errors are separate records, not summary text or folded reasoning", () => {
  const error = { type: "error", text: "503 · provider overloaded {details}" }
  const entries = [user(1), assistant(2, thinking, text("partial reply")), { ...assistant(3, error), failed: true }]
  const turn = responseTurns(entries, false)[1]
  expect(turn.failed).toBe(true)
  expect(turn.errors).toEqual([error])
  expect(turn.blocks).toEqual([thinking, text("partial reply")])
  expect(turn.process).toEqual(turn.blocks)
  expect(turn.summary).toEqual([])
  expect(turn.lastIndex).toBe(2)
})

test("an error-only turn has no answer or reasoning and stays recorded after a new question", () => {
  const error = { type: "error", text: "API failure" }
  const turns = responseTurns([user(1), assistant(2, error), user(3), assistant(4, text("recovered"))], false)
  expect(turns[1].errors).toEqual([error])
  expect(turns[1].blocks).toEqual([])
  expect(turns[1].process).toEqual([])
  expect(turns[1].summary).toEqual([])
  expect(turns[1].failed).toBe(true)
  expect(turns[3].failed).toBe(false)
})

test("partial content from a failed attempt is not a completed summary and recovery clears failure", () => {
  const failed = { ...assistant(2, thinking, text("partial")), failed: true }
  expect(responseTurns([user(1), failed], false)[1].summary).toEqual([])
  const recovered = responseTurns([user(1), failed, assistant(3, text("done"))], false)[1]
  expect(recovered.failed).toBe(false)
  expect(recovered.summary).toEqual([text("done")])
  expect(recovered.errors).toEqual([])
})
