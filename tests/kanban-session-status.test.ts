import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, reactive } from "vue"
import { sessionIdentityKey } from "@/lib/sessionIdentity"
import { shouldApplySessionActivity } from "@/lib/workspaceState"
import {
  acknowledgeSessionRunStatus,
  mergeSessionActivity,
  sessionActivitySnapshot,
  sessionRunRevision,
  sessionRunStatus,
  setSessionRunStatus,
  type SessionActivity,
} from "@/stores/sessionRunStatus"
import { useSessionActivitySync } from "@/composables/useSessionActivitySync"
import { useSessionReadReceipt } from "@/composables/useSessionReadReceipt"

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: () => {
    throw new Error("Inject a workspace in unit tests")
  },
}))

const cleanup: (() => void)[] = []
let sequence = 0
const identity = () => `kanban-${++sequence}.jsonl`

afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function workspace() {
  const state = reactive({
    sessionActivities: {} as Record<string, SessionActivity>,
    sessionAcknowledgements: {} as Record<string, string>,
    recordSessionActivity: vi.fn((activity: SessionActivity) => {
      const key = sessionIdentityKey(activity.file, activity.project)
      if (shouldApplySessionActivity(state.sessionActivities[key], activity))
        state.sessionActivities[key] = { ...activity }
    }),
    acknowledgeSessionActivity: vi.fn((file: string, project: string, runId: string) => {
      state.sessionAcknowledgements[sessionIdentityKey(file, project)] = runId
    }),
  })
  const scope = effectScope()
  scope.run(() => useSessionActivitySync(state))
  cleanup.push(() => scope.stop())
  // Discard replay of earlier tests' intentionally detached writes.
  state.recordSessionActivity.mockClear()
  state.acknowledgeSessionActivity.mockClear()
  return state
}

test("the bridge records local activity/idle and exact receipts without writing back remote hydration", () => {
  const state = workspace()
  const file = identity()
  setSessionRunStatus(file, "running", "project")
  const firstRun = sessionRunRevision(file)
  setSessionRunStatus(file, "completed", "project")
  expect(sessionRunRevision(file)).toBe(firstRun)
  acknowledgeSessionRunStatus(file, "project", firstRun)
  expect(state.sessionAcknowledgements[file]).toBe(firstRun)
  expect(state.acknowledgeSessionActivity).toHaveBeenCalledTimes(1)
  setSessionRunStatus(file, "running", "project")
  expect(sessionRunRevision(file)).not.toBe(firstRun)
  acknowledgeSessionRunStatus(file, "project", firstRun)
  expect(sessionRunStatus(file)).toBe("running")
  setSessionRunStatus(file, null, "project")
  expect(state.sessionActivities[file]?.status).toBe("idle")
  expect(sessionRunStatus(file)).toBeUndefined()
  state.recordSessionActivity.mockClear()
  const remote: SessionActivity = {
    file: identity(),
    project: "project",
    status: "error",
    runId: "remote-1",
    updatedAt: 10,
  }
  state.sessionActivities[remote.file] = remote
  expect(sessionRunStatus(remote.file)).toBe("error")
  state.sessionAcknowledgements[remote.file] = "old-run"
  expect(sessionRunStatus(remote.file)).toBe("error")
  state.sessionAcknowledgements[remote.file] = remote.runId
  expect(sessionRunStatus(remote.file)).toBeUndefined()
  expect(state.recordSessionActivity).not.toHaveBeenCalled()
  expect(state.acknowledgeSessionActivity).toHaveBeenCalledTimes(1)
})

test("backend IDs replace provisional IDs, repeat across tabs/retry and reject stale events", () => {
  const state = workspace()
  const file = identity()
  setSessionRunStatus(file, "running")
  const provisional = sessionRunRevision(file)
  expect(provisional).toMatch(/^local:/)
  setSessionRunStatus(file, "running", "project", { runId: "backend-shared", updatedAt: 100 })
  expect(sessionRunRevision(file)).toBe("backend-shared")
  expect(sessionRunRevision(file)).not.toBe(provisional)
  setSessionRunStatus(file, "running", "project", { runId: "backend-shared", updatedAt: 100 })
  setSessionRunStatus(file, "completed", "project", { runId: "backend-shared", updatedAt: 110 })
  acknowledgeSessionRunStatus(file, "project", "backend-shared")
  setSessionRunStatus(file, "completed", "project", { runId: "backend-shared", updatedAt: 110 })
  expect(sessionRunStatus(file)).toBeUndefined()
  setSessionRunStatus(file, "running", "project", { runId: "backend-shared", updatedAt: 100 })
  expect(sessionRunStatus(file)).toBeUndefined()
  setSessionRunStatus(file, "running", "project", { runId: "backend-next", updatedAt: 120 })
  setSessionRunStatus(file, "error", "project", { runId: "backend-next", updatedAt: 130 })
  state.sessionAcknowledgements[file] = "backend-shared"
  acknowledgeSessionRunStatus(file, "project", "backend-shared")
  expect(sessionRunStatus(file)).toBe("error")
  expect(sessionActivitySnapshot(file)?.updatedAt).toBe(130)
})

test("optimistic timestamps never block stable backend starts or settlements across skewed clocks", () => {
  const state = workspace()
  const file = identity()
  vi.spyOn(Date, "now").mockReturnValue(999_999)
  setSessionRunStatus(file, "running", "project")
  expect(sessionActivitySnapshot(file)?.updatedAt).toBe(999_999)
  mergeSessionActivity({ file, project: "project", status: "running", runId: "clock-server", updatedAt: 10 })
  expect(sessionRunRevision(file)).toBe("clock-server")
  setSessionRunStatus(file, "running", "project")
  setSessionRunStatus(file, "error", "project")
  expect(sessionActivitySnapshot(file)?.updatedAt).toBe(10)
  setSessionRunStatus(file, "completed", "project", { runId: "clock-server", updatedAt: 20 })
  expect(sessionRunStatus(file)).toBe("completed")
  expect(state.sessionActivities[file]?.updatedAt).toBe(20)
  mergeSessionActivity({
    file,
    project: "project",
    status: "running",
    runId: "local:stale-other-tab",
    updatedAt: 999_999,
  })
  expect(sessionRunStatus(file)).toBe("running")
  mergeSessionActivity({ file, project: "project", status: "completed", runId: "clock-server", updatedAt: 20 })
  expect(sessionRunStatus(file)).toBe("completed")
})

test("reattach preserves imported running identity, local aliasing and remote endpoint separation", () => {
  const file = identity()
  const first = "ssh://first/project"
  const second = "ssh://second/project"
  mergeSessionActivity({ file, project: first, status: "running", runId: "reattached", updatedAt: 10 })
  setSessionRunStatus(file, "running", first)
  expect(sessionRunRevision(file, first)).toBe("reattached")
  setSessionRunStatus(file, "error", second)
  expect(sessionRunStatus(file, first)).toBe("running")
  expect(sessionRunStatus(file, second)).toBe("error")
  const local = `folder/${identity()}`
  setSessionRunStatus(local, "completed", "C:/project")
  expect(sessionRunStatus(local.replaceAll("/", "\\"))).toBe("completed")
  expect(Object.isFrozen(sessionActivitySnapshot(local))).toBe(true)
})

test("untracked events are harmless and file-late terminal events retain backend identity", () => {
  const state = workspace()
  setSessionRunStatus(null, "running", "project", { runId: "file-late", updatedAt: 10 })
  expect(state.recordSessionActivity).not.toHaveBeenCalled()
  const file = identity()
  setSessionRunStatus(file, "completed", "project", { runId: "file-late", updatedAt: 20 })
  expect(sessionActivitySnapshot(file)).toMatchObject({ status: "completed", runId: "file-late", updatedAt: 20 })
})

test("detached local writes replay on mount and all bridge watches stop with their scope", () => {
  const file = identity()
  const state = workspace()
  cleanup.pop()!()
  state.recordSessionActivity.mockClear()
  setSessionRunStatus(file, "completed", "project")
  acknowledgeSessionRunStatus(file, "project")
  expect(state.recordSessionActivity).not.toHaveBeenCalled()
  const next = workspace()
  expect(next.sessionActivities[file]?.status).toBe("completed")
  expect(next.sessionAcknowledgements[file]).toBe(sessionRunRevision(file))
  cleanup.pop()!()
  const remote = identity()
  next.sessionActivities[remote] = { file: remote, project: "project", status: "error", runId: "stopped", updatedAt: 5 }
  expect(sessionRunStatus(remote)).toBeUndefined()
})

class FakeViewport extends EventTarget {
  scrollTop = 900
  scrollHeight = 1000
  clientHeight = 100
  isConnected = true
  children = []
  visible = true
  getClientRects() {
    return this.visible ? [{}] : []
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 100, width: 400, height: 100 }
  }
}

async function flush() {
  await nextTick()
  await nextTick()
}

function reader(explicit = false, deferAcknowledgement = false) {
  const file = identity()
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    focused: true,
    hasFocus() {
      return this.focused
    },
    defaultView: Object.assign(new EventTarget(), { innerHeight: 800 }),
  })
  vi.stubGlobal("document", doc)
  const observers: { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[] = []
  const observer = class {
    disconnect = vi.fn()
    observe = vi.fn()
    constructor(public callback: () => void) {
      observers.push(this)
    }
  }
  vi.stubGlobal("ResizeObserver", observer)
  vi.stubGlobal("MutationObserver", observer)
  const session = reactive({
    sessionFile: file,
    cwd: "project",
    historyLoading: false,
    isStreaming: false,
    entries: [{ kind: "assistant", text: "latest answer" }],
  })
  const state = reactive({ enabled: true, loaded: true, viewport: new FakeViewport() })
  const scope = effectScope()
  const result = scope.run(() =>
    useSessionReadReceipt(
      explicit
        ? {
            file: () => session.sessionFile,
            project: () => session.cwd,
            status: () => sessionRunStatus(session.sessionFile, session.cwd),
            loaded: () => state.loaded,
            viewport: () => state.viewport as unknown as HTMLElement,
            enabled: () => state.enabled,
            deferAcknowledgement,
          }
        : {
            session,
            loaded: () => state.loaded,
            viewport: () => state.viewport as unknown as HTMLElement,
            enabled: () => state.enabled,
            deferAcknowledgement,
          },
    ),
  )!
  cleanup.push(() => scope.stop())
  return { file, doc, session, state, observers, result, scope }
}

test.each(["completed", "error"] as const)(
  "only the focused, loaded latest %s result at bottom is read",
  async status => {
    const r = reader()
    r.session.historyLoading = true
    setSessionRunStatus(r.file, status, "project")
    await flush()
    expect(sessionRunStatus(r.file)).toBe(status)
    r.session.historyLoading = false
    r.state.viewport.scrollTop = 0
    await flush()
    expect(sessionRunStatus(r.file)).toBe(status)
    r.state.viewport.scrollTop = 900
    r.doc.visibilityState = "hidden"
    r.state.viewport.dispatchEvent(new Event("scroll"))
    await flush()
    expect(sessionRunStatus(r.file)).toBe(status)
    r.doc.visibilityState = "visible"
    r.doc.focused = false
    r.doc.dispatchEvent(new Event("visibilitychange"))
    await flush()
    expect(sessionRunStatus(r.file)).toBe(status)
    r.doc.focused = true
    r.doc.defaultView.dispatchEvent(new Event("focus"))
    await flush()
    expect(sessionRunStatus(r.file)).toBeUndefined()
  },
)

test("a completed board card stays completed while open and becomes idle after closing", async () => {
  const r = reader(false, true)
  setSessionRunStatus(r.file, "completed", "project")
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")

  r.scope.stop()
  expect(sessionRunStatus(r.file)).toBeUndefined()
})

test("a run completed in the open board details stays completed until closing", async () => {
  const r = reader(false, true)
  setSessionRunStatus(r.file, "running", "project")
  await flush()
  expect(sessionRunStatus(r.file)).toBe("running")

  setSessionRunStatus(r.file, "completed", "project")
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")

  r.scope.stop()
  expect(sessionRunStatus(r.file)).toBeUndefined()
})

test("explicit identity gates loading/enabled/visibility and rechecks scroll, resize and result changes", async () => {
  const r = reader(true)
  r.state.loaded = false
  setSessionRunStatus(r.file, "completed", "project")
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.state.loaded = true
  r.state.enabled = false
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.state.enabled = true
  r.state.viewport.visible = false
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.state.viewport.visible = true
  r.state.viewport.scrollTop = 400
  r.doc.defaultView.dispatchEvent(new Event("resize"))
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.state.viewport.scrollTop = 900
  r.state.viewport.dispatchEvent(new Event("scroll"))
  await flush()
  expect(sessionRunStatus(r.file)).toBeUndefined()
  setSessionRunStatus(r.file, "running", "project")
  await flush()
  expect(sessionRunStatus(r.file)).toBe("running")
  setSessionRunStatus(r.file, "error", "project")
  await flush()
  expect(sessionRunStatus(r.file)).toBeUndefined()
})

test("empty/still streaming content and zero-size/detached viewports never acknowledge", async () => {
  const r = reader()
  r.session.entries = []
  setSessionRunStatus(r.file, "completed", "project")
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.session.entries.push({ kind: "assistant", text: "new" })
  r.session.isStreaming = true
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.session.isStreaming = false
  r.state.viewport.clientHeight = 0
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.state.viewport.clientHeight = 100
  r.state.viewport.isConnected = false
  r.result.check()
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.state.viewport.isConnected = true
  r.observers[0]!.callback()
  await flush()
  expect(sessionRunStatus(r.file)).toBeUndefined()
})

test("a queued receipt cannot swallow a newer run, and scope disposal removes observers/listeners", async () => {
  const r = reader()
  setSessionRunStatus(r.file, "completed", "project")
  r.result.check()
  setSessionRunStatus(r.file, "running", "project")
  await flush()
  expect(sessionRunStatus(r.file)).toBe("running")
  const removeScroll = vi.spyOn(r.state.viewport, "removeEventListener")
  const removeVisibility = vi.spyOn(r.doc, "removeEventListener")
  const removeWindow = vi.spyOn(r.doc.defaultView, "removeEventListener")
  r.scope.stop()
  expect(removeScroll).toHaveBeenCalledWith("scroll", expect.any(Function))
  expect(removeVisibility).toHaveBeenCalledWith("visibilitychange", expect.any(Function))
  expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function))
  expect(removeWindow).toHaveBeenCalledWith("resize", expect.any(Function))
  for (const item of r.observers) expect(item.disconnect).toHaveBeenCalled()
  setSessionRunStatus(r.file, "error", "project")
  r.state.viewport.dispatchEvent(new Event("scroll"))
  r.doc.defaultView.dispatchEvent(new Event("focus"))
  await flush()
  expect(sessionRunStatus(r.file)).toBe("error")
})

test("changing the viewport detaches its previous scroll listener", async () => {
  const r = reader()
  r.state.enabled = false
  setSessionRunStatus(r.file, "completed", "project")
  await flush()
  const previous = r.state.viewport
  const remove = vi.spyOn(previous, "removeEventListener")
  r.state.viewport = new FakeViewport()
  await flush()
  expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function))
  r.state.enabled = true
  await flush()
  expect(sessionRunStatus(r.file)).toBeUndefined()
})

test("an old answer before the latest prompt and a bottom clipped outside the window are not read", async () => {
  const r = reader()
  r.session.entries.push({ kind: "user", text: "new question" })
  setSessionRunStatus(r.file, "completed", "project")
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.session.entries.push({ kind: "assistant", text: "new answer" })
  vi.spyOn(r.state.viewport, "getBoundingClientRect").mockReturnValue({
    top: 750,
    bottom: 850,
    width: 400,
    height: 100,
  })
  await flush()
  expect(sessionRunStatus(r.file)).toBe("completed")
  r.doc.defaultView.innerHeight = 1000
  r.doc.defaultView.dispatchEvent(new Event("resize"))
  await flush()
  expect(sessionRunStatus(r.file)).toBeUndefined()
})
