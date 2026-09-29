import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
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

const source = path => readFileSync(new URL(path, import.meta.url), "utf8")
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function harness(overrides = {}) {
  const calls = []
  const state = {
    sessionId: "current",
    sessionFile: "current.jsonl",
    messageCount: 2,
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
  }
  Object.assign(controls.state, {
    sessionHistory: async () => [],
    sessionLastError: async () => null,
    sessionMtime: async () => 1,
    pixLog() {},
    rpcRequest: async command => {
      calls.push(command)
      if (overrides[command.type]) return overrides[command.type](command)
      return { success: true, data: command.type === "get_state" ? state : {} }
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
  const store = createSessionStore("editing")()
  store.state = state
  store.sessionFile = state.sessionFile
  store.entries = [{ kind: "user", id: 1, text: "original" }]
  return { store, calls, state }
}

test("running prompt: waits for abort, then resends in the same session with images", async () => {
  let finishAbort
  const h = await harness({
    abort: () =>
      new Promise(resolve => {
        finishAbort = resolve
      }),
  })
  h.store.isStreaming = true
  const images = [{ data: "YWJj", mimeType: "image/png" }]
  const pending = h.store.resendPrompt("revised", images, "revised expanded")
  await tick()
  expect(h.calls.map(call => call.type)).toEqual(["clear_queue", "abort"])
  expect(h.store.isResending).toBe(true)
  finishAbort({ success: true })
  await pending
  expect(h.calls.slice(0, 5).map(call => call.type)).toEqual([
    "clear_queue",
    "abort",
    "get_state",
    "rewind_prompt",
    "prompt",
  ])
  const prompt = h.calls.find(call => call.type === "prompt")
  expect(prompt.message).toBe("revised expanded")
  expect(prompt.streamingBehavior).toBe(undefined)
  expect(prompt.images[0].data).toBe("YWJj")
  expect(h.store.sessionFile).toBe("current.jsonl")
  expect(h.store.entries.length).toBe(1)
  expect(h.store.entries[0].id).toBe(1)
  expect(h.store.entries[0].text).toBe("revised")
  expect(h.store.isStreaming).toBe(true)
  expect(h.store.isResending).toBe(false)
  expect(
    h.calls.every(
      call => !["fork", "get_fork_messages", "get_messages", "new_session", "switch_session"].includes(call.type),
    ),
  ).toBeTruthy()
})

test("agent-end during abort cannot dispatch queued prompts ahead of the edited question", async () => {
  const h = await harness({
    clear_queue: async () => ({ success: true, data: { steering: ["remote queued"] } }),
    abort: async () => {
      h.store.handleEvent({ type: "agent_end" })
      return { success: true }
    },
  })
  h.store.isStreaming = true
  await h.store.send("local queued", undefined, undefined, "queue")
  await h.store.resendPrompt("revised")
  expect(h.calls.filter(call => call.type === "prompt").map(call => call.message)).toEqual(["revised"])
  expect(Array.from(h.store.promptQueue, item => item.text)).toEqual(["remote queued", "local queued"])
})

for (const [label, overrides] of [
  ["rewind rejected", { rewind_prompt: async () => ({ success: false, error: "cannot rewind" }) }],
  ["abort rejected", { abort: async () => ({ success: false, error: "cannot abort" }) }],
  [
    "process exits",
    {
      abort: async () => {
        throw new Error("pi exited before responding")
      },
    },
  ],
  ["queue clear rejected", { clear_queue: async () => ({ success: false, error: "cannot clear queue" }) }],
  ["still running", { get_state: async () => ({ success: true, data: { isStreaming: true } }) }],
  ["different session", { get_state: async () => ({ success: true, data: { sessionFile: "other.jsonl" } }) }],
]) {
  test(`${label}: does not resend or erase the current conversation`, async () => {
    const h = await harness(overrides)
    h.store.isStreaming = true
    await expect(h.store.resendPrompt("revised")).rejects.toThrow()
    expect(h.calls.some(call => call.type === "prompt")).toBe(false)
    expect(h.store.entries.length).toBe(1)
    expect(h.store.sessionFile).toBe("current.jsonl")
    expect(h.store.isResending).toBe(false)
  })
}

test("idle conversation resends without abort; empty text is ignored unless images are present", async () => {
  const h = await harness()
  await h.store.resendPrompt("   ")
  expect(h.calls.length).toBe(0)
  await h.store.resendPrompt("", [{ data: "YWJj", mimeType: "image/png" }])
  expect(h.calls.slice(0, 3).map(call => call.type)).toEqual(["get_state", "rewind_prompt", "prompt"])
})

test("duplicate clicks and a session switch during abort never submit a second question", async () => {
  let finishAbort
  const h = await harness({
    abort: () =>
      new Promise(resolve => {
        finishAbort = resolve
      }),
  })
  h.store.isStreaming = true
  const pending = h.store.resendPrompt("revised")
  await tick()
  await h.store.resendPrompt("duplicate")
  h.store.clear()
  h.store.sessionFile = "other.jsonl"
  finishAbort({ success: true })
  await expect(pending).rejects.toThrow(/editSessionChanged/)
  expect(h.calls.some(call => call.type === "prompt")).toBe(false)
  expect(h.store.isResending).toBe(false)
})

test("late rejection of the interrupted prompt cannot fail the replacement run", async () => {
  let rejectOld
  let promptCount = 0
  const h = await harness({
    prompt: () =>
      ++promptCount === 1
        ? new Promise((_, reject) => {
            rejectOld = reject
          })
        : Promise.resolve({ success: true }),
  })
  await h.store.send("old")
  await h.store.resendPrompt("revised")
  rejectOld(new Error("old run aborted"))
  await tick()
  expect(h.store.isStreaming).toBe(true)
  expect(h.store.entries.at(-1).text).toBe("revised")
})

test("edit UI allows a running answer and preserves the draft when stopping fails", () => {
  const edit = source("../src/composables/usePromptEdit.ts")
  expect(edit).not.toMatch(/session\.isStreaming|session\.isCompacting|pendingCount|type: "fork"|session\.clear\(/)
  expect(edit).toMatch(/await session\.resendPrompt[\s\S]*editedPrompt\.value = null[\s\S]*catch/)
  const app = source("../src/App.vue")
  const reload = app.slice(
    app.indexOf("async function reloadExternalConversation"),
    app.indexOf("async function selectProject"),
  )
  expect((reload.match(/owner\.isResending/g) ?? []).length).toBe(2)
})

test("only the latest question offers inline editing, and stale edits cannot be resent", () => {
  const chat = source("../src/components/ChatView.vue")
  const edit = source("../src/composables/usePromptEdit.ts")
  expect(edit).toMatch(/const lastUserPromptId = computed\(\(\) => \{[\s\S]*session\.entries\[i\]\?\.kind === "user"/)
  expect(chat).toMatch(
    /v-if="entry\.id === lastUserPromptId && editedPrompt\?\.id !== entry\.id"[^>]*@click="startEditPrompt\(entry\)"/,
  )
  expect(edit).toMatch(/if \(editBlocked\.value \|\| entry\.id !== lastUserPromptId\.value\) return/)
  expect(edit).toMatch(/if \(!entry \|\| entry\.id !== lastUserPromptId\.value \|\| editBlocked\.value/)
  expect(chat).toMatch(/v-if="editedPrompt\?\.id === entry\.id"[\s\S]*<Textarea[\s\S]*v-model="editedText"/)
  expect(chat).not.toMatch(/<Dialog :open="editedPrompt !== null"/)
})

test("starting a new session while aborting releases the resend lock without sending", async () => {
  let finishAbort
  const h = await harness({
    abort: () =>
      new Promise(resolve => {
        finishAbort = resolve
      }),
  })
  h.store.isStreaming = true
  const pending = h.store.resendPrompt("revised")
  await tick()
  await h.store.newSession()
  finishAbort({ success: true })
  await expect(pending).rejects.toThrow(/editSessionChanged/)
  expect(h.store.isResending).toBe(false)
  expect(h.calls.some(call => call.type === "prompt")).toBe(false)
})

test("editing removes the superseded answer and keeps the original question position", async () => {
  const h = await harness()
  h.store.entries.push({ kind: "assistant", id: 2, blocks: [{ type: "text", text: "old answer" }] })
  await h.store.resendPrompt("replacement")
  expect(h.store.entries.length).toBe(1)
  expect(h.store.entries[0].id).toBe(1)
  expect(h.store.entries[0].text).toBe("replacement")
})

test("editing refreshes the question timestamp so turn duration restarts", async () => {
  const h = await harness()
  const stale = Date.now() - 3_000_000
  h.store.entries[0] = { kind: "user", id: 1, text: "original", timestamp: stale }
  const before = Date.now()
  await h.store.resendPrompt("replacement")
  const timestamp = h.store.entries[0].timestamp
  expect(timestamp >= before && timestamp <= Date.now()).toBeTruthy()
  expect(timestamp).not.toBe(stale)
})
test("history prepended while rewinding does not shift the replacement target", async () => {
  const h = await harness({
    rewind_prompt: async () => {
      h.store.entries.unshift({ kind: "user", id: 99, text: "earlier question" })
      return { success: true }
    },
  })
  await h.store.resendPrompt("replacement")
  expect(Array.from(h.store.entries, entry => entry.text)).toEqual(["earlier question", "replacement"])
  expect(h.store.entries[1].id).toBe(1)
})
