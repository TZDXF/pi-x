import { test, expect } from "vitest"
import { contentModule, loadTsModule } from "./lib/load-ts.mjs"

function loadStore(name, modules) {
  const exports = loadTsModule(new URL(`../src/stores/${name}.ts`, import.meta.url), id => modules[id], {
    setTimeout,
    clearTimeout,
    console: { warn() {}, error() {} },
    localStorage: { getItem: () => null },
  })
  // session.ts: factory (runtimeId => store); workspace.ts: plain store fn.
  const factory = exports.createSessionStore ?? exports.createUiStore
  const store = factory ? factory("default")() : Object.values(exports)[0]()
  return store
}
const framework = {
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
}
function sessionHarness() {
  const calls = [],
    previews = [],
    titles = [],
    refreshed = []
  let finish, fail
  const api = {
    pixLog() {},
    rpcRequest: command => {
      calls.push(command)
      return new Promise(() => {})
    },
    sessionMtime: async () => 12345,
    generateSessionTitle: (...args) => {
      calls.push({ type: "title", args })
      return new Promise((resolve, reject) => {
        finish = resolve
        fail = reject
      })
    },
  }
  const store = loadStore("session", {
    ...framework,
    "@/lib/checkpoints": {
      createCheckpoint: async () => ({ refName: "r", commitOid: "oid" }),
      diffCheckpoints: async () => [],
      loadCheckpointManifest: async () => null,
      saveCheckpointManifest: async () => {},
    },
    "@/stores/sessionRunStatus": { setSessionRunStatus() {} },
    "@/i18n": { i18n: { global: { t: key => key } }, tBackendError: value => String(value ?? "") },
    "@/lib/content": contentModule(),
    "@/api/piClient": { sessionHistory: async () => [], ...api },
    "@/lib/notifications": { notifyTurnComplete() {} },
    "@/stores/workspace": {
      useWorkspaceStore: () => ({
        histories: {},
        projectName: () => "project",
        preview: row => previews.push(row),
        generatedTitle: (...args) => titles.push(args),
        refresh: async path => refreshed.push(path),
      }),
    },
  })
  store.state.value = { sessionId: "one", messageCount: 0 }
  store.sessionFile.value = "one.jsonl"
  store.cwd.value = "project-one"
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

test("queue waits until settled, preserving images and expanded text", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  const images = [{ data: "YWJj", mimeType: "image/png" }]
  await h.store.send("next", images, "expanded next", "queue")
  expect(h.calls.length).toBe(0)
  expect(h.store.entries.value.length).toBe(0)
  expect(h.store.pendingCount.value).toBe(1)
  h.store.handleEvent({ type: "agent_end" })
  h.store.handleEvent({ type: "agent_settled" })
  const prompts = h.calls.filter(c => c.type === "prompt")
  expect(prompts.length).toBe(1)
  expect(prompts[0].message).toBe("expanded next")
  expect(prompts[0].images[0].data).toBe("YWJj")
  expect(prompts[0].streamingBehavior).toBe(undefined)
  expect(h.store.promptQueue.value.length).toBe(0)
})

test("reorder and remove use stable IDs, including identical prompts", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  for (const text of ["same", "same", "third"]) await h.store.send(text, undefined, undefined, "queue")
  const [a, b, c] = h.store.promptQueue.value.map(item => item.id)
  h.store.moveQueuedPrompt(c, a)
  expect(h.store.promptQueue.value[0].id).toBe(c)
  expect(h.store.removeQueuedPrompt(b).text).toBe("same")
  h.store.moveQueuedPrompt(b, a) // stale drag must not remove another item
  expect(h.store.promptQueue.value.length).toBe(2)
  h.store.handleEvent({ type: "agent_settled" })
  expect(h.calls.find(c => c.type === "prompt").message).toBe("third")
  expect(h.store.promptQueue.value[0].id).toBe(a)
  h.store.dispatchQueuedPrompt() // must not send while the new run is starting
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(1)
})

test("steering goes to the running agent without draining the queue", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  await h.store.send("later", undefined, undefined, "queue")
  await h.store.send("change direction", undefined, undefined, "steer")
  expect(h.calls[0].streamingBehavior).toBe("steer")
  expect(h.calls[0].message).toBe("change direction")
  expect(h.store.promptQueue.value.length).toBe(1)
})

test("clear removes pending prompts", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  await h.store.send("later", undefined, undefined, "queue")
  h.store.clear()
  expect(h.store.pendingCount.value).toBe(0)
})

test("run now sends the selected item with attachments and leaves other items in order", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  const images = [{ data: "YWJj", mimeType: "image/png" }]
  await h.store.send("first", undefined, undefined, "queue")
  await h.store.send("selected", images, "expanded selected", "queue")
  await h.store.send("last", undefined, undefined, "queue")
  const id = h.store.promptQueue.value[1].id
  h.store.executeQueuedPrompt(id)
  h.store.executeQueuedPrompt(id) // repeated clicks must not send twice
  const prompts = h.calls.filter(c => c.type === "prompt")
  expect(prompts.length).toBe(1)
  expect(prompts[0].message).toBe("expanded selected")
  expect(prompts[0].images[0].data).toBe("YWJj")
  expect(prompts[0].streamingBehavior).toBe("steer")
  expect(h.store.promptQueue.value.map(item => item.text).join(",")).toBe("first,last")
})

test("run now starts an idle agent and is blocked during resend or compaction", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  await h.store.send("selected", undefined, undefined, "queue")
  const id = h.store.promptQueue.value[0].id
  h.store.isStreaming.value = false
  h.store.isResending.value = true
  h.store.executeQueuedPrompt(id)
  h.store.isResending.value = false
  h.store.isCompacting.value = true
  h.store.executeQueuedPrompt(id)
  expect(h.store.promptQueue.value.length).toBe(1)
  expect(h.calls.length).toBe(0)
  h.store.isCompacting.value = false
  h.store.executeQueuedPrompt(id)
  expect(h.store.promptQueue.value.length).toBe(0)
  expect(h.calls.find(c => c.type === "prompt").streamingBehavior).toBe(undefined)
})

test("queue sends only one message per run despite duplicate completion events", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  for (const text of ["first", "second", "third"]) {
    await h.store.send(text, undefined, undefined, "queue")
  }
  const sent = () => h.calls.filter(c => c.type === "prompt").map(c => c.message)
  h.store.handleEvent({ type: "agent_end" })
  h.store.handleEvent({ type: "agent_settled" })
  h.store.handleEvent({ type: "agent_end" })
  h.store.dispatchQueuedPrompt()
  expect(sent()).toEqual(["first"])
  expect(h.store.isStreaming.value).toBe(true)
  expect(h.store.promptQueue.value.length).toBe(2)

  h.store.handleEvent({ type: "agent_start" })
  expect(sent()).toEqual(["first"])
  h.store.handleEvent({ type: "agent_end" })
  h.store.handleEvent({ type: "agent_settled" })
  expect(sent()).toEqual(["first", "second"])
  expect(h.store.promptQueue.value.length).toBe(1)

  h.store.handleEvent({ type: "agent_start" })
  h.store.handleEvent({ type: "agent_settled" })
  expect(sent()).toEqual(["first", "second", "third"])
  expect(h.store.promptQueue.value.length).toBe(0)
  expect(h.calls.filter(c => c.type === "prompt").every(c => !c.streamingBehavior)).toBeTruthy()
})

test("delayed prompts wait until due and do not block ready prompts", async () => {
  const h = sessionHarness()
  h.store.schedulePrompt("later", 60_000)
  expect(h.calls.length).toBe(0)
  h.store.dispatchQueuedPrompt()
  expect(h.calls.length).toBe(0)
  h.store.isStreaming.value = true
  await h.store.send("ready", undefined, undefined, "queue")
  h.store.isStreaming.value = false
  h.store.dispatchQueuedPrompt()
  expect(h.calls.find(c => c.type === "prompt").message).toBe("ready")
  expect(h.store.promptQueue.value[0].text).toBe("later")
  h.store.clear()
})

test("delayed prompts automatically dispatch with images and expanded text", async () => {
  const h = sessionHarness()
  h.store.schedulePrompt("later", 10, [{ data: "image", mimeType: "image/png" }], "expanded")
  await new Promise(resolve => setTimeout(resolve, 180))
  const prompt = h.calls.find(c => c.type === "prompt")
  expect(prompt.message).toBe("expanded")
  expect(prompt.images[0].data).toBe("image")
  expect(h.store.promptQueue.value.length).toBe(0)
})

test("delayed prompts reject invalid delays and can be cancelled or executed early", () => {
  const h = sessionHarness()
  for (const delay of [0, -1, NaN, Infinity, 366 * 86400000]) {
    expect(() => h.store.schedulePrompt("later", delay)).toThrow()
  }
  h.store.schedulePrompt("cancel", 60_000)
  h.store.removeQueuedPrompt(h.store.promptQueue.value[0].id)
  h.store.schedulePrompt("now", 60_000)
  h.store.executeQueuedPrompt(h.store.promptQueue.value[0].id)
  expect(h.calls.find(c => c.type === "prompt").message).toBe("now")
  expect(h.store.promptQueue.value.length).toBe(0)
})

test("a delayed prompt stays queued while busy and clear cancels its timer", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  h.store.schedulePrompt("later", 10)
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
  expect(h.store.promptQueue.value.length).toBe(1)
  h.store.clear()
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
})

test("a compact command queues behind the active run and executes on settle", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  await h.store.send("/compact keep decisions", undefined, undefined, "queue")
  expect(h.calls.length).toBe(0)
  expect(h.store.promptQueue.value.length).toBe(1)
  h.store.handleEvent({ type: "agent_end" })
  h.store.handleEvent({ type: "agent_settled" })
  const compact = h.calls.find(c => c.type === "compact")
  expect(compact.customInstructions).toBe("keep decisions")
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
  expect(h.store.promptQueue.value.length).toBe(0)
  expect(h.store.isCompacting.value).toBe(true)
})

test("a compact command never steers into the running agent", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  await h.store.send("/compact", undefined, undefined, "steer")
  expect(h.calls.length).toBe(0)
  expect(h.store.promptQueue.value.map(item => item.text).join(",")).toBe("/compact")
})

test("queued prompts continue after a queued compact finishes", async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  await h.store.send("/compact", undefined, undefined, "queue")
  await h.store.send("next question", undefined, undefined, "queue")
  h.store.handleEvent({ type: "agent_settled" })
  expect(h.calls.filter(c => c.type === "compact").length).toBe(1)
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
  expect(h.store.promptQueue.value.length).toBe(1)
  h.store.handleEvent({ type: "compaction_end", result: null, aborted: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.calls.find(c => c.type === "prompt").message).toBe("next question")
  expect(h.store.promptQueue.value.length).toBe(0)
})

test("compaction_end syncs the session file mtime so the watcher stays quiet", async () => {
  const h = sessionHarness()
  expect(h.store.syncedSessionMtime.value).toBe(null)
  h.store.handleEvent({ type: "compaction_end", result: null, aborted: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.store.syncedSessionMtime.value).toBe(12345)
})

test("compaction_end appends a visible marker with token stats; aborted runs add none", async () => {
  const h = sessionHarness()
  h.store.handleEvent({
    type: "compaction_end",
    result: { summary: "collapsed", tokensBefore: 100000, estimatedTokensAfter: 30000 },
  })
  const marker = h.store.entries.value.at(-1)
  expect(marker.kind).toBe("compaction")
  expect(marker.summary).toBe("collapsed")
  expect(marker.tokensBefore).toBe(100000)
  expect(marker.tokensAfter).toBe(30000)
  h.store.handleEvent({ type: "compaction_end", result: null, aborted: true })
  expect(h.store.entries.value.filter(e => e.kind === "compaction").length).toBe(1)
})

test("scheduled conversations render the submitted prompt and live output without sending it again", () => {
  const h = sessionHarness()
  h.store.handleEvent({ type: "scheduled_session_created", prompt: "Inspect the project" })
  expect(h.store.entries.value[0].text).toBe("Inspect the project")
  expect(h.store.isStreaming.value).toBe(true)
  expect(h.calls.filter(c => c.type === "prompt").length).toBe(0)
  h.store.handleEvent({ type: "agent_start" })
  h.store.handleEvent({ type: "message_start", message: { role: "assistant" } })
  h.store.handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } })
  h.store.handleEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working" },
  })
  expect(h.store.partialBlocks.value[0].text).toBe("Working")
  h.store.handleEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
  })
  h.store.handleEvent({ type: "agent_settled" })
  expect(h.store.isStreaming.value).toBe(false)
  expect(h.store.entries.value[1].blocks[0].text).toBe("Done")
})

test("scheduled preflight rejection releases the conversation for user continuation", () => {
  const h = sessionHarness()
  h.store.handleEvent({ type: "scheduled_session_created", prompt: "Inspect" })
  h.store.handleEvent({ type: "scheduled_session_failed", error: "Model unavailable" })
  expect(h.store.isStreaming.value).toBe(false)
  expect(h.store.entries.value[1].blocks[0].text).toMatch(/Model unavailable/)
})
