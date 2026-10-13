import { afterEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { createWorkspaceRuntime } from "@/lib/workspaceRuntime"

function harness() {
  const callbacks = {}
  const off = []
  const owners = new Map()
  const sessionFor = id => {
    if (!owners.has(id))
      owners.set(id, {
        runtimeId: id,
        cwd: "/project",
        sessionFile: "s.jsonl",
        syncedSessionMtime: 1,
        started: true,
        isStreaming: false,
        isResending: false,
        init: vi.fn(async () => {}),
        loadHistory: vi.fn(async () => {}),
        clear: vi.fn(),
        markRunning: vi.fn(),
        markInterrupted: vi.fn(),
        handleEvent: vi.fn(),
        syncSessionMtime: vi.fn(),
      })
    return owners.get(id)
  }
  const subscribe = name =>
    vi.fn(async callback => {
      callbacks[name] = callback
      const unsubscribe = vi.fn()
      off.push(unsubscribe)
      return unsubscribe
    })
  const api = {
    onPiEvent: subscribe("event"),
    onPiExit: subscribe("exit"),
    onPiStderr: subscribe("stderr"),
    onReconnected: subscribe("reconnected"),
    onWorkspaceStateChanged: subscribe("workspace"),
    onSessionsChanged: subscribe("changed"),
    listRunningSessions: vi.fn(async () => []),
    killPi: vi.fn(async () => {}),
    pixLog: vi.fn(),
    sessionMtime: vi.fn(async () => 1),
  }
  const toast = vi.fn()
  const context = {
    api,
    conversations: {
      sessionFor,
      findConversation: () => sessionFor("active"),
      activateSession: vi.fn(),
      activeRuntimeId: ref("active"),
      uiFor: () => ({ pushToast: toast, pushStderr: vi.fn(), handleRequest: vi.fn() }),
    },
    workspace: {
      histories: {},
      refresh: vi.fn(async () => {}),
      isRemovedProject: path => path === "/removed",
      applyState: vi.fn(),
      syncState: vi.fn(async () => {}),
    },
    phase: ref("chat"),
    config: ref({ lastProject: "/project" }),
    project: ref("/project"),
    connecting: ref(false),
    navigating: ref(false),
    lastError: ref(null),
    isDisposed: () => false,
    spawnWorkspacePi: vi.fn(async () => {}),
    translateError: value => value,
    registerSessionMtimeSync: vi.fn(),
  }
  return { context, callbacks, owners, off, toast, runtime: createWorkspaceRuntime(context) }
}

afterEach(() => {
  vi.useRealTimers()
})

test("subscriptions are disposed exactly once and metadata synchronization is registered", async () => {
  const { runtime, context, off } = harness()
  await runtime.listen()
  expect(off).toHaveLength(6)
  expect(context.registerSessionMtimeSync).toHaveBeenCalledOnce()
  runtime.dispose()
  runtime.dispose()
  for (const unsubscribe of off) expect(unsubscribe).toHaveBeenCalledOnce()
})

test("late subscription results are released after disposal", async () => {
  const { runtime, context } = harness()
  let release
  const lateOff = vi.fn()
  context.api.onPiEvent.mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve
      }),
  )
  const pending = runtime.listen()
  runtime.dispose()
  release(lateOff)
  await pending
  expect(lateOff).toHaveBeenCalledOnce()
  expect(context.registerSessionMtimeSync).not.toHaveBeenCalled()
})

test("failed registration cleans completed and late listeners without retaining a partial subscription", async () => {
  const { runtime, context, off } = harness()
  let release
  const lateOff = vi.fn()
  context.api.onPiEvent.mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve
      }),
  )
  context.api.onPiExit.mockRejectedValue(new Error("listen failed"))
  await expect(runtime.listen()).rejects.toThrow("listen failed")
  release(lateOff)
  await Promise.resolve()
  await Promise.resolve()
  expect(lateOff).toHaveBeenCalledOnce()
  for (const unsubscribe of off) expect(unsubscribe).toHaveBeenCalledOnce()
})

test("disposal cancels pending transcript reloads and list refreshes", async () => {
  vi.useFakeTimers()
  const { runtime, context } = harness()
  runtime.handleExternalSessionChanges(["s.jsonl"])
  runtime.dispose()
  await vi.runAllTimersAsync()
  expect(context.api.sessionMtime).not.toHaveBeenCalled()
  expect(context.workspace.refresh).not.toHaveBeenCalled()
})

test("rebuild keeps an existing navigation lock and restores the session identity", async () => {
  const { runtime, context } = harness()
  const owner = context.conversations.sessionFor("active")
  context.connecting.value = true
  owner.clear.mockImplementation(() => {
    owner.sessionFile = null
  })
  await runtime.rebuildConversation(owner)
  expect(context.connecting.value).toBe(true)
  expect(owner.sessionFile).toBe("s.jsonl")
  expect(owner.started).toBe(true)
  expect(context.api.killPi).toHaveBeenCalledWith("active")
  expect(context.spawnWorkspacePi).toHaveBeenCalledWith("/project", "s.jsonl", "active")
})

test("failed rebuild cleans the worker and reports failure to the caller", async () => {
  const { runtime, context } = harness()
  const owner = context.conversations.sessionFor("active")
  owner.loadHistory.mockRejectedValue(new Error("history failed"))
  await expect(runtime.rebuildConversation(owner)).rejects.toThrow("history failed")
  expect(owner.started).toBe(false)
  expect(context.lastError.value).toContain("history failed")
  expect(context.connecting.value).toBe(false)
})

test("reattachment restores streaming before loading history and does not activate removed projects", async () => {
  const { runtime, context } = harness()
  const owner = context.conversations.sessionFor("restored")
  owner.loadHistory.mockImplementation(async () => {
    expect(owner.isStreaming).toBe(true)
  })
  context.api.listRunningSessions.mockResolvedValue([
    { runtimeId: "removed", project: "/removed", state: { isStreaming: false } },
    { runtimeId: "restored", project: "/project", state: { isStreaming: true } },
  ])
  const restored = await runtime.reattachRunningSessions()
  expect(restored.runtimeId).toBe("restored")
  expect(context.conversations.activateSession).toHaveBeenCalledWith("restored")
  expect(owner.markRunning).toHaveBeenCalledOnce()
})

test("workspace change events apply shared metadata without saving it again", async () => {
  const { runtime, context, callbacks } = harness()
  await runtime.listen()
  const state = { revision: 3, projects: ["shared"] }
  callbacks.workspace(state)
  expect(context.workspace.applyState).toHaveBeenCalledWith(state)
})

test("reconnect synchronizes project metadata before reattaching running sessions", async () => {
  const { runtime, context, callbacks } = harness()
  await runtime.listen()
  context.phase.value = "down"
  let resolve
  context.workspace.syncState.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      }),
  )
  callbacks.reconnected()
  expect(context.api.listRunningSessions).not.toHaveBeenCalled()
  resolve()
  await vi.waitFor(() => expect(context.api.listRunningSessions).toHaveBeenCalledOnce())
  expect(context.phase.value).toBe("pick")
  runtime.dispose()
})
