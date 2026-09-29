import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const controls = vi.hoisted(() => {
  const state = {}
  return {
    state,
    piClient: {
      listSessions: (...args) => state.listSessions(...args),
      updateSession: (...args) => state.updateSession(...args),
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
  createCheckpoint: async () => ({ refName: "r", commitOid: "oid" }),
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

const tick = () => new Promise(resolve => setImmediate(resolve))

async function sessionHarness() {
  const calls = [],
    previews = [],
    titles = [],
    refreshed = []
  let finish, fail
  Object.assign(controls.state, {
    sessionHistory: async () => [],
    sessionLastError: async () => null,
    sessionMtime: async () => 0,
    pixLog() {},
    rpcRequest: command => {
      calls.push(command)
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

test("first message is visible immediately; title is independent of unfinished conversation", async () => {
  const h = await sessionHarness()
  await h.store.send("Fix login\nplease")
  expect(h.previews[0].preview).toBe("Fix login please")
  expect(h.calls[0].type).toBe("prompt")
  expect(h.calls[1].type).toBe("title")
  expect(h.titles.length).toBe(0)
  h.finish("Login fix")
  await tick()
  expect(h.titles).toEqual([["one.jsonl", "Login fix"]])
})
test("subsequent messages never trigger a second title request", async () => {
  const h = await sessionHarness()
  await h.store.send("first")
  await h.store.send("second")
  expect(h.calls.filter(c => c.type === "title").length).toBe(1)
})
test("switching sessions while generating keeps the result attached to the original file", async () => {
  const h = await sessionHarness()
  await h.store.send("first")
  h.store.sessionFile = "two.jsonl"
  h.store.cwd = "project-two"
  h.finish("First title")
  await tick()
  expect(h.titles).toEqual([["one.jsonl", "First title"]])
  expect(h.refreshed).toEqual(["project-one"])
})
test("failure leaves preview intact and does not add an error to the conversation", async () => {
  const h = await sessionHarness()
  await h.store.send("first")
  h.fail()
  await tick()
  expect(h.titles.length).toBe(0)
  expect(h.previews[0].preview).toBe("first")
  expect(h.store.entries.length).toBe(1)
})
test("resumed nonempty sessions do not generate new titles", async () => {
  const h = await sessionHarness()
  h.store.state.messageCount = 5
  await h.store.send("continue")
  expect(h.calls.filter(c => c.type === "title").length).toBe(0)
})
test("workspace preserves previews before pi persists and does not overwrite manual titles", async () => {
  let disk = []
  Object.assign(controls.state, {
    listSessions: async () => disk,
    updateSession: async () => {},
  })
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  setActivePinia(createPinia())
  vi.resetModules()
  const { useWorkspaceStore } = await vi.importActual("@/stores/workspace")
  const store = useWorkspaceStore()
  store.preview({ file: "one", cwd: "project", preview: "first", mtimeMs: 1 })
  await store.refresh("project")
  expect(store.histories.project[0].preview).toBe("first")
  store.generatedTitle("one", "Generated")
  expect(store.histories.project[0].title).toBe("Generated")
  await store.update(store.histories.project[0], "Manual", true)
  store.generatedTitle("one", "Late generated title")
  expect(store.histories.project[0].title).toBe("Manual")
  disk = [{ file: "one", cwd: "project", title: "Manual", archived: true, mtimeMs: 2 }]
  await store.refresh("project")
  expect(store.histories.project.length).toBe(1)
  expect(store.histories.project[0].archived).toBe(true)
})
