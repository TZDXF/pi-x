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

async function sessionHarness(rpcOverrides: Record<string, (command: any) => unknown> = {}) {
  const calls = [],
    previews = [],
    titles = [],
    refreshed = []
  let finish, fail
  Object.assign(controls.state, {
    sessionHistory: async () => [],
    sessionLastError: async () => null,
    sessionMtime: async () => 12345,
    pixLog() {},
    rpcRequest: command => {
      calls.push(command)
      const override = rpcOverrides[command.type]
      if (override) return Promise.resolve(override(command))
      return new Promise(() => {})
    },
    generateSessionTitle: (...args) => {
      calls.push({ type: "title", args })
      return new Promise((resolve, reject) => {
        finish = resolve
        fail = reject
      })
    },
  })
  controls.workspace = {
    histories: {},
    projectName: () => "project",
    preview: row => previews.push(row),
    generatedTitle: (...args) => titles.push(args),
    refresh: async path => refreshed.push(path),
  }
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  setActivePinia(createPinia())
  vi.resetModules()
  const { createSessionStore } = await import("@/stores/session")
  const store = createSessionStore("default")()
  store.state = { sessionId: "one", messageCount: 0 }
  store.sessionFile = "one.jsonl"
  store.cwd = "project-one"
  return {
    store,
    calls,
    previews,
    titles,
    refreshed,
    finish: value => finish(value),
    fail: () => fail(new Error("offline")),
  }
}

test("messages queued during a run stay in the client panel until the run settles", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  const images = [{ data: "YWJj", mimeType: "image/png" }]
  await h.store.send("next", images, "expanded next", "queue")
  await tick()
  // nothing is handed to pi and the question is not echoed into the conversation
  expect(h.calls.filter(c => c.type === "prompt" || c.type === "follow_up").length).toBe(0)
  expect(h.store.entries.length).toBe(0)
  expect(h.store.promptQueue).toEqual([
    { id: expect.any(Number), text: "next", images, expandedText: "expanded next" },
  ])
  // settling the run dispatches it as a normal prompt
  h.store.handleEvent({ type: "agent_end" })
  h.store.handleEvent({ type: "agent_settled" })
  await tick()
  const prompt = h.calls.find(c => c.type === "prompt")
  expect(prompt.message).toBe("expanded next")
  expect(prompt.images[0].data).toBe("YWJj")
  expect(prompt.streamingBehavior).toBe(undefined)
  expect(h.store.entries[0].text).toBe("next")
  expect(h.store.promptQueue.length).toBe(0)
})

test("reorder and remove use stable IDs, including identical prompts", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  for (const text of ["/same", "/same", "/third"]) await h.store.send(text, undefined, undefined, "queue")
  const [a, b, c] = h.store.promptQueue.map(item => item.id)
  h.store.moveQueuedPrompt(c, a)
  expect(h.store.promptQueue[0].id).toBe(c)
  expect(h.store.removeQueuedPrompt(b).text).toBe("/same")
  h.store.moveQueuedPrompt(b, a) // stale drag must not remove another item
  expect(h.store.promptQueue.length).toBe(2)
  h.store.handleEvent({ type: "agent_settled" })
  expect(h.calls.find(c => c.type === "prompt").message).toBe("/third")
  expect(h.store.promptQueue[0].id).toBe(a)
  h.store.dispatchQueuedPrompt() // must not send while the new run is starting
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(1)
})

test("steering goes to the running agent without draining the queue", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  await h.store.send("later", undefined, undefined, "queue")
  await h.store.send("change direction", undefined, undefined, "steer")
  const prompt = h.calls.find(c => c.type === "prompt")
  expect(prompt.streamingBehavior).toBe("steer")
  expect(prompt.message).toBe("change direction")
  expect(h.store.promptQueue.map(item => item.text)).toEqual(["later"])
})

test("steering disposition is surfaced as a notice", async () => {
  const h = await sessionHarness({ prompt: () => ({ success: true, data: { disposition: "queued" } }) })
  h.store.isStreaming = true
  await h.store.send("change direction", undefined, undefined, "steer")
  await tick()
  expect(h.store.dispositionNotice?.message).toBe("chat.steerQueued")
})

test("a prompt consumed by an extension reports the handled disposition", async () => {
  const h = await sessionHarness({ prompt: () => ({ success: true, data: { disposition: "handled" } }) })
  await h.store.send("/mycommand")
  await tick()
  expect(h.store.dispositionNotice?.message).toBe("chat.dispositionHandled")
})

test("clear removes pending prompts", async () => {
  const h = await sessionHarness()
  h.store.schedulePrompt("later", 60_000)
  expect(h.store.pendingCount).toBe(1)
  h.store.clear()
  expect(h.store.pendingCount).toBe(0)
})

test("run now sends the selected item with attachments and leaves other items in order", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  h.store.schedulePrompt("first", 60_000)
  h.store.schedulePrompt("selected", 60_000, [{ data: "YWJj", mimeType: "image/png" }], "expanded selected")
  h.store.schedulePrompt("last", 60_000)
  const id = h.store.promptQueue[1].id
  h.store.executeQueuedPrompt(id)
  h.store.executeQueuedPrompt(id) // repeated clicks must not send twice
  const prompts = h.calls.filter(c => c.type === "prompt")
  expect(prompts.length).toBe(1)
  expect(prompts[0].message).toBe("expanded selected")
  expect(prompts[0].images[0].data).toBe("YWJj")
  expect(prompts[0].streamingBehavior).toBe("steer")
  expect(h.store.promptQueue.map(item => item.text).join(",")).toBe("first,last")
})

test("run now starts an idle agent and is blocked during resend or compaction", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  h.store.schedulePrompt("selected", 60_000)
  const id = h.store.promptQueue[0].id
  h.store.isStreaming = false
  h.store.isResending = true
  h.store.executeQueuedPrompt(id)
  h.store.isResending = false
  h.store.isCompacting = true
  h.store.executeQueuedPrompt(id)
  expect(h.store.promptQueue.length).toBe(1)
  expect(h.calls.length).toBe(0)
  h.store.isCompacting = false
  h.store.executeQueuedPrompt(id)
  expect(h.store.promptQueue.length).toBe(0)
  expect(h.calls.find(c => c.type === "prompt").streamingBehavior).toBe(undefined)
})

test("queue sends only one message per run despite duplicate completion events", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  for (const text of ["/first", "/second", "/third"]) {
    await h.store.send(text, undefined, undefined, "queue")
  }
  const sent = () => h.calls.filter(c => c.type === "prompt").map(c => c.message)
  h.store.handleEvent({ type: "agent_end" })
  h.store.handleEvent({ type: "agent_settled" })
  h.store.handleEvent({ type: "agent_end" })
  h.store.dispatchQueuedPrompt()
  expect(sent()).toEqual(["/first"])
  expect(h.store.isStreaming).toBe(true)
  expect(h.store.promptQueue.length).toBe(2)

  h.store.handleEvent({ type: "agent_start" })
  expect(sent()).toEqual(["/first"])
  h.store.handleEvent({ type: "agent_end" })
  h.store.handleEvent({ type: "agent_settled" })
  expect(sent()).toEqual(["/first", "/second"])
  expect(h.store.promptQueue.length).toBe(1)

  h.store.handleEvent({ type: "agent_start" })
  h.store.handleEvent({ type: "agent_settled" })
  expect(sent()).toEqual(["/first", "/second", "/third"])
  expect(h.store.promptQueue.length).toBe(0)
  expect(h.calls.filter(c => c.type === "prompt").every(c => !c.streamingBehavior)).toBeTruthy()
})

test("delayed prompts wait until due and do not block ready prompts", async () => {
  const h = await sessionHarness()
  h.store.schedulePrompt("later", 60_000)
  expect(h.calls.length).toBe(0)
  h.store.dispatchQueuedPrompt()
  expect(h.calls.length).toBe(0)
  h.store.isStreaming = true
  await h.store.send("/ready", undefined, undefined, "queue")
  h.store.isStreaming = false
  h.store.dispatchQueuedPrompt()
  expect(h.calls.find(c => c.type === "prompt").message).toBe("/ready")
  expect(h.store.promptQueue[0].text).toBe("later")
  h.store.clear()
})

test("delayed prompts automatically dispatch with images and expanded text", async () => {
  const h = await sessionHarness()
  h.store.schedulePrompt("later", 10, [{ data: "image", mimeType: "image/png" }], "expanded")
  await new Promise(resolve => setTimeout(resolve, 180))
  const prompt = h.calls.find(c => c.type === "prompt")
  expect(prompt.message).toBe("expanded")
  expect(prompt.images[0].data).toBe("image")
  expect(h.store.promptQueue.length).toBe(0)
})

test("delayed prompts reject invalid delays and can be cancelled or executed early", async () => {
  const h = await sessionHarness()
  for (const delay of [0, -1, NaN, Infinity, 366 * 86400000]) {
    expect(() => h.store.schedulePrompt("later", delay)).toThrow()
  }
  h.store.schedulePrompt("cancel", 60_000)
  h.store.removeQueuedPrompt(h.store.promptQueue[0].id)
  h.store.schedulePrompt("now", 60_000)
  h.store.executeQueuedPrompt(h.store.promptQueue[0].id)
  expect(h.calls.find(c => c.type === "prompt").message).toBe("now")
  expect(h.store.promptQueue.length).toBe(0)
})

test("a delayed prompt stays queued while busy and clear cancels its timer", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  h.store.schedulePrompt("later", 10)
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
  expect(h.store.promptQueue.length).toBe(1)
  h.store.clear()
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
})

test("a compact command queues behind the active run and executes on settle", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  await h.store.send("/compact keep decisions", undefined, undefined, "queue")
  expect(h.calls.length).toBe(0)
  expect(h.store.promptQueue.length).toBe(1)
  h.store.handleEvent({ type: "agent_end" })
  h.store.handleEvent({ type: "agent_settled" })
  const compact = h.calls.find(c => c.type === "compact")
  expect(compact.customInstructions).toBe("keep decisions")
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
  expect(h.store.promptQueue.length).toBe(0)
  expect(h.store.isCompacting).toBe(true)
})

test("a compact command never steers into the running agent", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  await h.store.send("/compact", undefined, undefined, "steer")
  expect(h.calls.length).toBe(0)
  expect(h.store.promptQueue.map(item => item.text).join(",")).toBe("/compact")
})

test("queued prompts continue after a queued compact finishes", async () => {
  const h = await sessionHarness()
  h.store.isStreaming = true
  await h.store.send("/compact", undefined, undefined, "queue")
  await h.store.send("/next question", undefined, undefined, "queue")
  h.store.handleEvent({ type: "agent_settled" })
  expect(h.calls.filter(c => c.type === "compact").length).toBe(1)
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
  expect(h.store.promptQueue.length).toBe(1)
  h.store.handleEvent({ type: "compaction_end", result: null, aborted: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.calls.find(c => c.type === "prompt").message).toBe("/next question")
  expect(h.store.promptQueue.length).toBe(0)
})

test("compaction_end syncs the session file mtime so the watcher stays quiet", async () => {
  const h = await sessionHarness()
  expect(h.store.syncedSessionMtime).toBe(null)
  h.store.handleEvent({ type: "compaction_end", result: null, aborted: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.store.syncedSessionMtime).toBe(12345)
})

test("compaction_end appends a visible marker with token stats; aborted runs add none", async () => {
  const h = await sessionHarness()
  h.store.handleEvent({
    type: "compaction_end",
    result: { summary: "collapsed", tokensBefore: 100000, estimatedTokensAfter: 30000 },
  })
  const marker = h.store.entries.at(-1)
  expect(marker.kind).toBe("compaction")
  expect(marker.summary).toBe("collapsed")
  expect(marker.tokensBefore).toBe(100000)
  expect(marker.tokensAfter).toBe(30000)
  h.store.handleEvent({ type: "compaction_end", result: null, aborted: true })
  expect(h.store.entries.filter(e => e.kind === "compaction").length).toBe(1)
})

test("scheduled conversations render the submitted prompt and live output without sending it again", async () => {
  const h = await sessionHarness()
  h.store.handleEvent({ type: "scheduled_session_created", prompt: "Inspect the project" })
  expect(h.store.entries[0].text).toBe("Inspect the project")
  expect(h.store.isStreaming).toBe(true)
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
  h.store.handleEvent({ type: "agent_start" })
  h.store.handleEvent({ type: "message_start", message: { role: "assistant" } })
  h.store.handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } })
  h.store.handleEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working" },
  })
  expect(h.store.partialBlocks[0].text).toBe("Working")
  h.store.handleEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
  })
  h.store.handleEvent({ type: "agent_settled" })
  expect(h.store.isStreaming).toBe(false)
  expect(h.store.entries[1].blocks[0].text).toBe("Done")
})

test("scheduled preflight rejection releases the conversation for user continuation", async () => {
  const h = await sessionHarness()
  h.store.handleEvent({ type: "scheduled_session_created", prompt: "Inspect" })
  h.store.handleEvent({ type: "scheduled_session_failed", error: "Model unavailable" })
  expect(h.store.isStreaming).toBe(false)
  expect(h.store.entries[1].blocks[0].text).toMatch(/Model unavailable/)
})
