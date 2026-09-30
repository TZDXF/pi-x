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
vi.mock("@/lib/checkpoints", () => ({
  createCheckpoint: async () => ({ commitOid: "oid" }),
  diffCheckpoints: async () => [],
  loadCheckpointManifest: async () => null,
  saveCheckpointManifest: async () => {},
}))
vi.mock("@/lib/fileRewind", () => ({
  fileRewindState: async () => [],
  markFileRewindState: async () => [],
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
    { type: "context_edit", id: "a1b2c2d3", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", targetId: "m1", replacement: null },
    7,
    1000,
  )
  expect(omitted).toEqual({ kind: "context_edit", id: 7, targetId: "m1", replaced: false, timestamp: 1000, live: true })
  // non-null replacement → content replaced
  const replaced = uiEntryFromAppendedEntry({ type: "context_edit", targetId: "m2", replacement: { content: "..." } }, 8, 2000)
  expect(replaced).toMatchObject({ kind: "context_edit", targetId: "m2", replaced: true })
  // malformed entries must not throw
  expect(uiEntryFromAppendedEntry({ type: "context_edit" }, 9, 0)).toMatchObject({ kind: "context_edit", targetId: "", replaced: false })
})

test("uiEntryFromAppendedEntry keeps extension entries low-key and internal ones silent", async () => {
  const { uiEntryFromAppendedEntry } = await import("@/stores/session/events")
  // extension custom entries (e.g. /bug reports) become placeholders
  expect(uiEntryFromAppendedEntry({ type: "custom", customType: "pi.bug-report", data: {} }, 1, 0)).toMatchObject({
    kind: "custom",
    customType: "pi.bug-report",
  })
  // arbitrary unknown type strings also become placeholders
  expect(uiEntryFromAppendedEntry({ type: "vendor.custom-thing" }, 2, 0)).toMatchObject({
    kind: "custom",
    customType: "vendor.custom-thing",
  })
  // internal bookkeeping stays out of the conversation
  expect(uiEntryFromAppendedEntry({ type: "usage", kind: "cache_warm" }, 3, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "custom", customType: "pi.virtual-model-state" }, 4, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "custom", customType: "pix-file-change", data: {} }, 5, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "message", message: { role: "user", content: "hi" } }, 6, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "compaction", summary: "s" }, 7, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({ type: "custom" }, 8, 0)).toBeNull()
  // malformed payloads never throw
  expect(uiEntryFromAppendedEntry(null, 9, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry("nope", 10, 0)).toBeNull()
  expect(uiEntryFromAppendedEntry({}, 11, 0)).toBeNull()
})

test("entry_appended materializes context_edit in the conversation without touching history", async () => {
  const store = await sessionHarness()
  store.handleEvent({
    type: "entry_appended",
    entry: { type: "context_edit", id: "e1", targetId: "m1", replacement: null },
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
  // context_edit and the extension entry surface; usage stays silent
  expect(kinds).toEqual(["context_edit", "custom"])
  expect(store.entries[0]).toMatchObject({ kind: "context_edit", targetId: "m1", replaced: false })
  expect(store.entries[1]).toMatchObject({ kind: "custom", customType: "pi.bug-report" })
})

test("responseTurns passes markers through and keeps grouping predictable", async () => {
  const { responseTurns } = await import("@/lib/responseTurns")
  const entries = [
    { kind: "user", id: 1, text: "q1", timestamp: 100 },
    { kind: "assistant", id: 2, blocks: [{ type: "text", text: "a1" }], timestamp: 200 },
    { kind: "context_edit", id: 3, targetId: "x", replaced: false },
    { kind: "custom", id: 4, customType: "pi.bug-report" },
    { kind: "assistant", id: 5, blocks: [{ type: "text", text: "a2" }], timestamp: 300 },
  ] as any
  const turns = responseTurns(entries, false)
  expect(turns.map(entry => entry.kind)).toEqual(["user", "assistant", "context_edit", "custom", "assistant"])
  // the marker splits assistant turns but keeps the question as duration anchor
  const first = turns[1] as any
  const second = turns[4] as any
  expect(first.blocks).toHaveLength(1)
  expect(second.blocks).toHaveLength(1)
  expect(second.durationMs).toBe(200)
  // markers must never be merged into an assistant turn's blocks
  expect(first.blocks.some((block: any) => block.type === undefined)).toBe(false)
})

test("buildTimelineTurns renders context_edit as a non-question node", async () => {
  const { buildTimelineTurns } = await import("@/lib/conversationTimeline")
  // fully materialized session (snapshot released)
  const materialized = buildTimelineTurns(
    [],
    0,
    [
      { kind: "user", id: 1, text: "q1" },
      { kind: "context_edit", id: 2, targetId: "m0", replaced: false },
      { kind: "context_edit", id: 3, targetId: "m1", replaced: true },
    ] as any,
  )
  expect(materialized.map(turn => turn.contextEdit)).toEqual([undefined, { replaced: false }, { replaced: true }])
  expect(materialized.every(turn => turn.question === "" || turn.question === "q1")).toBe(true)
  // live markers arriving while a history snapshot is still held
  const withSnapshot = buildTimelineTurns(
    [{ role: "user", content: "q1", timestamp: 1 }],
    1,
    [
      { kind: "user", id: 11, text: "q1" },
      { kind: "context_edit", id: 12, targetId: "m1", replaced: true, live: true },
    ] as any,
  )
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
