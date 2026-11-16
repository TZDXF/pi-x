import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import {
  applyWorkspaceStatePatch,
  diffWorkspaceState,
  emptyWorkspaceState,
  type BoardDraft,
  type SessionActivity,
  type WorkspaceState,
  type WorkspaceStatePatch,
} from "@/lib/workspaceState"
import { sessionIdentityKey } from "@/lib/sessionIdentity"

const mocks = vi.hoisted(() => ({
  get: vi.fn<() => Promise<WorkspaceState>>(),
  update: vi.fn<(patch: WorkspaceStatePatch) => Promise<WorkspaceState>>(),
}))
vi.mock("@/api/piClient", () => ({
  getWorkspaceState: () => mocks.get(),
  updateWorkspaceState: (patch: WorkspaceStatePatch) => mocks.update(patch),
  pixLog: () => {},
}))

type Store = ReturnType<(typeof import("@/stores/workspace"))["useWorkspaceStore"]>
let backend: WorkspaceState
let stores: Store[]

function draft(id = "draft", changes: Partial<BoardDraft> = {}): BoardDraft {
  return { id, project: "C:/project", message: "Implement this", createdAt: 1, updatedAt: 2, ...changes }
}
function activity(changes: Partial<SessionActivity> = {}): SessionActivity {
  return { file: "/session.jsonl", project: "C:/project", status: "running", runId: "run-1", updatedAt: 10, ...changes }
}
function commit(patch: WorkspaceStatePatch) {
  backend = applyWorkspaceStatePatch(backend, patch)
  backend.revision++
  // The existing workspace-state-changed listener forwards snapshots to applyState.
  for (const store of stores) store.applyState(structuredClone(backend))
  return structuredClone(backend)
}
async function client(initialize = true) {
  setActivePinia(createPinia())
  const { useWorkspaceStore } = await import("@/stores/workspace")
  const store = useWorkspaceStore()
  stores.push(store)
  if (initialize) await store.initialize()
  return store
}

beforeEach(() => {
  vi.resetModules()
  backend = emptyWorkspaceState()
  stores = []
  mocks.get.mockReset().mockImplementation(async () => structuredClone(backend))
  mocks.update.mockReset().mockImplementation(async patch => commit(patch))
})
afterEach(async () => {
  mocks.update.mockImplementation(async patch => commit(patch))
  await Promise.all(stores.map(store => store.flushPersistence().catch(() => {})))
  vi.restoreAllMocks()
})

test("legacy workspace snapshots normalize missing kanban maps without producing changes", async () => {
  backend = {
    revision: 3,
    projects: ["saved"],
    pinnedProjects: [],
    removedProjects: [],
    projectGroups: {},
    sessionOrder: {},
  }
  const normalized = applyWorkspaceStatePatch(backend, {})
  expect(normalized.boardColumnOrder).toEqual({})
  expect(normalized.boardDrafts).toEqual({})
  expect(normalized.sessionActivities).toEqual({})
  expect(normalized.sessionAcknowledgements).toEqual({})
  expect(diffWorkspaceState(backend, normalized)).toEqual({})
  const store = await client()
  expect(store.boardColumnOrder).toEqual({})
  expect(store.boardDrafts).toEqual({})
  expect(store.sessionActivities).toEqual({})
  expect(store.sessionAcknowledgements).toEqual({})
  expect(mocks.update).not.toHaveBeenCalled()
})

test("column order diffs patch individual opaque keys including deletion and empty orders", () => {
  const key = JSON.stringify(["C:\\Project\\", "running"])
  const otherKey = JSON.stringify(["C:/Project/", "running"])
  const removedKey = JSON.stringify(["", "done"])
  const addedKey = JSON.stringify(["ssh://HOST/project", "todo"])
  const before = {
    ...emptyWorkspaceState(),
    boardColumnOrder: { [key]: ["a", "b"], [otherKey]: ["other"], [removedKey]: ["removed"] },
  }
  const after = {
    ...before,
    boardColumnOrder: { [key]: ["b", "a"], [otherKey]: ["other"], [addedKey]: [] },
  }
  const patch = diffWorkspaceState(before, after)
  expect(patch).toEqual({
    boardColumnOrder: { [key]: ["b", "a"], [removedKey]: null, [addedKey]: [] },
  })
  const remoteKey = JSON.stringify(["ssh://other/project", "running"])
  const concurrent = applyWorkspaceStatePatch(before, { boardColumnOrder: { [remoteKey]: ["remote"] } })
  expect(applyWorkspaceStatePatch(concurrent, patch).boardColumnOrder).toEqual({
    ...after.boardColumnOrder,
    [remoteKey]: ["remote"],
  })
  expect(before.boardColumnOrder[key]).toEqual(["a", "b"])
  expect(concurrent.boardColumnOrder[removedKey]).toEqual(["removed"])
  expect(diffWorkspaceState(after, after)).toEqual({})
})

test("column ordering deduplicates exact IDs and shares each column across clients and restarts", async () => {
  const desktop = await client()
  const remote = await client()
  const key = JSON.stringify(["C:\\Project\\", "running"])
  const otherKey = JSON.stringify(["C:/Project/", "running"])
  const ids = ["C:\\Cards\\one", "c:/cards/one", "C:\\Cards\\one", "draft:two", "draft:two"]
  const expected = ["C:\\Cards\\one", "c:/cards/one", "draft:two"]
  desktop.reorderBoardColumn(key, ids)
  ids.reverse()
  remote.reorderBoardColumn(otherKey, ["remote"])
  await Promise.all([desktop.flushPersistence(), remote.flushPersistence()])
  expect(desktop.boardColumnOrder).toEqual({ [key]: expected, [otherKey]: ["remote"] })
  expect(remote.boardColumnOrder).toEqual(desktop.boardColumnOrder)
  expect((await client()).boardColumnOrder).toEqual(desktop.boardColumnOrder)
  expect(mocks.update.mock.calls.map(([patch]) => patch)).toEqual([
    { boardColumnOrder: { [key]: expected } },
    { boardColumnOrder: { [otherKey]: ["remote"] } },
  ])
  mocks.update.mockClear()
  desktop.reorderBoardColumn(key, [...expected, expected[0]])
  await desktop.flushPersistence()
  expect(mocks.update).not.toHaveBeenCalled()
  desktop.reorderBoardColumn(key, [])
  await desktop.flushPersistence()
  expect(remote.boardColumnOrder).toEqual({ [key]: [], [otherKey]: ["remote"] })
  expect((await client()).boardColumnOrder).toEqual(remote.boardColumnOrder)
})

test("queued column reorders survive incoming snapshots and an older write response", async () => {
  const store = await client()
  const key = JSON.stringify(["", "running"])
  const otherKey = JSON.stringify(["", "todo"])
  let acknowledge!: (state: WorkspaceState) => void
  mocks.update.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        acknowledge = resolve
      }),
  )
  store.reorderBoardColumn(key, ["a", "b"])
  const saving = store.flushPersistence()
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"))
  const oldResponse = { ...emptyWorkspaceState(), revision: 1, boardColumnOrder: { [key]: ["a", "b"] } }
  backend = { ...oldResponse, revision: 2, boardColumnOrder: { [key]: ["remote"], [otherKey]: ["other"] } }
  store.applyState(structuredClone(backend))
  expect(store.boardColumnOrder[key]).toEqual(["a", "b"])
  store.reorderBoardColumn(key, ["b", "a"])
  acknowledge(oldResponse)
  await saving
  const expected = { [key]: ["b", "a"], [otherKey]: ["other"] }
  expect(store.boardColumnOrder).toEqual(expected)
  expect(backend.boardColumnOrder).toEqual(expected)
  store.applyState(oldResponse)
  expect(store.boardColumnOrder).toEqual(expected)
  expect((await client()).boardColumnOrder).toEqual(expected)
})

test("column reorders before hydration and while offline preserve other saved columns", async () => {
  const key = JSON.stringify(["", "running"])
  const otherKey = JSON.stringify(["ssh://host/project", "todo"])
  backend = { ...emptyWorkspaceState(), boardColumnOrder: { [key]: ["old"], [otherKey]: ["saved"] } }
  const store = await client(false)
  store.reorderBoardColumn(key, ["b", "a", "b"])
  await store.flushPersistence()
  expect(store.boardColumnOrder).toEqual({ [key]: ["b", "a"], [otherKey]: ["saved"] })
  vi.spyOn(console, "warn").mockImplementation(() => {})
  mocks.update.mockRejectedValue(new Error("offline"))
  store.reorderBoardColumn(key, ["a", "b"])
  await expect(store.flushPersistence()).rejects.toThrow("offline")
  commit({ boardColumnOrder: { [otherKey]: ["remote"] } })
  expect(store.boardColumnOrder[key]).toEqual(["a", "b"])
  mocks.update.mockImplementation(async patch => commit(patch))
  await store.syncState()
  expect(store.persistenceError).toBe(null)
  expect((await client()).boardColumnOrder).toEqual({ [key]: ["a", "b"], [otherKey]: ["remote"] })
})

test("draft patches diff by ID and preserve unrelated additions on other clients", () => {
  const before = { ...emptyWorkspaceState(), boardDrafts: { edited: draft("edited"), removed: draft("removed") } }
  const after = {
    ...before,
    boardDrafts: { edited: draft("edited", { message: "", updatedAt: 3 }), added: draft("added") },
  }
  const patch = diffWorkspaceState(before, after)
  expect(patch).toEqual({
    boardDrafts: { edited: after.boardDrafts.edited, added: after.boardDrafts.added, removed: null },
  })
  const concurrent = applyWorkspaceStatePatch(before, { boardDrafts: { remote: draft("remote") } })
  const result = applyWorkspaceStatePatch(concurrent, patch)
  expect(Object.keys(result.boardDrafts).sort()).toEqual(["added", "edited", "remote"])
  expect(result.boardDrafts.edited.message).toBe("")
  expect(before.boardDrafts.edited.message).toBe("Implement this")
})

test("composite identities remain opaque and activities only advance by updatedAt", () => {
  const current = activity({ project: "ssh://dev@host/one", file: "/sessions/a\\b.jsonl", updatedAt: 20 })
  const key = sessionIdentityKey(current.file, current.project)
  const other = activity({ ...current, project: "ssh://dev@host/two", status: "error" })
  const otherKey = sessionIdentityKey(other.file, other.project)
  const state = applyWorkspaceStatePatch(emptyWorkspaceState(), {
    sessionActivities: { [key]: current, [otherKey]: other },
  })
  const result = applyWorkspaceStatePatch(state, {
    sessionActivities: { [key]: { ...current, updatedAt: 19, status: "completed" } },
    sessionAcknowledgements: { [key]: current.runId },
  })
  expect(result.sessionActivities).toEqual({ [key]: current, [otherKey]: other })
  expect(result.sessionAcknowledgements).toEqual({ [key]: current.runId })
  expect(diffWorkspaceState(state, result)).toEqual({ sessionAcknowledgements: { [key]: current.runId } })
  const deleted = applyWorkspaceStatePatch(result, {
    sessionActivities: { [otherKey]: null },
    sessionAcknowledgements: { [key]: null },
  })
  expect(deleted.sessionActivities).toEqual({ [key]: current })
  expect(deleted.sessionAcknowledgements).toEqual({})
})

test("old run acknowledgements cannot acknowledge or replace acknowledgement of a newer run", () => {
  const current = activity()
  const key = sessionIdentityKey(current.file, current.project)
  const viewed = applyWorkspaceStatePatch(emptyWorkspaceState(), {
    sessionActivities: { [key]: current },
    sessionAcknowledgements: { [key]: current.runId },
  })
  const next = applyWorkspaceStatePatch(viewed, {
    sessionActivities: { [key]: { ...current, runId: "run-2", updatedAt: 11 } },
  })
  expect(next.sessionAcknowledgements[key]).not.toBe(next.sessionActivities[key].runId)
  const acknowledged = applyWorkspaceStatePatch(next, { sessionAcknowledgements: { [key]: "run-2" } })
  const late = applyWorkspaceStatePatch(acknowledged, { sessionAcknowledgements: { [key]: "run-1" } })
  expect(late.sessionAcknowledgements[key]).toBe("run-2")
})

test("stable run IDs replace local placeholders despite an earlier timestamp", () => {
  const local = activity({ runId: "local:pending", updatedAt: 100 })
  const key = sessionIdentityKey(local.file, local.project)
  const state = applyWorkspaceStatePatch(emptyWorkspaceState(), { sessionActivities: { [key]: local } })
  const stillLocal = applyWorkspaceStatePatch(state, {
    sessionActivities: { [key]: { ...local, runId: "local:older", updatedAt: 99 } },
  })
  expect(stillLocal.sessionActivities[key]).toEqual(local)
  const stable = { ...local, runId: "server-uuid", updatedAt: 10 }
  const promoted = applyWorkspaceStatePatch(stillLocal, { sessionActivities: { [key]: stable } })
  expect(promoted.sessionActivities[key]).toEqual(stable)
  const older = applyWorkspaceStatePatch(promoted, {
    sessionActivities: { [key]: { ...stable, runId: "older-server-uuid", updatedAt: 9 } },
  })
  expect(older.sessionActivities[key]).toEqual(stable)
})

test("store records and snapshots promote a local placeholder to an earlier stable run", async () => {
  const store = await client()
  const local = activity({ runId: "local:pending", updatedAt: 100 })
  const key = sessionIdentityKey(local.file, local.project)
  store.recordSessionActivity(local)
  await store.flushPersistence()
  const stable = { ...local, runId: "server-uuid", updatedAt: 10 }
  store.recordSessionActivity(stable)
  await store.flushPersistence()
  expect(store.sessionActivities[key]).toEqual(stable)
  expect(backend.sessionActivities![key]).toEqual(stable)
  store.recordSessionActivity({ ...stable, runId: "older-server-uuid", updatedAt: 9 })
  expect(store.sessionActivities[key]).toEqual(stable)
  store.recordSessionActivity({ ...local, runId: "local:next", updatedAt: 200 })
  await store.flushPersistence()
  store.applyState({
    ...backend,
    revision: backend.revision + 1,
    sessionActivities: { [key]: { ...stable, runId: "next-server-uuid", updatedAt: 20 } },
  })
  expect(store.sessionActivities[key].runId).toBe("next-server-uuid")
  expect(store.sessionActivities[key].updatedAt).toBe(20)
})

test("drafts retain empty edits and launched session metadata across restarts until explicitly removed", async () => {
  const store = await client()
  store.upsertBoardDraft(draft())
  await store.flushPersistence()
  store.upsertBoardDraft(
    draft("draft", { message: "", sessionFile: "/real-session.jsonl", runtimeId: "draft", updatedAt: 3 }),
  )
  await store.flushPersistence()
  const reopened = await client()
  expect(reopened.boardDrafts.draft).toEqual(
    draft("draft", {
      message: "",
      sessionFile: "/real-session.jsonl",
      runtimeId: "draft",
      updatedAt: 3,
    }),
  )
  reopened.removeBoardDraft("draft")
  await reopened.flushPersistence()
  expect(store.boardDrafts).toEqual({})
  expect((await client()).boardDrafts).toEqual({})
})

test("two clients independently patch drafts and activities through workspace events", async () => {
  const desktop = await client()
  const remote = await client()
  const localActivity = activity()
  const remoteActivity = activity({ project: "ssh://dev@host/project", status: "completed" })
  desktop.upsertBoardDraft(draft("desktop"))
  remote.upsertBoardDraft(draft("remote"))
  desktop.recordSessionActivity(localActivity)
  remote.recordSessionActivity(remoteActivity)
  await Promise.all([desktop.flushPersistence(), remote.flushPersistence()])
  expect(Object.keys(desktop.boardDrafts).sort()).toEqual(["desktop", "remote"])
  expect(remote.boardDrafts).toEqual(desktop.boardDrafts)
  expect(remote.sessionActivities).toEqual({
    [sessionIdentityKey(localActivity.file, localActivity.project)]: localActivity,
    [sessionIdentityKey(remoteActivity.file, remoteActivity.project)]: remoteActivity,
  })
  remote.removeBoardDraft("remote")
  await remote.flushPersistence()
  expect(Object.keys(desktop.boardDrafts)).toEqual(["desktop"])
  expect(
    mocks.update.mock.calls.every(([patch]) => !patch.boardDrafts || Object.keys(patch.boardDrafts).length === 1),
  ).toBe(true)
})

test("store ignores older activities and acknowledges only the specified current run across restart", async () => {
  const store = await client()
  const current = activity({ status: "completed" })
  const key = sessionIdentityKey(current.file, current.project)
  store.recordSessionActivity(current)
  store.acknowledgeSessionActivity(current.file, current.project, current.runId)
  await store.flushPersistence()
  const reopened = await client()
  expect(reopened.sessionActivities[key]).toEqual(current)
  expect(reopened.sessionAcknowledgements[key]).toBe("run-1")
  reopened.recordSessionActivity({ ...current, runId: "run-2", updatedAt: 20, status: "running" })
  reopened.recordSessionActivity({ ...current, updatedAt: 19 })
  reopened.acknowledgeSessionActivity(current.file, current.project, "run-1")
  await reopened.flushPersistence()
  expect(reopened.sessionActivities[key].runId).toBe("run-2")
  expect(reopened.sessionAcknowledgements[key]).toBe("run-1")
  reopened.acknowledgeSessionActivity(current.file, current.project, "run-2")
  await reopened.flushPersistence()
  expect(store.sessionAcknowledgements[key]).toBe("run-2")
})

test("queued edits survive incoming events and an older write response", async () => {
  const store = await client()
  let acknowledge!: (state: WorkspaceState) => void
  mocks.update.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        acknowledge = resolve
      }),
  )
  store.upsertBoardDraft(draft("local"))
  const saving = store.flushPersistence()
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"))
  const oldResponse = { ...emptyWorkspaceState(), revision: 1, boardDrafts: { local: draft("local") } }
  backend = { ...oldResponse, revision: 2, boardDrafts: { ...oldResponse.boardDrafts, remote: draft("remote") } }
  store.applyState(structuredClone(backend))
  store.upsertBoardDraft(draft("local", { message: "Edited while saving", updatedAt: 3 }))
  store.removeBoardDraft("remote")
  acknowledge(oldResponse)
  await saving
  expect(store.boardDrafts).toEqual({ local: draft("local", { message: "Edited while saving", updatedAt: 3 }) })
  expect(backend.boardDrafts).toEqual(store.boardDrafts)
  store.applyState(oldResponse)
  expect(store.boardDrafts.local.message).toBe("Edited while saving")
})

test("newer workspace snapshots cannot regress an activity timestamp", async () => {
  const store = await client()
  const current = activity({ updatedAt: 20, status: "completed" })
  const key = sessionIdentityKey(current.file, current.project)
  store.applyState({ ...emptyWorkspaceState(), revision: 1, sessionActivities: { [key]: current } })
  store.applyState({
    ...emptyWorkspaceState(),
    revision: 2,
    sessionActivities: { [key]: { ...current, updatedAt: 19, status: "running" } },
  })
  expect(store.sessionActivities[key]).toEqual(current)
  store.applyState({ ...emptyWorkspaceState(), revision: 3 })
  expect(store.sessionActivities).toEqual({})
})

test("offline activity and ack patches cannot regress a newer run on reconnect", async () => {
  const store = await client()
  const current = activity({ status: "completed" })
  const key = sessionIdentityKey(current.file, current.project)
  vi.spyOn(console, "warn").mockImplementation(() => {})
  mocks.update.mockRejectedValue(new Error("offline"))
  store.upsertBoardDraft(draft("offline"))
  store.recordSessionActivity(current)
  store.acknowledgeSessionActivity(current.file, current.project, current.runId)
  await expect(store.flushPersistence()).rejects.toThrow("offline")
  commit({
    boardDrafts: { online: draft("online") },
    sessionActivities: { [key]: { ...current, runId: "run-2", status: "running", updatedAt: 20 } },
    sessionAcknowledgements: { [key]: "run-2" },
  })
  expect(store.sessionActivities[key].runId).toBe("run-2")
  expect(store.sessionAcknowledgements[key]).toBe("run-2")
  mocks.update.mockImplementation(async patch => commit(patch))
  await store.syncState()
  expect(Object.keys(store.boardDrafts).sort()).toEqual(["offline", "online"])
  expect(store.sessionActivities[key].runId).toBe("run-2")
  expect(store.sessionAcknowledgements[key]).toBe("run-2")
  expect(store.persistenceError).toBe(null)
})

test("edits before hydration preserve saved records and drafts have no count limit", async () => {
  backend = {
    ...emptyWorkspaceState(),
    boardDrafts: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`saved-${i}`, draft(`saved-${i}`)])),
  }
  const store = await client(false)
  store.upsertBoardDraft(draft("new"))
  await store.flushPersistence()
  expect(Object.keys(store.boardDrafts)).toHaveLength(1002)
  expect(Object.keys((await client()).boardDrafts)).toHaveLength(1002)
})
