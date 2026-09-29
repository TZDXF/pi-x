import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { contentModule, fileChangeArtifactsModule, loadTsModule, loadTsSource, pathsModule } from "./lib/load-ts.mjs"

function harness() {
  const requests = []
  const modules = {
    pinia: { defineStore: (_, setup) => setup },
    vue: {
      ref: value => ({ value }),
      shallowRef: value => ({ value }),
      computed: get => ({
        get value() {
          return get()
        },
      }),
      watch: (source, cb, options) => {
        if (options?.immediate) cb(typeof source === "function" ? source() : source)
        return () => {}
      },
    },
    "@/lib/checkpoints": {
      createCheckpoint: async () => ({ refName: "r", commitOid: "oid" }),
      diffCheckpoints: async () => [],
      loadCheckpointManifest: async () => null,
      saveCheckpointManifest: async () => {},
    },
    "@/api/piClient": {
      sessionHistory: async () => [],
      pixLog() {},
      rpcRequest: () => new Promise(resolve => requests.push(resolve)),
    },
    "@/stores/sessionRunStatus": { setSessionRunStatus() {} },
    "@/i18n": { i18n: { global: { t: key => key } } },
    "@/stores/workspace": { useWorkspaceStore: () => ({ histories: {}, projectName: () => "project" }) },
    "@/lib/notifications": { notifyTurnComplete() {} },
    "@/lib/content": contentModule(),
    "@/lib/sessionChanges": loadTsSource(
      readFileSync(new URL("../src/lib/sessionChanges.ts", import.meta.url), "utf8"),
      { require: () => pathsModule() },
    ),
    "@/lib/fileChangeArtifacts": fileChangeArtifactsModule(),
    "@/lib/contextBreakdown": loadTsSource(
      readFileSync(new URL("../src/lib/contextBreakdown.ts", import.meta.url), "utf8"),
    ),
  }
  const { createSessionStore } = loadTsModule(new URL("../src/stores/session.ts", import.meta.url), id => modules[id], {
    setTimeout,
  })
  return { store: createSessionStore("default")(), requests }
}
const messages = count => Array.from({ length: count }, (_, i) => ({ role: "user", content: `message ${i}` }))

test("first page is asynchronous and limited to 30 entries; pages preserve ordering and ids", async () => {
  const { store } = harness()
  const loading = store.loadMessages(messages(75))
  expect(store.entries.value.length).toBe(0)
  await loading
  expect(store.entries.value.length).toBe(30)
  expect(store.entries.value[0].text).toBe("message 45")
  const id = store.entries.value[0].id
  await Promise.all([store.loadOlderHistory(), store.loadOlderHistory()])
  expect(store.entries.value.length).toBe(60)
  expect(store.entries.value[30].id).toBe(id)
  await store.loadOlderHistory()
  expect(store.entries.value.length).toBe(75)
  expect(store.entries.value[0].text).toBe("message 0")
  expect(store.hasOlderHistory.value).toBe(false)
})

test("a long tool run and empty failure retries do not hide its question on the first page", async () => {
  const { store } = harness()
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
  expect(store.entries.value[0].kind).toBe("user")
  expect(store.entries.value[0].text).toBe("long question")
  expect(store.entries.value.length).toBe(56)
  expect(store.entries.value.filter(entry => entry.kind === "assistant").length).toBe(55)
  expect(store.hasOlderHistory.value).toBe(true)
  await store.loadOlderHistory()
  expect(store.entries.value[0].text).toBe("older question")
  expect(store.hasOlderHistory.value).toBe(false)
})

test("tool results survive page boundaries and image-only user messages are retained", async () => {
  const { store } = harness()
  await store.loadMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "call", content: "result" },
    ...messages(29),
    { role: "user", content: [{ type: "image", mimeType: "image/png", data: "abc" }] },
  ])
  expect(store.entries.value.length).toBe(30)
  expect(store.entries.value[29].images[0].url).toBe("data:image/png;base64,abc")
  await store.loadOlderHistory()
  expect(store.runs.value.call.outputText).toBe("result")
  expect(store.entries.value[0].blocks[0].callId).toBe("call")
})

test("clear cancels pending page processing", async () => {
  const { store } = harness()
  const pending = store.loadMessages(messages(100))
  store.clear()
  await pending
  expect(store.entries.value.length).toBe(0)
  expect(store.olderHistoryLoading.value).toBe(false)
  expect(store.hasOlderHistory.value).toBe(false)
})

test("out-of-order history requests cannot overwrite a newer session", async () => {
  const { store, requests } = harness()
  const old = store.loadHistory()
  store.clear()
  const current = store.loadHistory()
  requests[1]({ success: true, data: { messages: messages(1) } })
  await current
  requests[0]({ success: true, data: { messages: messages(99) } })
  await old
  expect(store.entries.value.length).toBe(1)
  expect(store.historyLoading.value).toBe(false)
})

test("failed history request resets loading and can be retried", async () => {
  const { store, requests } = harness()
  const failed = store.loadHistory()
  requests[0]({ success: false, error: "offline" })
  await expect(failed).rejects.toThrow(/offline/)
  expect(store.historyLoading.value).toBe(false)
  const retry = store.loadHistory()
  requests[1]({ success: true, data: { messages: [] } })
  await retry
  expect(store.hasOlderHistory.value).toBe(false)
})

test("history retains question and answer timestamps across pagination", async () => {
  const { store } = harness()
  await store.loadMessages([
    { role: "user", content: "older question", timestamp: 100 },
    { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 200 },
    { role: "user", content: "question", timestamp: 1000 },
    { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 7500 },
    ...messages(29),
  ])
  expect(store.entries.value[0].timestamp).toBe(1000)
  expect(store.entries.value[1].timestamp).toBe(7500)
  await store.loadOlderHistory()
  expect(store.entries.value[0].timestamp).toBe(100)
  expect(store.entries.value[1].timestamp).toBe(200)
  expect(store.entries.value[2].timestamp).toBe(1000)
  expect(store.entries.value[3].timestamp).toBe(7500)
})

test("file change totals remain safe across idle, history loading, completion and clear", async () => {
  const { store } = harness()
  expect(store.partialBlocks.value).toBe(null)
  expect(store.fileChanges.value.length).toBe(0)
  const loading = store.loadMessages([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts", oldText: "old", newText: "new" } },
      ],
    },
    { role: "toolResult", toolCallId: "edit-1", content: "ok" },
  ])
  expect(() => store.fileChanges.value).not.toThrow()
  await loading
  expect(store.partialBlocks.value).toBe(null)
  expect(store.fileChanges.value[0].added).toBe(1)
  expect(store.fileChanges.value[0].removed).toBe(1)
  store.partialBlocks.value = []
  expect(store.fileChanges.value.length).toBe(1)
  store.partialBlocks.value = null
  expect(store.fileChanges.value.length).toBe(1)
  store.clear()
  expect(store.fileChanges.value.length).toBe(0)
})

test("compaction summaries materialize as in-position markers", async () => {
  const { store } = harness()
  await store.loadMessages([
    { role: "user", content: "before" },
    { role: "compactionSummary", summary: "collapsed history", tokensBefore: 120000, timestamp: 42 },
    { role: "user", content: "after" },
  ])
  expect(store.entries.value.map(e => e.kind).join(",")).toBe("user,compaction,user")
  const marker = store.entries.value[1]
  expect(marker.summary).toBe("collapsed history")
  expect(marker.tokensBefore).toBe(120000)
  expect(marker.timestamp).toBe(42)
})
