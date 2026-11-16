import { afterEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { createWorkspaceRuntime } from "@/lib/workspaceRuntime"
import type { AuxEventSink } from "@/lib/auxEventSink"
import { registerAuxEventSink, auxEventSink } from "@/lib/auxEventSink"

/**
 * aux 事件的**分发**契约（`lib/workspaceRuntime.ts`）：
 * - aux 的 `pi://event` / `pi://exit` / `pi://stderr` 只写 aux 自己的 store，
 *   绝不 `sessionFor` 重建、绝不落到主会话；
 * - 墓碑命中（已关闭实例）→ 迟到事件直接丢弃（关闭即销毁，不能复活）；
 * - 重连恢复不把 aux 当成主会话恢复/激活。
 */
function harness(sink: AuxEventSink | null) {
  registerAuxEventSink(sink)
  const callbacks: Record<string, (payload: any) => void> = {}
  const owners = new Map<string, any>()
  const sessionFor = (id: string) => {
    if (!owners.has(id))
      owners.set(id, {
        runtimeId: id,
        cwd: "/project",
        sessionFile: "s.jsonl",
        started: true,
        isStreaming: false,
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
  const mainUi = {
    pushToast: vi.fn(),
    pushStderr: vi.fn(),
    handleRequest: vi.fn(),
    resolveRequest: vi.fn(),
    restoreRequests: vi.fn(),
  }
  const api = {
    // 与 `api/client/rpc.ts` 的封装一致：这里存的是"解包后"的 handler。
    onPiEvent: vi.fn(async (handler: (payload: any) => void) => {
      callbacks.event = handler
      return vi.fn()
    }),
    onPiExit: vi.fn(async (handler: (runtimeId?: string, activity?: unknown) => void) => {
      callbacks.exit = payload => handler(payload.runtimeId)
      return vi.fn()
    }),
    onPiStderr: vi.fn(async (handler: (line: string, runtimeId?: string) => void) => {
      callbacks.stderr = payload => handler(payload.line, payload.runtimeId)
      return vi.fn()
    }),
    onSshPathBound: vi.fn(async (handler: (payload: any) => void) => {
      callbacks.sshPathBound = handler
      return vi.fn()
    }),
    onReconnected: vi.fn(async (handler: () => void) => {
      callbacks.reconnected = handler
      return vi.fn()
    }),
    onWorkspaceStateChanged: vi.fn(async (handler: (payload: any) => void) => {
      callbacks.workspace = handler
      return vi.fn()
    }),
    onSessionsChanged: vi.fn(async (handler: (payload: any) => void) => {
      callbacks.changed = handler
      return vi.fn()
    }),
    listRunningSessions: vi.fn(async () => []),
    killPi: vi.fn(async () => {}),
    pixLog: vi.fn(),
    sessionMtime: vi.fn(async () => 1),
  }
  const context = {
    api,
    conversations: {
      sessionFor,
      findConversation: () => sessionFor("active"),
      activateSession: vi.fn(),
      activeRuntimeId: ref("active"),
      uiFor: () => mainUi,
    },
    workspace: {
      histories: {},
      refresh: vi.fn(async () => {}),
      isRemovedProject: () => false,
      remember: vi.fn(),
      applyState: vi.fn(),
      syncState: vi.fn(async () => {}),
    },
    phase: ref("chat"),
    config: ref({ lastProject: "/project" }),
    project: ref("/project"),
    connecting: ref(false),
    navigating: ref(false),
    lastError: ref<string | null>(null),
    isDisposed: () => false,
    spawnWorkspacePi: vi.fn(async () => {}),
    translateError: (value: string) => value,
    registerSessionMtimeSync: vi.fn(),
  }
  return { context, owners, callbacks, mainUi, runtime: createWorkspaceRuntime(context as never) }
}

function auxSink(state: { closed?: boolean }) {
  const session = {
    handleEvent: vi.fn(),
    markInterrupted: vi.fn(),
    started: true,
    isStreaming: false,
    isCompacting: false,
    partialBlocks: null as unknown,
  }
  const ui = { resolveRequest: vi.fn(), handleRequest: vi.fn(), restoreRequests: vi.fn(), pushStderr: vi.fn() }
  const sink: AuxEventSink & { session: typeof session; ui: typeof ui } = {
    session,
    ui,
    isClosed: () => !!state.closed,
    hasSession: () => true,
    handleEvent: (_id, event) => session.handleEvent(event),
    resolveRequest: (_id, id) => ui.resolveRequest(id),
    handleRequest: (_id, request) => ui.handleRequest(request),
    restoreRequests: (_id, requests) => ui.restoreRequests(requests),
    pushStderr: (_id, line) => ui.pushStderr(line),
    onExit: () => {
      session.markInterrupted()
      session.started = false
      ui.restoreRequests([])
    },
  }
  return sink
}

afterEach(() => {
  registerAuxEventSink(null)
  vi.unstubAllGlobals()
})

test("aux events go to the aux sink and never create or touch a main session store", async () => {
  const sink = auxSink({})
  const { runtime, callbacks, owners, mainUi } = harness(sink)
  await runtime.listen()
  callbacks.event!({ type: "extension_ui_request", runtimeId: "aux:1", id: "q", method: "confirm" })
  expect(sink.ui.handleRequest).toHaveBeenCalledOnce()
  // 绝不落到主会话的 ui store。
  expect(mainUi.handleRequest).not.toHaveBeenCalled()
  callbacks.event!({ type: "extension_ui_resolved", runtimeId: "aux:1", id: "q" })
  expect(sink.ui.resolveRequest).toHaveBeenCalledWith("q")
  callbacks.event!({
    type: "text_delta",
    runtimeId: "aux:1",
    delta: { type: "text_delta", contentIndex: 0, delta: "hi" },
  })
  expect(sink.session.handleEvent).toHaveBeenCalledOnce()
  // 事件不能为 aux 造出一个会话 store（那会留下无人释放的孤儿）。
  expect(owners.has("aux:1")).toBe(false)
  expect(mainUi.restoreRequests).not.toHaveBeenCalled()
  runtime.dispose()
})

test("a tombstoned aux runtime drops late events and exits instead of being revived", async () => {
  const sink = auxSink({ closed: true })
  const { runtime, callbacks, owners, mainUi } = harness(sink)
  await runtime.listen()
  callbacks.event!({ type: "extension_ui_request", runtimeId: "aux:closed", id: "q", method: "confirm" })
  callbacks.exit!({ runtimeId: "aux:closed" })
  callbacks.stderr!({ line: "boom", runtimeId: "aux:closed" })
  expect(sink.ui.handleRequest).not.toHaveBeenCalled()
  expect(sink.session.handleEvent).not.toHaveBeenCalled()
  expect(sink.ui.pushStderr).not.toHaveBeenCalled()
  expect(sink.session.markInterrupted).not.toHaveBeenCalled()
  expect(owners.has("aux:closed")).toBe(false)
  expect(mainUi.pushStderr).not.toHaveBeenCalled()
  runtime.dispose()
})

test("a live aux exit only收尾 its own store and leaves the main phase untouched", async () => {
  const sink = auxSink({})
  const { runtime, callbacks, context, owners } = harness(sink)
  await runtime.listen()
  callbacks.exit!({ runtimeId: "aux:live" })
  expect(sink.session.markInterrupted).toHaveBeenCalledOnce()
  expect(sink.ui.restoreRequests).toHaveBeenCalledWith([])
  // 主会话的 store 与 phase 不受 aux 退出影响。
  expect(owners.has("aux:live")).toBe(false)
  expect(context.phase.value).toBe("chat")
  runtime.dispose()
})

test("reattach never activates an aux runtime as the main conversation", async () => {
  const sink = auxSink({})
  const { runtime, context } = harness(sink)
  context.api.listRunningSessions.mockResolvedValue([
    { runtimeId: "aux:orphan", project: "/project", state: { isStreaming: true, sessionFile: null } },
    { runtimeId: "main-1", project: "/project", state: { isStreaming: false, sessionFile: "s.jsonl" } },
  ])
  await runtime.reattachRunningSessions()
  expect(context.conversations.activateSession).toHaveBeenCalledWith("main-1")
  // aux 只被"校验活跃"，不被激活成主会话。
  expect(context.conversations.activateSession).not.toHaveBeenCalledWith("aux:orphan")
})

test("reauth only restores aux runtimes whose lease belongs to this client", async () => {
  const sink = auxSink({})
  // 重连归属过滤（规格 §5 第 4 条）：`aux_list` 说本机只持有 aux:mine；
  // aux:other 是另一个窗口的实例（同父会话、别人 clientId），aux:gone 的父会话已不在本地。
  const own = ["aux:mine"]
  const withLeases = {
    ...sink,
    reconcileLeases: vi.fn(async () => own),
    restoreRequests: vi.fn(),
  }
  const { runtime, context } = harness(withLeases)
  context.api.listRunningSessions.mockResolvedValue([
    { runtimeId: "aux:mine", project: "/project", state: { isStreaming: true }, pendingUiRequests: [{ id: "q" }] },
    { runtimeId: "aux:other", project: "/project", state: { isStreaming: true }, pendingUiRequests: [{ id: "x" }] },
  ])
  await runtime.reattachRunningSessions(false)
  expect(withLeases.reconcileLeases).toHaveBeenCalledOnce()
  // 只恢复本机条目（含 pending UI）；别人的条目一律不动 —— 不改状态、不 kill、不恢复 UI。
  expect(withLeases.restoreRequests).toHaveBeenCalledTimes(1)
  expect(withLeases.restoreRequests).toHaveBeenCalledWith("aux:mine", [{ id: "q" }])
  expect(context.api.killPi).not.toHaveBeenCalled()
  runtime.dispose()
})

test("without a registered aux sink aux events are dropped, not misrouted", async () => {
  const { runtime, callbacks, owners, mainUi } = harness(null)
  await runtime.listen()
  expect(auxEventSink()).toBe(null)
  callbacks.event!({ type: "text_delta", runtimeId: "aux:9", delta: {} })
  callbacks.exit!({ runtimeId: "aux:9" })
  expect(owners.has("aux:9")).toBe(false)
  expect(mainUi.restoreRequests).not.toHaveBeenCalled()
  runtime.dispose()
})
