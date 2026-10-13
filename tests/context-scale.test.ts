import { test, expect, vi } from "vitest"
import { ref } from "vue"
import { estimateContextBreakdown, annotateCompactionEstimates } from "@/lib/contextBreakdown"
import { estimateMcpContextUsage } from "@/lib/mcpUsage"
import { buildTimelineTurns } from "@/lib/conversationTimeline"
import { createSessionHistory } from "@/stores/session/history"

vi.mock("@/api/piClient", () => ({
  sessionHistory: async () => [],
  sessionLastError: async () => null,
  rpcRequest: async () => ({ success: false }),
}))
vi.mock("@/api/transport", () => ({ invoke: async () => null }))
vi.mock("@/i18n", () => ({
  i18n: { global: { t: key => key } },
  tBackendError: value => String(value ?? ""),
}))
vi.mock("@/lib/fileRewind", () => ({
  fileRewindState: async () => [],
}))
vi.mock("@/lib/notifications", () => ({ notifyTurnComplete() {} }))
vi.mock("@/stores/sessionRunStatus", () => ({ setSessionRunStatus() {} }))
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => ({}) }))

/**
 * Scale benchmarks for the long-session hot paths. Budgets are generous
 * ceilings meant to catch accidental quadratic behaviour (per-message full
 * scans or re-serialization), not to gate absolute performance.
 */

const TURNS = 5000
const COMPACTION_EVERY = 250
const BUDGET_MS = 2000
/** The drain test pays one setTimeout yield per page batch, so it dominates the
 *  suite wall time. Keep its dataset small; the pure-function benchmarks above
 *  are the quadratic detectors and run over the full TURNS. */
const DRAIN_TURNS = 800

/** Turns of user/assistant/tool traffic with periodic compaction markers. */
function syntheticSession(withEntryIds = false, turns = TURNS) {
  const messages: any[] = []
  for (let turn = 0; turn < turns; turn++) {
    const entryId = withEntryIds ? `m${turn}` : undefined
    messages.push({
      role: "user",
      content: `question ${turn} ${"q".repeat(200)}`,
      ...(entryId ? { _entryId: entryId } : {}),
    })
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `answer ${turn} ${"a".repeat(400)}` },
        {
          type: "toolCall",
          name: `mcp__server${turn % 20}__tool${turn % 5}`,
          arguments: { q: "p".repeat(100) },
          callId: `c${turn}`,
        },
      ],
      ...(entryId ? { _entryId: entryId } : {}),
    })
    messages.push({
      role: "toolResult",
      toolCallId: `c${turn}`,
      content: `result ${"o".repeat(300)}`,
    })
    if (turn % COMPACTION_EVERY === COMPACTION_EVERY - 1)
      messages.push({
        role: "compactionSummary",
        summary: `summary ${turn} ${"s".repeat(500)}`,
        tokensBefore: 10000 + turn,
        firstKeptEntryId: withEntryIds ? `m${turn - 50}` : undefined,
      })
  }
  return messages
}

function timed(fn: () => void | Promise<void>): number | Promise<number> {
  const start = performance.now()
  const done = () => performance.now() - start
  const result = fn()
  if (result instanceof Promise) return result.then(done)
  return done()
}

test("estimateContextBreakdown stays linear over 10k messages", async () => {
  const messages = syntheticSession()
  expect(messages.length).toBeGreaterThan(15000)
  const elapsed = await timed(() => estimateContextBreakdown(messages))
  expect(elapsed).toBeLessThan(BUDGET_MS)
})

test("annotateCompactionEstimates stays linear over 10k messages with markers", async () => {
  const messages = syntheticSession(true)
  const markers = messages.filter(m => m.role === "compactionSummary").length
  expect(markers).toBeGreaterThan(10)
  const elapsed = await timed(() => annotateCompactionEstimates(messages))
  expect(elapsed).toBeLessThan(BUDGET_MS)
  // firstKeptEntryId bounds each marker's rescan to its kept window, so every
  // marker gets an estimate even in a session this size.
  for (const msg of messages)
    if (msg.role === "compactionSummary") expect(typeof msg.estimatedTokensAfter).toBe("number")
})

test("estimateMcpContextUsage stays linear over 10k messages and matches results by callId", async () => {
  const messages = syntheticSession()
  const elapsed = await timed(() => estimateMcpContextUsage(messages))
  expect(elapsed).toBeLessThan(BUDGET_MS)
  const usage = estimateMcpContextUsage(messages)
  expect(Object.keys(usage).length).toBe(20)
  for (const server of Object.values(usage)) {
    expect(server.calls).toBeGreaterThan(0)
    expect(server.tools.every(tool => tool.tokens > 0)).toBe(true)
  }
})

test("buildTimelineTurns stays linear over 10k messages", async () => {
  const messages = syntheticSession()
  const cursor = Math.floor(messages.length / 2)
  const entries = messages
    .slice(cursor)
    .filter(m => m.role === "user")
    .map((m, i) => ({
      kind: "user",
      id: i + 1,
      text: m.content,
    }))
  const elapsed = await timed(() => buildTimelineTurns(messages, cursor, entries as any))
  expect(elapsed).toBeLessThan(BUDGET_MS)
  const turns = buildTimelineTurns(messages, cursor, entries as any)
  // Materialized turns plus the synthetic ones before the cursor.
  expect(turns.length).toBe(TURNS + messages.filter(m => m.role === "compactionSummary").length)
})

test("paging materializes a history snapshot page by page", async () => {
  const messages = syntheticSession(false, DRAIN_TURNS)
  const entries = ref<any[]>([])
  const runs = ref<Record<string, unknown>>({})
  let nextIdValue = 0
  const history = createSessionHistory({
    entries,
    runs,
    partialBlocks: ref(null),
    streamingTurnId: ref(null),
    sessionFile: ref(null),
    isStreaming: ref(false),
    rpcRequest: async () => ({ success: false }) as any,
    nextId: () => ++nextIdValue,
    syncSessionFile: async () => {},
    refreshFileRewindState: async () => {},
    mergeFileChangeArtifact: () => {},
    resetArtifacts: () => {},
    invalidateConversation: () => {},
  })
  history.historyMessages.value = messages
  history.historyCursor.value = messages.length

  const elapsed = await timed(async () => {
    while (history.historyCursor.value > 0) await history.loadOlderHistory()
  })
  // Drain yields between pages; the wall time is dominated by those deliberate
  // setTimeout yields, so only guard against gross regressions.
  expect(elapsed).toBeLessThan(15_000)

  const expectedUsers = messages.filter(m => m.role === "user").length
  const expectedCompactions = messages.filter(m => m.role === "compactionSummary").length
  expect(entries.value.filter(e => e.kind === "user").length).toBe(expectedUsers)
  expect(entries.value.filter(e => e.kind === "compaction").length).toBe(expectedCompactions)
  expect(Object.keys(runs.value).length).toBe(DRAIN_TURNS)
  // Fully drained: the raw snapshot is released.
  expect(history.historyMessages.value.length).toBe(0)
  expect(history.hasOlderHistory.value).toBe(false)
}, 20_000)
