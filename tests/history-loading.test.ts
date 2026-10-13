import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const controls = vi.hoisted(() => {
  const state = {}
  return {
    state,
    piClient: {
      sessionHistory: (...args) => state.sessionHistory(...args),
      pixLog: (...args) => state.pixLog(...args),
      sessionLastError: (...args) => state.sessionLastError(...args),
      sessionMtime: (...args) => state.sessionMtime(...args),
      rpcRequest: (...args) => state.rpcRequest(...args),
    },
    workspace: {},
  }
})

vi.mock("@/api/piClient", () => controls.piClient)
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
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => controls.workspace }))

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function harness() {
  const requests = []
  Object.assign(controls.state, {
    sessionHistory: async () => [],
    pixLog() {},
    sessionLastError: async () => null,
    sessionMtime: async () => 0,
    rpcRequest: () =>
      new Promise(resolve => {
        requests.push(resolve)
      }),
  })
  controls.workspace = { histories: {}, projectName: () => "project" }
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem() {},
  })
  setActivePinia(createPinia())
  vi.resetModules()
  const { createSessionStore } = await import("@/stores/session")
  return { store: createSessionStore("default")(), requests }
}
const messages = count => Array.from({ length: count }, (_, i) => ({ role: "user", content: `message ${i}` }))

test("first page is asynchronous and limited to 30 entries; pages preserve ordering and ids", async () => {
  const { store } = await harness()
  const loading = store.loadMessages(messages(75))
  expect(store.entries.length).toBe(0)
  await loading
  expect(store.entries.length).toBe(30)
  expect(store.entries[0].text).toBe("message 45")
  const id = store.entries[0].id
  await Promise.all([store.loadOlderHistory(), store.loadOlderHistory()])
  expect(store.entries.length).toBe(60)
  expect(store.entries[30].id).toBe(id)
  await store.loadOlderHistory()
  expect(store.entries.length).toBe(75)
  expect(store.entries[0].text).toBe("message 0")
  expect(store.hasOlderHistory).toBe(false)
})

test("a long tool run and empty failure retries do not hide its question on the first page", async () => {
  const { store } = await harness()
  const longTurn = Array.from({ length: 55 }, (_, i) => [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: {} }],
      timestamp: 2000 + i,
    },
    { role: "toolResult", toolCallId: `call-${i}`, content: "ok" },
  ]).flat()
  await store.loadMessages([
    { role: "user", content: "older question", timestamp: 100 },
    { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 200 },
    { role: "user", content: "long question", timestamp: 1000 },
    ...longTurn,
    ...Array.from({ length: 11 }, () => ({ role: "assistant", content: [], stopReason: "error" })),
  ])
  expect(store.entries[0].kind).toBe("user")
  expect(store.entries[0].text).toBe("long question")
  expect(store.entries.length).toBe(56)
  expect(store.entries.filter(entry => entry.kind === "assistant").length).toBe(55)
  expect(store.hasOlderHistory).toBe(true)
  await store.loadOlderHistory()
  expect(store.entries[0].text).toBe("older question")
  expect(store.hasOlderHistory).toBe(false)
})

test("tool results survive page boundaries and image-only user messages are retained", async () => {
  const { store } = await harness()
  await store.loadMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "call", content: "result" },
    ...messages(29),
    { role: "user", content: [{ type: "image", mimeType: "image/png", data: "abc" }] },
  ])
  expect(store.entries.length).toBe(30)
  expect(store.entries[29].images[0].url).toBe("data:image/png;base64,abc")
  await store.loadOlderHistory()
  expect(store.runs.call.outputText).toBe("result")
  expect(store.entries[0].blocks[0].callId).toBe("call")
})

test("clear cancels pending page processing", async () => {
  const { store } = await harness()
  const pending = store.loadMessages(messages(100))
  store.clear()
  await pending
  expect(store.entries.length).toBe(0)
  expect(store.olderHistoryLoading).toBe(false)
  expect(store.hasOlderHistory).toBe(false)
})

test("out-of-order history requests cannot overwrite a newer session", async () => {
  const { store, requests } = await harness()
  const old = store.loadHistory()
  store.clear()
  const current = store.loadHistory()
  requests[1]({ success: true, data: { messages: messages(1) } })
  await current
  requests[0]({ success: true, data: { messages: messages(99) } })
  await old
  expect(store.entries.length).toBe(1)
  expect(store.historyLoading).toBe(false)
})

test("failed history request resets loading and can be retried", async () => {
  const { store, requests } = await harness()
  const failed = store.loadHistory()
  requests[0]({ success: false, error: "offline" })
  await expect(failed).rejects.toThrow(/offline/)
  expect(store.historyLoading).toBe(false)
  const retry = store.loadHistory()
  requests[1]({ success: true, data: { messages: [] } })
  await retry
  expect(store.hasOlderHistory).toBe(false)
})

test("history retains question and answer timestamps across pagination", async () => {
  const { store } = await harness()
  await store.loadMessages([
    { role: "user", content: "older question", timestamp: 100 },
    { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 200 },
    { role: "user", content: "question", timestamp: 1000 },
    { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 7500 },
    ...messages(29),
  ])
  expect(store.entries[0].timestamp).toBe(1000)
  expect(store.entries[1].timestamp).toBe(7500)
  await store.loadOlderHistory()
  expect(store.entries[0].timestamp).toBe(100)
  expect(store.entries[1].timestamp).toBe(200)
  expect(store.entries[2].timestamp).toBe(1000)
  expect(store.entries[3].timestamp).toBe(7500)
})

test("file change totals remain safe across idle, history loading, completion and clear", async () => {
  const { store } = await harness()
  expect(store.partialBlocks).toBe(null)
  expect(store.fileChanges.length).toBe(0)
  const loading = store.loadMessages([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts", oldText: "old", newText: "new" } },
      ],
    },
    { role: "toolResult", toolCallId: "edit-1", content: "ok" },
  ])
  expect(() => store.fileChanges).not.toThrow()
  await loading
  expect(store.partialBlocks).toBe(null)
  expect(store.fileChanges[0].added).toBe(1)
  expect(store.fileChanges[0].removed).toBe(1)
  store.partialBlocks = []
  expect(store.fileChanges.length).toBe(1)
  store.partialBlocks = null
  expect(store.fileChanges.length).toBe(1)
  store.clear()
  expect(store.fileChanges.length).toBe(0)
})

test("compaction summaries materialize as in-position markers", async () => {
  const { store } = await harness()
  await store.loadMessages([
    { role: "user", content: "before" },
    { role: "compactionSummary", summary: "collapsed history", tokensBefore: 120000, timestamp: 42 },
    { role: "user", content: "after" },
  ])
  expect(store.entries.map(e => e.kind).join(",")).toBe("user,compaction,user")
  const marker = store.entries[1]
  expect(marker.summary).toBe("collapsed history")
  expect(marker.tokensBefore).toBe(120000)
  expect(marker.timestamp).toBe(42)
})
