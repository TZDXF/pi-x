import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const controls = vi.hoisted(() => {
  const state = {}
  return {
    state,
    piClient: {
      sessionHistory: (...args) => state.sessionHistory(...args),
      pixLog: (...args) => state.pixLog(...args),
      getModelsConfig: (...args) => state.getModelsConfig(...args),
      getPiSettings: (...args) => state.getPiSettings(...args),
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

async function harness(storage = new Map(), options = {}) {
  const calls = []
  let mtime = 0
  const state = {
    model: { provider: "restored", id: "session-model", reasoning: true },
    thinkingLevel: "low",
    ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
  }
  Object.assign(controls.state, {
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
      if (command.type === "set_follow_up_mode") state.followUpMode = command.mode
      if (command.type === "set_model" || command.type === "set_thinking_level") mtime++
      if (command.type === "set_model") state.model = { provider: command.provider, id: command.modelId }
      if (command.type === "set_thinking_level") state.thinkingLevel = command.level
      if (command.type === "set_auto_retry") state.autoRetry = command.enabled
      if (command.type === "set_auto_compaction") state.autoCompactionEnabled = command.enabled
      let cycledModel = false
      let cycledLevel = false
      if (command.type === "cycle_model" && state.nextCycleModel) {
        state.model = state.nextCycleModel
        state.nextCycleModel = null
        cycledModel = true
        mtime++
      }
      if (command.type === "cycle_thinking_level" && state.nextCycleLevel) {
        state.thinkingLevel = state.nextCycleLevel
        state.nextCycleLevel = null
        cycledLevel = true
        mtime++
      }
      const data =
        command.type === "get_state"
          ? state
          : command.type === "get_available_models"
            ? { models: [] }
            : command.type === "get_available_thinking_levels"
              ? { levels: ["off", "low", "high"] }
              : command.type === "get_commands"
                ? { commands: [] }
                : command.type === "cycle_model"
                  ? { model: cycledModel ? state.model : null, thinkingLevel: state.thinkingLevel, isScoped: false }
                  : command.type === "cycle_thinking_level"
                    ? { level: cycledLevel ? state.thinkingLevel : null }
                    : {}
      return { success: true, data }
    },
  })
  controls.workspace = { histories: {}, projectName: () => "project" }
  vi.stubGlobal("localStorage", {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  })
  setActivePinia(createPinia())
  vi.resetModules()
  const { createSessionStore } = await import("@/stores/session")
  return { store: createSessionStore("default")(), calls, state, storage, piState: controls.state }
}

test("Pi defaults are displayed offline but never overwrite a restored session", async () => {
  const { store, calls, state } = await harness()
  await store.loadOfflineModels()
  expect(store.offlineDefaultModelKey).toBe("pi/default")
  expect(store.desiredModelKey).toBe(null)
  expect(store.desiredThinkingLevel).toBe(null)
  await store.init("project")
  expect(state.model.provider).toBe("restored")
  expect(state.thinkingLevel).toBe("low")
  expect(calls.some(c => c.type === "set_model" || c.type === "set_thinking_level")).toBe(false)
})

test("explicit choices persist for fresh conversations but never overwrite restored sessions", async () => {
  const { store, calls } = await harness()
  store.setDesiredModel("chosen/vendor/model")
  store.setDesiredThinkingLevel("high")
  await store.init("project", true)
  expect(calls.filter(c => c.type === "set_model").length).toBe(1)
  expect(calls.find(c => c.type === "set_model").modelId).toBe("vendor/model")
  expect(calls.filter(c => c.type === "set_thinking_level").length).toBe(1)
  expect(store.desiredModelKey).toBe(null)
  expect(store.desiredThinkingLevel).toBe(null)
  await store.init("other-project")
  expect(calls.filter(c => c.type === "set_model").length).toBe(1)
  expect(calls.filter(c => c.type === "set_thinking_level").length).toBe(1)
})

test("model and thinking selection survive restarting the UI and are visible before Pi starts", async () => {
  const storage = new Map()
  const first = await harness(storage)
  await first.store.setModel("chosen", "vendor/model")
  await first.store.setThinkingLevel("high")
  const next = await harness(storage)
  expect(next.store.offlineDefaultModelKey).toBe("chosen/vendor/model")
  expect(next.store.thinkingLevel).toBe("high")
  expect(next.store.models[0].id).toBe("vendor/model")
  await next.store.loadOfflineModels()
  expect(next.store.models.some(m => m.id === "vendor/model")).toBeTruthy()
  await next.store.init("new-project", true)
  expect(next.state.model.provider).toBe("chosen")
  expect(next.state.thinkingLevel).toBe("high")
})

test("new_session reapplies remembered choices without changing a resumed session first", async () => {
  const storage = new Map()
  const first = await harness(storage)
  await first.store.setModel("chosen", "vendor/model")
  await first.store.setThinkingLevel("high")
  const next = await harness(storage)
  await next.store.init("resumed-project")
  expect(next.state.model.provider).toBe("restored")
  expect(next.state.thinkingLevel).toBe("low")
  await next.store.newSession()
  expect(next.state.model.provider).toBe("chosen")
  expect(next.state.thinkingLevel).toBe("high")
})

test("corrupt browser preference does not block loading Pi defaults", async () => {
  const h = await harness(new Map([["pix.conversationSelection", "{bad"]]))
  await h.store.loadOfflineModels()
  expect(h.store.offlineDefaultModelKey).toBe("pi/default")
})

test("model and thinking changes mark their session-file writes before refreshing state", async () => {
  const { store, calls } = await harness(new Map(), { sessionFile: "session.jsonl" })
  await store.init("project")
  calls.length = 0
  await store.setModel("chosen", "vendor/model")
  expect(store.syncedSessionMtime).toBe(1)
  expect(calls.slice(0, 3).map(c => c.type)).toEqual(["set_model", "session_mtime", "get_state"])
  expect(calls[1].file).toBe("session.jsonl")

  calls.length = 0
  await store.setThinkingLevel("high")
  expect(store.syncedSessionMtime).toBe(2)
  expect(calls.slice(0, 3).map(c => c.type)).toEqual(["set_thinking_level", "session_mtime", "get_state"])
})

test("a model switch is announced before the next question, without changing the prompt sent to Pi", async () => {
  const { store, calls } = await harness()
  await store.init("project")
  store.started = true
  await store.setModel("first", "model-a")
  await store.setModel("next", "model-b")
  store.isStreaming = true
  await store.send("queued question", undefined, undefined, "queue")
  await tick()
  // queued messages stay in the panel; the announcement is attached when dispatched
  expect(store.entries.length).toBe(0)
  expect(calls.some(c => c.type === "prompt" || c.type === "follow_up")).toBe(false)
  store.isStreaming = false
  store.dispatchQueuedPrompt()
  await tick()
  const first = store.entries[0]
  expect(JSON.parse(JSON.stringify(first.modelChange))).toEqual({
    from: "restored/session-model",
    to: "next/model-b",
  })
  expect(calls.findLast(c => c.type === "prompt").message).toBe("queued question")
  await store.send("another question")
  expect(store.entries[1].modelChange).toBe(undefined)
  await store.setModel("next", "model-b")
  await store.send("same model")
  expect(store.entries[2].modelChange).toBe(undefined)
})

test("new sessions do not inherit an unconsumed model-change announcement", async () => {
  const { store } = await harness()
  await store.init("project")
  store.started = true
  await store.setModel("next", "model-b")
  await store.newSession()
  await store.send("new conversation")
  expect(store.entries[0].modelChange).toBe(undefined)
})

test("built-in extension commands are flagged and their path normalized to builtin:<name>", async () => {
  const { store, calls } = await harness()
  controls.state.rpcRequest = async command => {
    calls.push(command)
    if (command.type !== "get_commands") return { success: true, data: {} }
    return {
      success: true,
      data: {
        commands: [
          // pi 0.99 names built-in extensions builtin:<name> in RPC source info.
          { name: "mcp", description: "Manage MCP servers", source: "extension", sourceInfo: { path: "builtin:mcp", scope: "temporary" } },
          { name: "codemode", description: "Run scripts", source: "extension", sourceInfo: { path: "builtin:codemode", scope: "temporary" } },
          // A third-party extension keeps a real file path.
          { name: "adapter", description: "Adapter", source: "extension", sourceInfo: { path: "/home/u/.pi/agent/extensions/pi-mcp-adapter/index.js", scope: "user" } },
          { name: "skill:review", source: "skill", sourceInfo: { path: "/home/u/.pi/agent/skills/review/SKILL.md", scope: "user" } },
        ],
      },
    }
  }
  await store.refreshCommands()
  const byName = new Map(store.commands.map(command => [command.name, command]))
  expect(byName.get("mcp").builtin).toBe(true)
  expect(byName.get("mcp").path).toBe("builtin:mcp")
  // A built-in has no user or project scope, so no location is claimed.
  expect(byName.get("mcp").location).toBe(undefined)
  expect(byName.get("adapter").builtin).toBe(false)
  expect(byName.get("adapter").location).toBe("user")
  expect(byName.get("skill:review").builtin).toBe(false)
})

test("legacy <builtin:name> command paths are normalized on read", async () => {
  const { store, calls } = await harness()
  controls.state.rpcRequest = async command => {
    calls.push(command)
    return {
      success: true,
      data: {
        commands: [
          { name: "mcp", source: "extension", sourceInfo: { path: "<builtin:mcp>", scope: "temporary" } },
          { name: "llama", source: "extension", sourceInfo: { path: "<inline:llama.cpp>", scope: "temporary" } },
        ],
      },
    }
  }
  await store.refreshCommands()
  expect(store.commands.map(command => [command.path, command.builtin])).toEqual([
    ["builtin:mcp", true],
    ["builtin:llama.cpp", true],
  ])
})

test("a configured follow-up delivery mode is pushed into the running session", async () => {
  const { store, calls, state, piState } = await harness()
  state.followUpMode = "one-at-a-time"
  piState.getPiSettings = async () => ({ skills: [], followUpMode: "all" })
  await store.init("project")
  await tick()
  const applied = calls.find(c => c.type === "set_follow_up_mode")
  expect(applied?.mode).toBe("all")
  expect(store.followUpMode).toBe("all")
})

test("setFollowUpMode updates the live mode and skips pi's default when unset", async () => {
  const { store, calls, state, piState } = await harness()
  state.followUpMode = "one-at-a-time"
  await store.init("project")
  await tick()
  expect(store.followUpMode).toBe("one-at-a-time")
  expect(calls.some(c => c.type === "set_follow_up_mode")).toBe(false)

  await store.setFollowUpMode("all")
  expect(calls.filter(c => c.type === "set_follow_up_mode").length).toBe(1)
  expect(calls.find(c => c.type === "set_follow_up_mode").mode).toBe("all")
  expect(store.followUpMode).toBe("all")

  // Matching the live mode again must not resend the command on re-init.
  piState.getPiSettings = async () => ({ skills: [], followUpMode: "all" })
  await store.init("project")
  await tick()
  expect(calls.filter(c => c.type === "set_follow_up_mode").length).toBe(1)
})

test("auto-retry is seeded from settings on init and tracks the runtime switch", async () => {
  const { store, calls, piState } = await harness()
  await store.init("project")
  await tick()
  // Unset in settings.json means pi's default (enabled) applies.
  expect(store.autoRetry).toBe(true)

  piState.getPiSettings = async () => ({ skills: [], retry: { maxRetries: 3, enabled: false } })
  await store.init("project")
  await tick()
  expect(store.autoRetry).toBe(false)

  calls.length = 0
  await store.setAutoRetry(true)
  expect(calls.map(c => c.type)).toEqual(["set_auto_retry"])
  expect(store.autoRetry).toBe(true)
})

test("set_auto_retry / set_auto_compaction failures surface and keep the recorded switch", async () => {
  const { store, calls } = await harness()
  await store.init("project")
  calls.length = 0
  controls.state.rpcRequest = async command => {
    calls.push(command)
    return { success: false, error: "not supported" }
  }
  await expect(store.setAutoRetry(false)).rejects.toThrow("not supported")
  expect(store.autoRetry).toBe(true)
  await expect(store.setAutoCompaction(false)).rejects.toThrow("not supported")
  expect(calls.filter(c => c.type === "set_auto_compaction").length).toBe(1)
})

test("set_auto_compaction sends the command and re-reads the authoritative state", async () => {
  const { store, calls } = await harness()
  await store.init("project")
  calls.length = 0
  await store.setAutoCompaction(false)
  expect(calls[0].type).toBe("set_auto_compaction")
  expect(calls[0].enabled).toBe(false)
  expect(calls[calls.length - 1].type).toBe("get_state")
  expect(store.state.autoCompactionEnabled).toBe(false)
})

test("abort_retry sends the command and leaves the outcome to auto_retry_end events", async () => {
  const { store, calls } = await harness()
  await store.init("project")
  calls.length = 0
  await store.abortRetry()
  expect(calls.map(c => c.type)).toEqual(["abort_retry"])
})

test("cycle_model advances to the next model and reports when none is left", async () => {
  const { store, calls, state } = await harness(new Map(), { sessionFile: "session.jsonl" })
  await store.init("project")
  store.started = true
  calls.length = 0
  state.nextCycleModel = { provider: "next", id: "model-b", reasoning: true }
  expect(await store.cycleModel()).toBe(true)
  expect(store.currentModel).toEqual({ provider: "next", id: "model-b", reasoning: true })
  // Cycling appends a model_change entry like set_model, so the file write is marked first.
  expect(calls.slice(0, 3).map(c => c.type)).toEqual(["cycle_model", "session_mtime", "get_state"])
  expect(calls[1].file).toBe("session.jsonl")

  calls.length = 0
  expect(await store.cycleModel()).toBe(false)
  // No other model: pi answers success with null data and nothing else happens.
  expect(calls.map(c => c.type)).toEqual(["cycle_model"])
  expect(store.currentModel).toEqual({ provider: "next", id: "model-b", reasoning: true })
})

test("cycle_thinking_level advances within supported levels and reports unsupported models", async () => {
  const { store, calls, state } = await harness(new Map(), { sessionFile: "session.jsonl" })
  await store.init("project")
  calls.length = 0
  state.nextCycleLevel = "high"
  expect(await store.cycleThinkingLevel()).toBe(true)
  expect(store.thinkingLevel).toBe("high")
  expect(calls.slice(0, 3).map(c => c.type)).toEqual(["cycle_thinking_level", "session_mtime", "get_state"])

  calls.length = 0
  expect(await store.cycleThinkingLevel()).toBe(false)
  expect(store.thinkingLevel).toBe("high")
})

test("a cycled model is announced before the next question", async () => {
  const { store, state } = await harness()
  await store.init("project")
  store.started = true
  state.nextCycleModel = { provider: "next", id: "model-b", reasoning: true }
  await store.cycleModel()
  await store.send("question after cycling")
  await tick()
  expect(JSON.parse(JSON.stringify(store.entries[0].modelChange))).toEqual({
    from: "restored/session-model",
    to: "next/model-b",
  })
})
