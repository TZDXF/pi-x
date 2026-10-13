import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/**
 * pi ≥0.87 session entries beyond user/assistant/compaction:
 * `context_edit` markers, arbitrary extension/custom entries (e.g.
 * "pi.bug-report") and internal bookkeeping (usage cache warming, virtual
 * model state) must never break or clutter the client.
 */

const controls = vi.hoisted(() => {
  const state = {}
  return {
    state,
    piClient: {
      sessionHistory: async () => [],
      pixLog() {},
      sessionLastError: async () => null,
      sessionMtime: async () => 12345,
      generateSessionTitle: async () => null,
      rpcRequest: async () => ({ success: true, data: {} }),
    },
    workspace: {},
  }
})

vi.mock("@/api/piClient", () => controls.piClient)
vi.mock("@/api/transport", () => ({ invoke: async () => null }))
vi.mock("@/i18n", () => ({
  i18n: { global: { t: (key: string) => key } },
  tBackendError: (value: unknown) => String(value ?? ""),
}))
vi.mock("@/lib/fileRewind", () => ({
  fileRewindState: async () => [],
}))
vi.mock("@/lib/notifications", () => ({ notifyTurnComplete() {} }))
vi.mock("@/stores/sessionRunStatus", () => ({ setSessionRunStatus() {} }))
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => controls.workspace }))

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function sessionHarness() {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  setActivePinia(createPinia())
  vi.resetModules()
  const { createSessionStore } = await import("@/stores/session")
  const store = createSessionStore("default")()
  store.state = { sessionId: "one", messageCount: 0 }
  store.sessionFile = "one.jsonl"
  store.cwd = "project-one"
  return store
}

test("uiEntryFromAppendedEntry maps context_edit to a light marker", async () => {
  const { uiEntryFromAppendedEntry } = await import("@/stores/session/events")
  // replacement: null → the target is omitted from model context
  const omitted = uiEntryFromAppendedEntry(
    {
      type: "context_edit",
      id: "a1b2c2d3",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      targetId: "m1",
      replacement: null,
    },
    7,
    1000,
  )
  expect(omitted).toEqual({ kind: "context_edit", id: 7, targetId: "m1", replaced: false, timestamp: 1000, live: true })
  // non-null replacement → content replaced
  const replaced = uiEntryFromAppendedEntry(
    { type: "context_edit", targetId: "m2", replacement: { content: "..." } },
    8,
    2000,
  )
  expect(replaced).toMatchObject({ kind: "context_edit", targetId: "m2", replaced: true })
  // malformed entries must not throw
  expect(uiEntryFromAppendedEntry({ type: "context_edit" }, 9, 0)).toMatchObject({
    kind: "context_edit",
    targetId: "",
    replaced: false,
  })
})

test("uiEntryFromAppendedEntry renders model changes and silences extension entries", async () => {
  const { uiEntryFromAppendedEntry } = await import("@/stores/session/events")
  // model switches become conversation dividers
  expect(uiEntryFromAppendedEntry({ type: "model_change", provider: "p", modelId: "m" }, 14, 0)).toEqual({
    kind: "model_change",
    id: 14,
    provider: "p",
    modelId: "m",
    timestamp: 0,
    live: true,
  })
  // malformed model fields stay tolerant
  expect(uiEntryFromAppendedEntry({ type: "model_change" }, 15, 0)).toMatchObject({
    kind: "model_change",
    provider: "",
    modelId: "",
  })
  // extension entries never render: known-internal state and arbitrary
  // extension payloads alike stay out of the conversation
  expect(uiEntryFromAppendedEntry({ type: "custom", customType: "pi.bug-report", data: {} }, 1, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "vendor.custom-thing" }, 2, 0)).toBeNull()
  // internal bookkeeping stays out of the conversation
  expect(uiEntryFromAppendedEntry({ type: "usage", kind: "cache_warm" }, 3, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "custom", customType: "pi.virtual-model-state" }, 4, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "custom", customType: "pix-file-change", data: {} }, 5, 0)).toBeNull()
  // codemode's store() writes are internal script state, not conversation
  expect(
    uiEntryFromAppendedEntry(
      { type: "custom", customType: "codemode-store", data: { set: { pid: 1 }, delete: [] } },
      12,
      0,
    ),
  ).toBeNull()
  // web-search results duplicate the tool output already in the conversation
  expect(uiEntryFromAppendedEntry({ type: "custom", customType: "web-search-results", data: {} }, 13, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "message", message: { role: "user", content: "hi" } }, 6, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "compaction", summary: "s" }, 7, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "custom" }, 8, 0)).toBeNull()
  // malformed payloads never throw
  expect(uiEntryFromAppendedEntry(null, 9, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry("nope", 10, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({}, 11, 0)).toBeNull()
})

test("entry_appended materializes model_change without touching extension entries", async () => {
  const store = await sessionHarness()
  store.handleEvent({
    type: "entry_appended",
    entry: { type: "context_edit", id: "e1", targetId: "m1", replacement: null },
  })
  store.handleEvent({
    type: "entry_appended",
    entry: { type: "model_change", id: "e2", provider: "p", modelId: "m" },
  })
  store.handleEvent({
    type: "entry_appended",
    entry: { type: "custom", customType: "pi.bug-report", data: { id: "b1" } },
  })
  store.handleEvent({ type: "entry_appended", entry: { type: "usage", kind: "cache_warm" } })
  store.handleEvent({
    type: "entry_appended",
    entry: { type: "custom", customType: "pix-file-change", data: { toolCallId: "call_1", files: [] } },
  })
  const kinds = store.entries.map(entry => entry.kind)
  // context_edit and model_change surface; usage and extension entries stay silent
  expect(kinds).toEqual(["context_edit", "model_change"])
  expect(store.entries[0]).toMatchObject({ kind: "context_edit", targetId: "m1", replaced: false })
  expect(store.entries[1]).toMatchObject({ kind: "model_change", provider: "p", modelId: "m" })
})

test("responseTurns hides markers, keeps model changes as dividers and grouping predictable", async () => {
  const { responseTurns } = await import("@/lib/responseTurns")
  const entries = [
    { kind: "user", id: 1, text: "q1", timestamp: 100 },
    { kind: "assistant", id: 2, blocks: [{ type: "text", text: "a1" }], timestamp: 200 },
    { kind: "context_edit", id: 3, targetId: "x", replaced: false },
    { kind: "custom", id: 4, customType: "pi.bug-report" },
    { kind: "assistant", id: 5, blocks: [{ type: "text", text: "a2" }], timestamp: 300 },
  ] as any
  let turns = responseTurns(entries, false)
  // context_edit renders nowhere in the chat (pi writes one per retried
  // failed attempt) and extension entries never render, so both are skipped
  // entirely and the surrounding assistant messages stay in one turn.
  expect(turns.map(entry => entry.kind)).toEqual(["user", "assistant"])
  expect((turns[1] as any).blocks).toHaveLength(2)
  // markers must never be merged into an assistant turn's blocks
  expect((turns[1] as any).blocks.some((block: any) => block.type === undefined)).toBe(false)
  // a model switch renders as a divider and breaks the turn grouping
  const withSwitch = [
    { kind: "user", id: 1, text: "q1", timestamp: 100 },
    { kind: "assistant", id: 2, blocks: [{ type: "text", text: "a1" }], timestamp: 200 },
    { kind: "model_change", id: 3, provider: "p", modelId: "m" },
    { kind: "assistant", id: 4, blocks: [{ type: "text", text: "a2" }], timestamp: 400 },
  ] as any
  turns = responseTurns(withSwitch, false)
  expect(turns.map(entry => entry.kind)).toEqual(["user", "assistant", "model_change", "assistant"])
  expect((turns[3] as any).durationMs).toBeNull()
})

test("buildTimelineTurns renders context_edit as a non-question node", async () => {
  const { buildTimelineTurns } = await import("@/lib/conversationTimeline")
  // fully materialized session (snapshot released)
  const materialized = buildTimelineTurns([], 0, [
    { kind: "user", id: 1, text: "q1" },
    { kind: "context_edit", id: 2, targetId: "m0", replaced: false },
    { kind: "context_edit", id: 3, targetId: "m1", replaced: true },
  ] as any)
  expect(materialized.map(turn => turn.contextEdit)).toEqual([undefined, { replaced: false }, { replaced: true }])
  expect(materialized.every(turn => turn.question === "" || turn.question === "q1")).toBe(true)
  // live markers arriving while a history snapshot is still held
  const withSnapshot = buildTimelineTurns([{ role: "user", content: "q1", timestamp: 1 }], 1, [
    { kind: "user", id: 11, text: "q1" },
    { kind: "context_edit", id: 12, targetId: "m1", replaced: true, live: true },
  ] as any)
  const liveMarker = withSnapshot.find(turn => turn.contextEdit)
  expect(liveMarker).toMatchObject({ entryId: 12, contextEdit: { replaced: true } })
})

test("context_breakdown and compaction estimates ignore unknown entries", async () => {
  const { estimateContextBreakdown, annotateCompactionEstimates } = await import("@/lib/contextBreakdown")
  const messages = [
    { role: "user", content: "hello" },
    { role: "context_edit", targetId: "m0", replacement: null },
    { role: "custom", customType: "pi.bug-report" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ]
  const estimate = estimateContextBreakdown(messages)
  // only the two real messages are counted (4 chars each → 1 token each)
  expect(estimate.messageHistory).toBe(2)
  // annotateCompactionEstimates must not choke on unknown roles
  const withMarker = [{ role: "compactionSummary", summary: "sum", firstKeptEntryId: "m1" }, ...messages]
  expect(() => annotateCompactionEstimates(withMarker)).not.toThrow()
  expect(withMarker[0].estimatedTokensAfter).toBeGreaterThan(0)
})
