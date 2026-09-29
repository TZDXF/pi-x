import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { contentModule, loadTsModule, loadTsSource, pathsModule } from "./lib/load-ts.mjs"

function harness({ messages = [], lastError = null } = {}) {
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
    "@/i18n": { i18n: { global: { t: key => key } } },
    "@/api/piClient": {
      pixLog() {},
      rpcRequest: async cmd => {
        if (cmd.type === "get_messages") return { success: true, data: { messages } }
        if (cmd.type === "get_state") return { success: true, data: { sessionFile: "test.jsonl" } }
        return { success: true, data: {} }
      },
      sessionHistory: async () => null, // fall back to the RPC projection
      sessionLastError: async () => lastError,
      sessionMtime: async () => 0,
    },
    "@/stores/workspace": { useWorkspaceStore: () => ({ histories: {}, projectName: () => "project" }) },
    "@/lib/notifications": { notifyTurnComplete() {} },
    "@/stores/sessionRunStatus": { setSessionRunStatus() {} },
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
    localStorage: { getItem: () => null },
  })
  const store = createSessionStore("test")()
  store.sessionFile.value = "test.jsonl"
  return store
}

const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp })
const assistant = (text, timestamp) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  timestamp,
})
const failed = (errorMessage, timestamp) => ({
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage,
  timestamp,
})
const errorEntries = store =>
  store.entries.value.filter(
    e => e.kind === "assistant" && e.blocks.some(b => b.type === "text" && b.text.includes("chat.errorLabel")),
  )

test("history does not render mid-conversation error messages", async () => {
  const store = harness({
    messages: [
      user("hi", 1000),
      failed('503: {"type":"http_error","message":"provider overloaded"}', 2000),
      assistant("recovered", 3000),
    ],
    lastError: null,
  })
  await store.loadHistory()
  const entries = store.entries.value
  // The failed attempt stays hidden; only real content renders.
  expect(entries.map(e => e.kind).join(",")).toBe("user,assistant")
  expect(errorEntries(store).length).toBe(0)
  expect(entries[1].blocks[0].text).toBe("recovered")
})

test("a final failure is appended after the conversation", async () => {
  const store = harness({
    messages: [user("hi", 1000), assistant("working", 2000)],
    lastError: { timestamp: 2500, errorMessage: '503: {"type":"http_error","message":"provider overloaded"}' },
  })
  await store.loadHistory()
  const entries = store.entries.value
  expect(entries.length).toBe(3)
  const last = entries.at(-1)
  expect(last.kind).toBe("assistant")
  expect(last.blocks[0].text).toMatch(/chat\.errorLabel/)
  // Provider JSON payloads unwrap to "status · message".
  expect(last.blocks[0].text).toMatch(/503 · provider overloaded/)
  expect(entries[1].blocks[0].text).toBe("working")
})

test("a recovered retry is not a stop reason", async () => {
  const store = harness({
    messages: [
      user("hi", 1000),
      assistant("working", 2000),
      // The retry recovered and the turn continued past the failure.
      assistant("done", 4000),
    ],
    lastError: { timestamp: 3500, errorMessage: '503: {"type":"http_error","message":"provider overloaded"}' },
  })
  await store.loadHistory()
  expect(store.entries.value.length).toBe(3)
  expect(errorEntries(store).length).toBe(0)
  expect(store.entries.value.at(-1).blocks[0].text).toBe("done")
})

test("a failure followed by a newer user prompt is not a stop reason", async () => {
  const store = harness({
    messages: [user("hi", 1000), assistant("recovered", 2000), user("next question", 3000), assistant("answer", 4000)],
    lastError: { timestamp: 1500, errorMessage: "503 boom" },
  })
  await store.loadHistory()
  expect(store.entries.value.length).toBe(4)
  expect(errorEntries(store).length).toBe(0)
})

test("an in-progress turn never gets a mid-conversation stop reason", async () => {
  const store = harness({
    messages: [user("hi", 1000), assistant("working", 2000)],
    lastError: { timestamp: 2500, errorMessage: "503 boom" },
  })
  // Viewing a session while its turn is still running: retry may recover, and
  // later live events append after whatever loadHistory added.
  store.handleEvent({ type: "agent_start" })
  await store.loadHistory()
  expect(errorEntries(store).length).toBe(0)
  // Once the turn is over, the same history surfaces the stop reason again.
  store.handleEvent({ type: "agent_settled" })
  await store.loadHistory()
  expect(errorEntries(store).length).toBe(1)
})

test("history without errors loads unchanged", async () => {
  const store = harness({
    messages: [user("hi", 1000), assistant("ok", 2000)],
    lastError: null,
  })
  await store.loadHistory()
  const entries = store.entries.value
  expect(entries.length).toBe(2)
  expect(entries[1].blocks[0].text).toBe("ok")
})
