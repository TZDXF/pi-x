import { afterEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { rememberSshProjectConnection, resolveSshConnectionId } from "@/lib/ssh"
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
    onSshPathBound: subscribe("sshPathBound"),
    onReconnected: subscribe("reconnected"),
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
      remember: vi.fn(),
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
  vi.unstubAllGlobals()
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

test("ssh path rebinding updates the owner, project list and current display (contract §3.8)", async () => {
  const { runtime, context, callbacks, owners } = harness()
  await runtime.listen()
  const rebound = { runtimeId: "active", project: "ssh://host/resolved", path: "/resolved" }
  await callbacks.sshPathBound(rebound)
  const owner = owners.get("active")
  expect(owner.cwd).toBe("ssh://host/resolved")
  expect(context.workspace.remember).toHaveBeenCalledWith("ssh://host/resolved")
  // 当前展示与最近项目跟随回绑（原 path 与回绑前一致时）。
  expect(context.project.value).toBe("ssh://host/resolved")
  expect(context.config.value.lastProject).toBe("ssh://host/resolved")

  // 原路径不同的其它 runtime 只回绑自身，不影响当前展示。
  context.workspace.remember.mockClear()
  await callbacks.sshPathBound({ runtimeId: "other", project: "ssh://host/other", path: "/other" })
  expect(owners.get("other").cwd).toBe("ssh://host/other")
  expect(context.workspace.remember).toHaveBeenCalledWith("ssh://host/other")
  expect(context.project.value).toBe("ssh://host/resolved")

  // 相同路径（含空 cwd）不发事件语义：直接忽略。
  context.workspace.remember.mockClear()
  await callbacks.sshPathBound({ runtimeId: "active", project: "ssh://host/resolved", path: "/resolved" })
  expect(context.workspace.remember).not.toHaveBeenCalled()
})

test("ssh 回绑使用事件所属 runtime 的连接选择，保留旧 URI 绑定", async () => {
  const values = new Map()
  vi.stubGlobal("localStorage", {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  })
  const { runtime, context, callbacks } = harness()
  const connections = [
    { id: "first", host: "host", keyPath: "/keys/first" },
    { id: "selected", host: "host", keyPath: "/keys/selected" },
  ]
  context.config.value.sshConnections = connections
  const previous = "ssh://host/alias"
  const rebound = "ssh://host/real"
  const active = "ssh://host/active"
  context.project.value = active
  context.config.value.lastProject = active
  context.conversations.sessionFor("active").cwd = active
  context.conversations.sessionFor("background").cwd = previous
  rememberSshProjectConnection(active, "first")
  rememberSshProjectConnection(rebound, "first")
  rememberSshProjectConnection(previous, "selected")
  await runtime.listen()
  await callbacks.sshPathBound({ runtimeId: "background", project: rebound, path: "/real" })
  expect(context.conversations.sessionFor("background").cwd).toBe(rebound)
  expect(resolveSshConnectionId(rebound, connections)).toBe("selected")
  expect(resolveSshConnectionId(previous, connections)).toBe("selected")
  expect(resolveSshConnectionId(active, connections)).toBe("first")
  expect(context.project.value).toBe(active)
  expect(context.config.value.lastProject).toBe(active)
  runtime.dispose()
})
