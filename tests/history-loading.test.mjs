import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { contentModule, loadTsModule, loadTsSource, pathsModule } from "./lib/load-ts.mjs"

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
  assert.equal(store.entries.value.length, 0)
  await loading
  assert.equal(store.entries.value.length, 30)
  assert.equal(store.entries.value[0].text, "message 45")
  const id = store.entries.value[0].id
  await Promise.all([store.loadOlderHistory(), store.loadOlderHistory()])
  assert.equal(store.entries.value.length, 60)
  assert.equal(store.entries.value[30].id, id)
  await store.loadOlderHistory()
  assert.equal(store.entries.value.length, 75)
  assert.equal(store.entries.value[0].text, "message 0")
  assert.equal(store.hasOlderHistory.value, false)
})

test("tool results survive page boundaries and image-only user messages are retained", async () => {
  const { store } = harness()
  await store.loadMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "call", content: "result" },
    ...messages(29),
    { role: "user", content: [{ type: "image", mimeType: "image/png", data: "abc" }] },
  ])
  assert.equal(store.entries.value.length, 30)
  assert.equal(store.entries.value[29].images[0].url, "data:image/png;base64,abc")
  await store.loadOlderHistory()
  assert.equal(store.runs.value.call.outputText, "result")
  assert.equal(store.entries.value[0].blocks[0].callId, "call")
})

test("clear cancels pending page processing", async () => {
  const { store } = harness()
  const pending = store.loadMessages(messages(100))
  store.clear()
  await pending
  assert.equal(store.entries.value.length, 0)
  assert.equal(store.olderHistoryLoading.value, false)
  assert.equal(store.hasOlderHistory.value, false)
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
  assert.equal(store.entries.value.length, 1)
  assert.equal(store.historyLoading.value, false)
})

test("failed history request resets loading and can be retried", async () => {
  const { store, requests } = harness()
  const failed = store.loadHistory()
  requests[0]({ success: false, error: "offline" })
  await assert.rejects(failed, /offline/)
  assert.equal(store.historyLoading.value, false)
  const retry = store.loadHistory()
  requests[1]({ success: true, data: { messages: [] } })
  await retry
  assert.equal(store.hasOlderHistory.value, false)
})

test("history retains question and answer timestamps across pagination", async () => {
  const { store } = harness()
  await store.loadMessages([
    { role: "user", content: "question", timestamp: 1000 },
    { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 7500 },
    ...messages(29),
  ])
  assert.equal(store.entries.value[0].timestamp, 7500)
  await store.loadOlderHistory()
  assert.equal(store.entries.value[0].timestamp, 1000)
  assert.equal(store.entries.value[1].timestamp, 7500)
})

test("file change totals remain safe across idle, history loading, completion and clear", async () => {
  const { store } = harness()
  assert.equal(store.partialBlocks.value, null)
  assert.equal(store.fileChanges.value.length, 0)
  const loading = store.loadMessages([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts", oldText: "old", newText: "new" } },
      ],
    },
    { role: "toolResult", toolCallId: "edit-1", content: "ok" },
  ])
  assert.doesNotThrow(() => store.fileChanges.value)
  await loading
  assert.equal(store.partialBlocks.value, null)
  assert.equal(store.fileChanges.value[0].added, 1)
  assert.equal(store.fileChanges.value[0].removed, 1)
  store.partialBlocks.value = []
  assert.equal(store.fileChanges.value.length, 1)
  store.partialBlocks.value = null
  assert.equal(store.fileChanges.value.length, 1)
  store.clear()
  assert.equal(store.fileChanges.value.length, 0)
})

test("compaction summaries materialize as in-position markers", async () => {
  const { store } = harness()
  await store.loadMessages([
    { role: "user", content: "before" },
    { role: "compactionSummary", summary: "collapsed history", tokensBefore: 120000, timestamp: 42 },
    { role: "user", content: "after" },
  ])
  assert.equal(store.entries.value.map(e => e.kind).join(","), "user,compaction,user")
  const marker = store.entries.value[1]
  assert.equal(marker.summary, "collapsed history")
  assert.equal(marker.tokensBefore, 120000)
  assert.equal(marker.timestamp, 42)
})
