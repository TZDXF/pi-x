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

async function harness({ messages = [], lastError = null } = {}) {
  Object.assign(controls.state, {
    pixLog() {},
    sessionHistory: async () => null, // fall back to the RPC projection
    sessionLastError: async () => lastError,
    sessionMtime: async () => 0,
    rpcRequest: async cmd => {
      if (cmd.type === "get_messages") return { success: true, data: { messages } }
      if (cmd.type === "get_state") return { success: true, data: { sessionFile: "test.jsonl" } }
      return { success: true, data: {} }
    },
  })
  controls.workspace = { histories: {}, projectName: () => "project" }
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  setActivePinia(createPinia())
  vi.resetModules()
  const { createSessionStore } = await import("@/stores/session")
  const store = createSessionStore("test")()
  store.sessionFile = "test.jsonl"
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
  store.entries.filter(e => e.kind === "assistant" && e.blocks.some(b => b.type === "error"))

test("history does not render mid-conversation error messages", async () => {
  const store = await harness({
    messages: [
      user("hi", 1000),
      failed('503: {"type":"http_error","message":"provider overloaded"}', 2000),
      assistant("recovered", 3000),
    ],
    lastError: null,
  })
  await store.loadHistory()
  const entries = store.entries
  // The failed attempt stays hidden; only real content renders.
  expect(entries.map(e => e.kind).join(",")).toBe("user,assistant")
  expect(errorEntries(store).length).toBe(0)
  expect(entries[1].blocks[0].text).toBe("recovered")
})

test("a final failure is appended after the conversation", async () => {
  const store = await harness({
    messages: [user("hi", 1000), assistant("working", 2000)],
    lastError: { timestamp: 2500, errorMessage: '503: {"type":"http_error","message":"provider overloaded"}' },
  })
  await store.loadHistory()
  const entries = store.entries
  expect(entries.length).toBe(3)
  const last = entries.at(-1)
  expect(last.kind).toBe("assistant")
  expect(last.blocks[0].type).toBe("error")
  expect(last.failed).toBe(true)
  // Provider JSON payloads unwrap to "status · message".
  expect(last.blocks[0].text).toMatch(/503 · provider overloaded/)
  expect(entries[1].blocks[0].text).toBe("working")
})

test("a recovered retry is not a stop reason", async () => {
  const store = await harness({
    messages: [
      user("hi", 1000),
      assistant("working", 2000),
      // The retry recovered and the turn continued past the failure.
      assistant("done", 4000),
    ],
    lastError: { timestamp: 3500, errorMessage: '503: {"type":"http_error","message":"provider overloaded"}' },
  })
  await store.loadHistory()
  expect(store.entries.length).toBe(3)
  expect(errorEntries(store).length).toBe(0)
  expect(store.entries.at(-1).blocks[0].text).toBe("done")
})

test("a failure followed by a newer user prompt is not a stop reason", async () => {
  const store = await harness({
    messages: [user("hi", 1000), assistant("recovered", 2000), user("next question", 3000), assistant("answer", 4000)],
    lastError: { timestamp: 1500, errorMessage: "503 boom" },
  })
  await store.loadHistory()
  expect(store.entries.length).toBe(4)
  expect(errorEntries(store).length).toBe(0)
})

test("an in-progress turn never gets a mid-conversation stop reason", async () => {
  const store = await harness({
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
  const store = await harness({
    messages: [user("hi", 1000), assistant("ok", 2000)],
    lastError: null,
  })
  await store.loadHistory()
  const entries = store.entries
  expect(entries.length).toBe(2)
  expect(entries[1].blocks[0].text).toBe("ok")
})

test("provider error payloads without a colon separator unwrap to status · message", async () => {
  // Real-world formats captured from session logs: providers emit "404 {json}"
  // (space) rather than the "404: {json}" (colon) the unwrap used to require.
  const store = await harness({
    messages: [user("hi", 1000), assistant("working", 2000)],
    lastError: {
      timestamp: 2500,
      errorMessage: '404 {"error":{"type":"http_error","message":"Route not found"}}',
    },
  })
  await store.loadHistory()
  const last = store.entries.at(-1)
  expect(last.blocks[0].text).toMatch(/404 · Route not found/)
})

test("wrapped provider payloads unwrap to the inner message", async () => {
  const store = await harness({
    messages: [user("hi", 1000), assistant("working", 2000)],
    lastError: {
      timestamp: 2500,
      errorMessage:
        '403 {"error":{"type":"packy_api_error","message":"This API endpoint is only accessible via the official Claude CLI (request id: XYZ)"},"type":"packy_error"}',
    },
  })
  await store.loadHistory()
  const last = store.entries.at(-1)
  expect(last.blocks[0].text).toMatch(/403 · This API endpoint is only accessible via the official Claude CLI/)
})

test("unparseable brace-bearing errors remain plain text outside markdown", async () => {
  // Dedicated records preserve payloads without markdown escaping or formatting.
  const store = await harness({
    messages: [user("hi", 1000), assistant("working", 2000)],
    lastError: { timestamp: 2500, errorMessage: "boom {weird payload} end" },
  })
  await store.loadHistory()
  const last = store.entries.at(-1)
  expect(last.blocks[0].text).toContain("boom {weird payload} end")
  expect(last.blocks[0]).toEqual({ type: "error", text: "boom {weird payload} end" })
})

test("final API failure records remain in older turns after the user continues", async () => {
  const store = await harness({
    messages: [
      user("first", 1000),
      failed('503: {"message":"overloaded"}', 2000),
      user("continue", 3000),
      assistant("done", 4000),
    ],
  })
  await store.loadHistory()
  expect(errorEntries(store)).toHaveLength(1)
  expect(errorEntries(store)[0].blocks).toEqual([{ type: "error", text: "503 · overloaded" }])
  expect(store.entries.at(-1).blocks[0].text).toBe("done")
})

test("a terminal error in raw history and supplemental last error is not duplicated", async () => {
  const store = await harness({
    messages: [user("hi", 1000), failed("API failed", 2000)],
    lastError: { errorMessage: "API failed", timestamp: 2000 },
  })
  await store.loadHistory()
  expect(errorEntries(store)).toHaveLength(1)
})
