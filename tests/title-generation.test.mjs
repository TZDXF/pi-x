import { test, expect } from "vitest"
import { contentModule, loadTsModule, pathsModule } from "./lib/load-ts.mjs"

function loadStore(name, modules) {
  const exports = loadTsModule(new URL(`../src/stores/${name}.ts`, import.meta.url), id => modules[id], {
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
  }
  const store = loadStore("session", {
    ...framework,
    "@/stores/sessionRunStatus": { setSessionRunStatus() {} },
    "@/i18n": { i18n: { global: { t: key => key } } },
    "@/lib/content": contentModule(),
    "@/lib/checkpoints": {
      createCheckpoint: async () => ({ refName: "r", commitOid: "oid" }),
      diffCheckpoints: async () => [],
      loadCheckpointManifest: async () => null,
      saveCheckpointManifest: async () => {},
    },
    "@/api/piClient": api,
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
const tick = () => new Promise(resolve => setImmediate(resolve))

test("first message is visible immediately; title is independent of unfinished conversation", async () => {
  const h = sessionHarness()
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
  const h = sessionHarness()
  await h.store.send("first")
  await h.store.send("second")
  expect(h.calls.filter(c => c.type === "title").length).toBe(1)
})
test("switching sessions while generating keeps the result attached to the original file", async () => {
  const h = sessionHarness()
  await h.store.send("first")
  h.store.sessionFile.value = "two.jsonl"
  h.store.cwd.value = "project-two"
  h.finish("First title")
  await tick()
  expect(h.titles).toEqual([["one.jsonl", "First title"]])
  expect(h.refreshed).toEqual(["project-one"])
})
test("failure leaves preview intact and does not add an error to the conversation", async () => {
  const h = sessionHarness()
  await h.store.send("first")
  h.fail()
  await tick()
  expect(h.titles.length).toBe(0)
  expect(h.previews[0].preview).toBe("first")
  expect(h.store.entries.value.length).toBe(1)
})
test("resumed nonempty sessions do not generate new titles", async () => {
  const h = sessionHarness()
  h.store.state.value.messageCount = 5
  await h.store.send("continue")
  expect(h.calls.filter(c => c.type === "title").length).toBe(0)
})
test("workspace preserves previews before pi persists and does not overwrite manual titles", async () => {
  let disk = []
  const store = loadStore("workspace", {
    ...framework,
    "@/lib/paths": pathsModule(),
    "@/api/piClient": {
      sessionHistory: async () => [],
      pixLog() {},
      listSessions: async () => disk,
      updateSession: async () => {},
    },
  })
  store.preview({ file: "one", cwd: "project", preview: "first", mtimeMs: 1 })
  await store.refresh("project")
  expect(store.histories.value.project[0].preview).toBe("first")
  store.generatedTitle("one", "Generated")
  expect(store.histories.value.project[0].title).toBe("Generated")
  await store.update(store.histories.value.project[0], "Manual", true)
  store.generatedTitle("one", "Late generated title")
  expect(store.histories.value.project[0].title).toBe("Manual")
  disk = [{ file: "one", cwd: "project", title: "Manual", archived: true, mtimeMs: 2 }]
  await store.refresh("project")
  expect(store.histories.value.project.length).toBe(1)
  expect(store.histories.value.project[0].archived).toBe(true)
})
