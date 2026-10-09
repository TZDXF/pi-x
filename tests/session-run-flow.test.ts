import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

// Regression coverage for the session store's run-flow lifecycle: symmetric
// resets between newSession()/clear(), the resend queue-pause release and the
// get_state concurrency guard. Mock scaffolding mirrors prompt-queue.test.ts.

const controls = vi.hoisted(() => {
  const state = {}
  return {
    state,
    piClient: {
      sessionHistory: (...args) => state.sessionHistory(...args),
      pixLog: (...args) => state.pixLog(...args),
      sessionLastError: (...args) => state.sessionLastError(...args),
      sessionMtime: (...args) => state.sessionMtime(...args),
      generateSessionTitle: (...args) => state.generateSessionTitle(...args),
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

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function harness(rpcOverrides: Record<string, (command: any) => unknown> = {}) {
  const calls = []
  Object.assign(controls.state, {
    sessionHistory: async () => [],
    sessionLastError: async () => null,
    sessionMtime: async () => 12345,
    pixLog() {},
    generateSessionTitle: async () => null,
    rpcRequest: command => {
      calls.push(command)
      const override = rpcOverrides[command.type]
      if (override) return Promise.resolve(override(command))
      if (command.type === "get_state")
        return Promise.resolve({ success: true, data: { sessionId: "one", messageCount: 0, sessionFile: "one.jsonl" } })
      if (command.type === "get_available_thinking_levels")
        return Promise.resolve({ success: true, data: { levels: ["off"] } })
      if (command.type === "get_session_stats") return Promise.resolve({ success: true, data: {} })
      if (command.type === "new_session") return Promise.resolve({ success: true, data: {} })
      return new Promise(() => {})
    },
  })
  controls.workspace = {
    histories: {},
    projectName: () => "project",
    preview() {},
    generatedTitle() {},
    refresh: async () => {},
  }
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  setActivePinia(createPinia())
  vi.resetModules()
  const { createSessionStore } = await import("@/stores/session")
  const store = createSessionStore("run-flow")()
  store.state = { sessionId: "one", messageCount: 0 }
  store.sessionFile = "one.jsonl"
  store.cwd = "project-one"
  // resendPrompt targets the last user entry; seed one like edit-prompt does.
  store.entries.push({ kind: "user", id: 1, text: "original" })
  return { store, calls }
}

test("newSession during a run resets the run-flow flags like clear does", async () => {
  const h = await harness()
  h.store.isStreaming = true
  h.store.isCompacting = true
  h.store.isResending = true
  h.store.retryInfo = { attempt: 1, maxAttempts: 3, errorMessage: "boom" }
  h.store.dispositionNotice = { seq: 1, message: "queued" }
  h.store.partialBlocks = [{ type: "text", text: "partial" }]
  h.store.streamingTurnId = 7
  h.store.steering = ["steer me"]
  h.store.followUp = ["follow me"]
  h.store.schedulePrompt("later", 60_000)
  h.store.entries.push({ kind: "user", id: 99, text: "question" })
  h.store.runs["call-1"] = { id: "call-1", name: "bash", argsText: "", outputText: "", state: "output-available" }
  await h.store.newSession()
  expect(h.store.isStreaming).toBe(false)
  expect(h.store.isCompacting).toBe(false)
  expect(h.store.isResending).toBe(false)
  expect(h.store.retryInfo).toBe(null)
  expect(h.store.dispositionNotice).toBe(null)
  expect(h.store.partialBlocks).toBe(null)
  expect(h.store.streamingTurnId).toBe(null)
  expect(h.store.steering).toEqual([])
  expect(h.store.followUp).toEqual([])
  expect(h.store.stats).toEqual({}) // reset, then repopulated by the new session's refreshStats
  expect(h.store.entries).toEqual([])
  expect(h.store.runs).toEqual({})
  expect(h.store.promptQueue.length).toBe(0)
  // The in-flight prompt now rejects against the bumped conversation version;
  // the streaming lock must already be gone either way.
  expect(h.calls.some(call => call.type === "new_session")).toBe(true)
})

test("a cancelled new_session leaves the current run untouched", async () => {
  const h = await harness({ new_session: () => ({ success: true, data: { cancelled: true } }) })
  h.store.isStreaming = true
  await h.store.newSession()
  expect(h.store.isStreaming).toBe(true)
  expect(h.store.entries.map(entry => entry.text)).toEqual(["original"])
})

test("a failed resend releases the queue so delayed prompts still dispatch", async () => {
  const h = await harness({
    clear_queue: async () => ({ success: true, data: { steering: [], followUp: [] } }),
    abort: async () => ({ success: true }),
    get_state: async () => ({ success: true, data: { isStreaming: true } }),
  })
  h.store.schedulePrompt("later", 10)
  await expect(h.store.resendPrompt("revised")).rejects.toThrow()
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(h.calls.find(call => call.type === "prompt")?.message).toBe("later")
  expect(h.store.promptQueue.length).toBe(0)
})

test("a failed resend still lets agent_settled dispatch queued prompts", async () => {
  const h = await harness({
    clear_queue: async () => ({ success: true, data: { steering: [], followUp: [] } }),
    abort: async () => ({ success: true }),
    rewind_prompt: async () => {
      throw new Error("rewind failed")
    },
  })
  h.store.isStreaming = true
  await h.store.send("/first", undefined, undefined, "queue")
  h.store.isStreaming = false
  await expect(h.store.resendPrompt("revised")).rejects.toThrow(/rewind failed/)
  // A later run settles; the queued slash command must finally go out instead
  // of being stuck behind a queue pause the failed edit never lifted.
  h.store.isStreaming = true
  h.store.handleEvent({ type: "agent_settled" })
  expect(h.calls.filter(call => call.type === "prompt").map(call => call.message)).toEqual(["/first"])
})

test("a late get_state response cannot clobber newer state or sessionFile", async () => {
  const resolvers: Array<(value: unknown) => void> = []
  const h = await harness({
    get_state: () => new Promise(resolve => resolvers.push(resolve)),
  })
  const first = h.store.refreshState()
  const second = h.store.refreshState()
  await tick()
  expect(resolvers.length).toBe(2)
  resolvers[1]({ success: true, data: { sessionId: "new", sessionFile: "new.jsonl" } })
  await second
  expect(h.store.sessionFile).toBe("new.jsonl")
  resolvers[0]({ success: true, data: { sessionId: "old", sessionFile: "old.jsonl" } })
  await first
  expect(h.store.sessionFile).toBe("new.jsonl")
  expect(h.store.state?.sessionId).toBe("new")
})

test("a compact command with images is rejected instead of reaching the model", async () => {
  const h = await harness()
  await h.store.send("/compact", [{ data: "YWJj", mimeType: "image/png" }])
  expect(h.calls.some(call => call.type === "prompt")).toBe(false)
  expect(h.calls.some(call => call.type === "compact")).toBe(false)
  expect(h.store.compactionError).toBe("chat.compactImagesUnsupported")
  expect(h.store.entries).toHaveLength(1)
})

test("failed compact commands use transient errors and the next prompt clears them", async () => {
  const h = await harness({ compact: () => ({ success: false, error: '503: {"message":"compaction unavailable"}' }) })
  await h.store.send("/compact")
  expect(h.store.compactionError).toBe("503 · compaction unavailable")
  expect(h.store.isCompacting).toBe(false)
  expect(h.store.entries).toHaveLength(1)
  await h.store.send("continue")
  expect(h.store.compactionError).toBe(null)
  expect(h.store.entries.at(-1).kind).toBe("user")
})

test("automatic compaction errors clear on continuation and successful compaction", async () => {
  const h = await harness()
  h.store.handleEvent({ type: "compaction_start" })
  h.store.handleEvent({ type: "compaction_end", errorMessage: "summary request failed", result: null })
  expect(h.store.compactionError).toBe("summary request failed")
  expect(h.store.entries).toHaveLength(1)
  h.store.handleEvent({ type: "agent_start" })
  expect(h.store.compactionError).toBe(null)
  h.store.handleEvent({ type: "compaction_end", errorMessage: "failed again" })
  h.store.handleEvent({ type: "compaction_start" })
  expect(h.store.compactionError).toBe(null)
  h.store.handleEvent({ type: "compaction_end", result: { summary: "kept context" } })
  expect(h.store.compactionError).toBe(null)
  expect(h.store.entries.at(-1).kind).toBe("compaction")
})

test("loading another transcript clears transient compaction errors", async () => {
  const h = await harness()
  h.store.handleEvent({ type: "compaction_end", errorMessage: "failed" })
  await h.store.loadMessages([{ role: "user", content: "another conversation" }])
  expect(h.store.compactionError).toBe(null)
})

test("prompt RPC failures are error records rather than markdown replies", async () => {
  const h = await harness({ prompt: () => ({ success: false, error: "request rejected {payload}" }) })
  await h.store.send("hello")
  await tick()
  const error = h.store.entries.at(-1)
  expect(error.failed).toBe(true)
  expect(error.blocks).toEqual([{ type: "error", text: "request rejected {payload}" }])
})

test("a delayed compact failure cannot reappear after the next prompt starts", async () => {
  let resolveCompact
  const h = await harness({
    compact: () =>
      new Promise(resolve => {
        resolveCompact = resolve
      }),
  })
  const compact = h.store.send("/compact")
  h.store.handleEvent({ type: "compaction_end", errorMessage: "compaction failed" })
  await h.store.send("continue")
  expect(h.store.compactionError).toBe(null)
  resolveCompact({ success: false, error: "compaction failed" })
  await compact
  expect(h.store.compactionError).toBe(null)
})
