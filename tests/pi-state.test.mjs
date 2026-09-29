import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadTsModule, loadTsSource } from "./lib/load-ts.mjs"

function harness(storage = new Map(), options = {}) {
  const calls = []
  let mtime = 0
  const state = {
    model: { provider: "restored", id: "session-model", reasoning: true },
    thinkingLevel: "low",
    ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
  }
  const modules = {
    "@/lib/thinkingLevels": loadTsSource(
      readFileSync(new URL("../src/lib/thinkingLevels.ts", import.meta.url), "utf8"),
    ),
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
    "@/stores/sessionRunStatus": { setSessionRunStatus() {} },
    "@/i18n": { i18n: { global: { t: key => key } } },
    "@/stores/workspace": { useWorkspaceStore: () => ({ histories: {}, projectName: () => "project" }) },
    "@/lib/notifications": { notifyTurnComplete() {} },
    "@/api/piClient": {
      sessionHistory: async () => [],
      pixLog() {},
      getModelsConfig: async () => ({ providers: { pi: { models: [{ id: "default", reasoning: true }] } } }),
      getPiSettings: async () => ({
        defaultProvider: "pi",
        defaultModel: "default",
        defaultThinkingLevel: "high",
        skills: [],
      }),
      sessionMtime: async file => {
        calls.push({ type: "session_mtime", file })
        return mtime
      },
      rpcRequest: async command => {
        calls.push(command)
        if (command.type === "set_model" || command.type === "set_thinking_level") mtime++
        if (command.type === "set_model") state.model = { provider: command.provider, id: command.modelId }
        if (command.type === "set_thinking_level") state.thinkingLevel = command.level
        const data =
          command.type === "get_state"
            ? state
            : command.type === "get_available_models"
              ? { models: [] }
              : command.type === "get_available_thinking_levels"
                ? { levels: ["off", "low", "high"] }
                : command.type === "get_commands"
                  ? { commands: [] }
                  : {}
        return { success: true, data }
      },
    },
  }
  const { createSessionStore } = loadTsModule(new URL("../src/stores/session.ts", import.meta.url), id => modules[id], {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  })
  return { store: createSessionStore("default")(), calls, state, storage }
}

test("Pi defaults are displayed offline but never overwrite a restored session", async () => {
  const { store, calls, state } = harness()
  await store.loadOfflineModels()
  expect(store.offlineDefaultModelKey.value).toBe("pi/default")
  expect(store.desiredModelKey.value).toBe(null)
  expect(store.desiredThinkingLevel.value).toBe(null)
  await store.init("project")
  expect(state.model.provider).toBe("restored")
  expect(state.thinkingLevel).toBe("low")
  expect(calls.some(c => c.type === "set_model" || c.type === "set_thinking_level")).toBe(false)
})

test("explicit choices persist for fresh conversations but never overwrite restored sessions", async () => {
  const { store, calls } = harness()
  store.setDesiredModel("chosen/vendor/model")
  store.setDesiredThinkingLevel("high")
  await store.init("project", true)
  expect(calls.filter(c => c.type === "set_model").length).toBe(1)
  expect(calls.find(c => c.type === "set_model").modelId).toBe("vendor/model")
  expect(calls.filter(c => c.type === "set_thinking_level").length).toBe(1)
  expect(store.desiredModelKey.value).toBe(null)
  expect(store.desiredThinkingLevel.value).toBe(null)
  await store.init("other-project")
  expect(calls.filter(c => c.type === "set_model").length).toBe(1)
  expect(calls.filter(c => c.type === "set_thinking_level").length).toBe(1)
})

test("model and thinking selection survive restarting the UI and are visible before Pi starts", async () => {
  const storage = new Map()
  const first = harness(storage)
  await first.store.setModel("chosen", "vendor/model")
  await first.store.setThinkingLevel("high")
  const next = harness(storage)
  expect(next.store.offlineDefaultModelKey.value).toBe("chosen/vendor/model")
  expect(next.store.thinkingLevel.value).toBe("high")
  expect(next.store.models.value[0].id).toBe("vendor/model")
  await next.store.loadOfflineModels()
  expect(next.store.models.value.some(m => m.id === "vendor/model")).toBeTruthy()
  await next.store.init("new-project", true)
  expect(next.state.model.provider).toBe("chosen")
  expect(next.state.thinkingLevel).toBe("high")
})

test("new_session reapplies remembered choices without changing a resumed session first", async () => {
  const storage = new Map()
  const first = harness(storage)
  await first.store.setModel("chosen", "vendor/model")
  await first.store.setThinkingLevel("high")
  const next = harness(storage)
  await next.store.init("resumed-project")
  expect(next.state.model.provider).toBe("restored")
  expect(next.state.thinkingLevel).toBe("low")
  await next.store.newSession()
  expect(next.state.model.provider).toBe("chosen")
  expect(next.state.thinkingLevel).toBe("high")
})

test("corrupt browser preference does not block loading Pi defaults", async () => {
  const h = harness(new Map([["pix.conversationSelection", "{bad"]]))
  await h.store.loadOfflineModels()
  expect(h.store.offlineDefaultModelKey.value).toBe("pi/default")
})

test("model and thinking changes mark their session-file writes before refreshing state", async () => {
  const { store, calls } = harness(new Map(), { sessionFile: "session.jsonl" })
  await store.init("project")
  calls.length = 0
  await store.setModel("chosen", "vendor/model")
  expect(store.syncedSessionMtime.value).toBe(1)
  expect(calls.slice(0, 3).map(c => c.type)).toEqual(["set_model", "session_mtime", "get_state"])
  expect(calls[1].file).toBe("session.jsonl")

  calls.length = 0
  await store.setThinkingLevel("high")
  expect(store.syncedSessionMtime.value).toBe(2)
  expect(calls.slice(0, 3).map(c => c.type)).toEqual(["set_thinking_level", "session_mtime", "get_state"])
})

test("a model switch is announced before the next question, without changing the prompt sent to Pi", async () => {
  const { store, calls } = harness()
  await store.init("project")
  store.started.value = true
  await store.setModel("first", "model-a")
  await store.setModel("next", "model-b")
  store.isStreaming.value = true
  await store.send("queued question", undefined, undefined, "queue")
  expect(store.entries.value.length).toBe(0)
  store.isStreaming.value = false
  store.dispatchQueuedPrompt()
  const first = store.entries.value[0]
  expect(JSON.parse(JSON.stringify(first.modelChange))).toEqual({
    from: "restored/session-model",
    to: "next/model-b",
  })
  expect(calls.findLast(c => c.type === "prompt").message).toBe("queued question")
  await store.send("another question")
  expect(store.entries.value[1].modelChange).toBe(undefined)
  await store.setModel("next", "model-b")
  await store.send("same model")
  expect(store.entries.value[2].modelChange).toBe(undefined)
})

test("new sessions do not inherit an unconsumed model-change announcement", async () => {
  const { store } = harness()
  await store.init("project")
  store.started.value = true
  await store.setModel("next", "model-b")
  await store.newSession()
  await store.send("new conversation")
  expect(store.entries.value[0].modelChange).toBe(undefined)
})
