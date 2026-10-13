import { afterEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { applyWorkspaceStatePatch, emptyWorkspaceState } from "@/lib/workspaceState"

const mocks = vi.hoisted(() => {
  const state = {
    backend: null,
    stores: [],
    patches: [],
    getWorkspaceState: null,
    updateWorkspaceState: null,
    requests: [],
    writes: [],
    invokes: [],
    updateSession: async (...args) => {
      state.writes.push(args)
    },
    workspaceGitInfo: async () => {
      throw new Error("not a repository")
    },
  }
  return state
})

vi.mock("@/api/piClient", () => ({
  listSessions: path =>
    new Promise(resolve => {
      mocks.requests.push({ path, resolve })
    }),
  updateSession: (...args) => mocks.updateSession(...args),
  workspaceGitInfo: (...args) => mocks.workspaceGitInfo(...args),
  pixLog: () => {},
  getWorkspaceState: () => mocks.getWorkspaceState(),
  updateWorkspaceState: patch => mocks.updateWorkspaceState(patch),
}))

vi.mock("@/api/transport", () => ({
  invoke: async (...args) => {
    mocks.invokes.push(args)
  },
}))

async function harness(backend = { state: emptyWorkspaceState() }) {
  mocks.backend = backend
  mocks.getWorkspaceState = async () => structuredClone(backend.state)
  mocks.updateWorkspaceState = async patch => {
    mocks.patches.push(patch)
    backend.state = applyWorkspaceStatePatch(backend.state, patch)
    backend.state.revision++
    return structuredClone(backend.state)
  }
  mocks.requests.length = 0
  mocks.writes.length = 0
  mocks.invokes.length = 0
  mocks.updateSession = async (...args) => {
    mocks.writes.push(args)
  }
  mocks.workspaceGitInfo = async () => {
    throw new Error("not a repository")
  }
  vi.resetModules()
  setActivePinia(createPinia())
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() })
  const { useWorkspaceStore } = await import("@/stores/workspace")
  const store = useWorkspaceStore()
  mocks.stores.push(store)
  await store.initialize()
  return {
    store,
    requests: mocks.requests,
    writes: mocks.writes,
    invokes: mocks.invokes,
    backend,
    get updateSession() {
      return mocks.updateSession
    },
    set updateSession(value) {
      mocks.updateSession = value
    },
    get workspaceGitInfo() {
      return mocks.workspaceGitInfo
    },
    set workspaceGitInfo(value) {
      mocks.workspaceGitInfo = value
    },
  }
}

afterEach(async () => {
  await Promise.all(mocks.stores.splice(0).map(store => store.flushPersistence().catch(() => {})))
  vi.unstubAllGlobals()
})

test("projects are persisted without duplicates", async () => {
  const h = await harness()
  h.store.remember("C:/one")
  h.store.remember("C:/one")
  h.store.remember("C:/two")
  await h.store.flushPersistence()
  expect(h.backend.state.projects).toEqual(["C:/two", "C:/one"])
})
test("old localStorage projects are neither read nor migrated", async () => {
  const h = await harness()
  const getItem = vi.fn(() => JSON.stringify(["C:/legacy"]))
  const setItem = vi.fn()
  vi.stubGlobal("localStorage", { getItem, setItem })
  setActivePinia(createPinia())
  const { useWorkspaceStore } = await import("@/stores/workspace")
  const store = useWorkspaceStore()
  await store.initialize()
  expect(store.projects).toEqual([])
  expect(getItem).not.toHaveBeenCalled()
  expect(setItem).not.toHaveBeenCalled()
  await h.store.flushPersistence()
  expect(h.backend.state.projects).toEqual([])
})
test("new project folders are stored with forward slashes and reject equivalent paths", async () => {
  const h = await harness()
  h.store.createProject({ name: "PiX", primary: "C:\\code\\pi-x", folders: ["C:\\code\\pi-x"] })
  expect(Array.from(h.store.orderedProjects())).toEqual(["C:/code/pi-x"])
  await h.store.flushPersistence()
  expect(h.backend.state.projectGroups["C:/code/pi-x"].folders).toEqual(["C:/code/pi-x"])
  expect(() =>
    h.store.createProject({ name: "Duplicate", primary: "C:/code/pi-x", folders: ["C:/code/pi-x"] }),
  ).toThrow()
})
test("named projects keep all folders and selected primary without duplicating navigation entries", async () => {
  const h = await harness()
  h.store.createProject({ name: "Workspace", folders: ["C:/frontend", "C:/backend"], primary: "C:/backend" })
  expect(Array.from(h.store.orderedProjects())).toEqual(["C:/backend"])
  expect(h.store.projectName("C:/backend")).toBe("Workspace")
  expect(Array.from(h.store.projectFolders("C:/backend"))).toEqual(["C:/frontend", "C:/backend"])
  await h.store.flushPersistence()
  expect(h.backend.state.projectGroups["C:/backend"].primary).toBe("C:/backend")
  await h.store.flushPersistence()
  const reopened = await harness(h.backend)
  expect(reopened.store.projectName("C:/backend")).toBe("Workspace")
  expect(Array.from(reopened.store.projectFolders("C:/backend"))).toEqual(["C:/frontend", "C:/backend"])
  expect(() => h.store.createProject({ name: "Duplicate", folders: ["C:/frontend"], primary: "C:/frontend" })).toThrow()
  h.store.removeProject("C:/backend")
  await h.store.flushPersistence()
  expect(h.backend.state.projectGroups).toEqual({})
})
test("editing a project rekeys its primary and pin while preserving folder session caches", async () => {
  const h = await harness()
  h.store.createProject({ name: "Before", folders: ["C:/old", "C:/new"], primary: "C:/old" })
  h.store.togglePin("C:/old")
  h.store.histories["C:/old"] = [{ file: "old-chat", cwd: "C:/old" }]
  h.store.updateProject("C:/old", { name: "After", folders: ["C:/old", "C:/new"], primary: "C:/new" })
  expect(Array.from(h.store.orderedProjects())).toEqual(["C:/new"])
  await h.store.flushPersistence()
  expect(h.backend.state.pinnedProjects).toEqual(["C:/new"])
  expect(h.store.projectRoot("C:/old")).toBe("C:/new")
  expect(h.store.projectName("C:/old")).toBe("After")
  expect(h.store.histories["C:/old"][0].file).toBe("old-chat")
  h.store.remember("C:/old")
  expect(Array.from(h.store.orderedProjects())).toEqual(["C:/new"])
  await h.store.flushPersistence()
  expect((await harness(h.backend)).store.projectName("C:/new")).toBe("After")
  expect(() =>
    h.store.updateProject("C:/new", { name: "Nope", folders: ["C:/old", "C:/old"], primary: "C:/old" }),
  ).toThrow()
})
test("removed projects stay removed until they are explicitly re-added", async () => {
  const h = await harness()
  h.store.remember("C:/one")
  h.store.removeProject("C:/one")
  expect(Array.from(h.store.projects)).toEqual([])
  await h.store.flushPersistence()
  expect(h.backend.state.removedProjects).toEqual(["C:/one"])
  // Automatic paths (sidebar watcher, session restore) must not resurrect it.
  await h.store.rememberWorkspace("C:/one")
  expect(Array.from(h.store.projects)).toEqual([])
  // Reloading the store from the same storage keeps it removed.
  await h.store.flushPersistence()
  const reopened = await harness(h.backend)
  await reopened.store.rememberWorkspace("C:/one")
  expect(Array.from(reopened.store.projects)).toEqual([])
  // Explicitly creating the project again lifts the marker.
  reopened.store.createProject({ name: "One", primary: "C:/one", folders: ["C:/one"] })
  expect(Array.from(reopened.store.projects)).toEqual(["C:/one"])
  await reopened.store.flushPersistence()
  expect(reopened.backend.state.removedProjects).toEqual([])
  reopened.store.removeProject("C:/one")
  reopened.store.unremoveProject("C:/one")
  reopened.store.remember("C:/one")
  expect(Array.from(reopened.store.projects)).toEqual(["C:/one"])
})
test("refresh sorts by time and ignores stale responses", async () => {
  const h = await harness()
  const a = h.store.refresh("project"),
    b = h.store.refresh("project")
  h.requests[1].resolve([
    { file: "new", mtimeMs: 20 },
    { file: "old", mtimeMs: 10 },
  ])
  await b
  h.requests[0].resolve([{ file: "stale", mtimeMs: 30 }])
  await a
  expect(h.store.histories.project[0].file).toBe("new")
})
test("rename and archive persist and update shared state; restore keeps title", async () => {
  const h = await harness()
  const row = { file: "one.jsonl", preview: "first message" }
  h.store.histories.project = [row]
  await h.store.update(row, "new title", true)
  expect(row.title).toBe("new title")
  expect(row.archived).toBe(true)
  await h.store.update(row, row.title, false)
  expect(row.archived).toBe(false)
  expect(row.title).toBe("new title")
  expect(h.writes[0]).toEqual(["one.jsonl", "new title", true])
})
test("failed metadata write does not change visible title", async () => {
  const h = await harness()
  const row = { file: "one", title: "original", archived: false }
  h.store.histories.project = [row]
  h.updateSession = async () => {
    throw new Error("disk full")
  }
  await expect(h.store.update(row, "changed", true)).rejects.toThrow(/disk full/)
  expect(row.title).toBe("original")
  expect(row.archived).toBe(false)
})
test("a stale list request cannot undo a successful rename", async () => {
  const h = await harness()
  const row = { file: "one", title: "original" }
  h.store.histories.project = [row]
  const refresh = h.store.refresh("project")
  await h.store.update(row, "updated", false)
  h.requests[0].resolve([{ file: "one", title: "original" }])
  await refresh
  expect(h.store.histories.project[0].title).toBe("updated")
})
test("pinning moves a project to the top and unpinning restores normal order", async () => {
  const h = await harness()
  h.store.remember("one")
  h.store.remember("two")
  h.store.togglePin("one")
  expect(Array.from(h.store.orderedProjects())).toEqual(["one", "two"])
  await h.store.flushPersistence()
  expect(h.backend.state.pinnedProjects).toEqual(["one"])
  h.store.togglePin("one")
  expect(Array.from(h.store.orderedProjects())).toEqual(["two", "one"])
  await h.store.flushPersistence()
  expect(h.backend.state.pinnedProjects).toEqual([])
})
test("removing a project clears its pin and cached list but does not modify conversations", async () => {
  const h = await harness()
  h.store.remember("one")
  h.store.remember("two")
  h.store.togglePin("one")
  h.store.histories.one = [{ file: "chat.jsonl" }]
  const request = h.store.refresh("one")
  h.store.removeProject("one")
  h.requests[0].resolve([{ file: "chat.jsonl" }])
  await request
  await h.store.flushPersistence()
  expect(h.backend.state.projects).toEqual(["two"])
  await h.store.flushPersistence()
  expect(h.backend.state.pinnedProjects).toEqual([])
  expect(h.store.histories.one).toBe(undefined)
  expect(h.writes.length).toBe(0)
  // A removed project must not come back through automatic paths.
  h.store.remember("one")
  expect(Array.from(h.store.projects)).toEqual(["two"])
  // Explicitly clearing the removal marker re-registers it.
  h.store.unremoveProject("one")
  h.store.remember("one")
  expect(Array.from(h.store.projects)).toEqual(["one", "two"])
})
test("opening more projects does not evict pinned projects", async () => {
  const h = await harness()
  h.store.remember("pinned")
  h.store.togglePin("pinned")
  for (let i = 0; i < 10; i++) h.store.remember(`project-${i}`)
  expect(h.store.orderedProjects()[0]).toBe("pinned")
})
test("manual project order persists and keeps pinned projects on top", async () => {
  const h = await harness()
  h.store.remember("one")
  h.store.remember("two")
  h.store.remember("three")
  h.store.reorderProjects(["two", "three", "one"])
  expect(Array.from(h.store.projects)).toEqual(["two", "three", "one"])
  await h.store.flushPersistence()
  expect(h.backend.state.projects).toEqual(["two", "three", "one"])
  h.store.togglePin("one")
  expect(Array.from(h.store.orderedProjects())).toEqual(["one", "two", "three"])
})
test("manual session order persists, merges with archived rows, and refresh keeps it", async () => {
  const h = await harness()
  h.store.histories.project = [
    { file: "a", mtimeMs: 3 },
    { file: "b", mtimeMs: 2 },
    { file: "c", mtimeMs: 1, archived: true },
  ]
  h.store.reorderSessions("project", ["b", "a"])
  expect(Array.from(h.store.histories.project, r => r.file)).toEqual(["b", "a", "c"])
  await h.store.flushPersistence()
  expect(h.backend.state.sessionOrder.project).toEqual(["b", "a"])
  const refresh = h.store.refresh("project")
  h.requests[0].resolve([
    { file: "a", mtimeMs: 3 },
    { file: "b", mtimeMs: 2 },
    { file: "c", mtimeMs: 1, archived: true },
  ])
  await refresh
  expect(Array.from(h.store.histories.project, r => r.file)).toEqual(["b", "a", "c"])
})
test("drag order spans every folder in a grouped project and survives refresh", async () => {
  const h = await harness()
  h.store.createProject({ name: "Group", folders: ["front", "back"], primary: "front" })
  h.store.histories.front = [
    { file: "a", mtimeMs: 30 },
    { file: "c", mtimeMs: 10, archived: true },
  ]
  h.store.histories.back = [{ file: "b", mtimeMs: 20 }]
  expect(Array.from(h.store.orderedSessions("front"), r => r.file)).toEqual(["a", "b", "c"])
  h.store.reorderSessions("front", ["b", "a"])
  expect(Array.from(h.store.orderedSessions("front"), r => r.file)).toEqual(["b", "a", "c"])
  const refresh = h.store.refresh("front")
  h.requests[0].resolve([
    { file: "a", mtimeMs: 30 },
    { file: "c", mtimeMs: 10, archived: true },
  ])
  await refresh
  expect(Array.from(h.store.orderedSessions("front"), r => r.file)).toEqual(["b", "a", "c"])
  await h.store.flushPersistence()
  expect(h.backend.state.sessionOrder.front).toEqual(["b", "a"])
  await h.store.flushPersistence()
  const reopened = await harness(h.backend)
  reopened.store.histories.front = h.store.histories.front
  reopened.store.histories.back = h.store.histories.back
  expect(Array.from(reopened.store.orderedSessions("front"), r => r.file)).toEqual(["b", "a", "c"])
})
test("removing a session updates caches without a second file-deletion command", async () => {
  const h = await harness()
  h.store.histories.project = [{ file: "session.jsonl" }]
  h.store.removeSession("session.jsonl")
  await Promise.resolve()
  expect(JSON.parse(JSON.stringify(h.invokes))).toEqual([])
  expect(h.store.histories.project).toEqual([])
})

test("removing a project also clears its session order", async () => {
  const h = await harness()
  h.store.remember("one")
  h.store.histories.one = [{ file: "a", mtimeMs: 1 }]
  h.store.reorderSessions("one", ["a"])
  h.store.removeProject("one")
  await h.store.flushPersistence()
  expect(h.backend.state.sessionOrder).toEqual({})
})

test("worktrees merge into their main project without losing sessions, pins or ordering", async () => {
  const h = await harness({
    state: {
      ...emptyWorkspaceState(),
      projects: ["C:/trees/pi-x", "C:/code/pi-x"],
      pinnedProjects: ["C:/trees/pi-x"],
      sessionOrder: { "C:/trees/pi-x": ["tree-session"] },
    },
  })
  h.store.histories["C:/trees/pi-x"] = [{ file: "tree-session", cwd: "C:/trees/pi-x", mtimeMs: 1 }]
  h.store.histories["C:/code/pi-x"] = [{ file: "main-session", cwd: "C:/code/pi-x", mtimeMs: 2 }]
  h.store.registerWorktrees({ worktrees: [{ path: "C:/code/pi-x" }, { path: "C:/trees/pi-x" }] })
  expect(Array.from(h.store.projects)).toEqual(["C:/code/pi-x"])
  expect(h.store.projectRoot("C:\\trees\\pi-x")).toBe("C:/code/pi-x")
  expect(h.store.isWorktree("C:/trees/pi-x")).toBe(true)
  expect(h.store.isWorktree("C:/code/pi-x")).toBe(false)
  expect(Array.from(h.store.orderedSessions("C:/code/pi-x"), s => s.file)).toEqual(["tree-session", "main-session"])
  await h.store.flushPersistence()
  expect(h.backend.state.pinnedProjects).toEqual(["C:/code/pi-x"])
  h.store.remember("C:/trees/pi-x")
  expect(h.store.projects.length).toBe(1)
})

test("opening an external worktree registers only its main project", async () => {
  const h = await harness()
  h.workspaceGitInfo = async () => ({ worktrees: [{ path: "C:/main" }, { path: "C:/tree" }] })
  await h.store.rememberWorkspace("C:/tree")
  expect(Array.from(h.store.projects)).toEqual(["C:/main"])
  expect(Array.from(h.store.projectFolders("C:/main"))).toEqual(["C:/main", "C:/tree"])
})

test("worktrees of a grouped folder belong to the named project", async () => {
  const h = await harness()
  h.store.createProject({ name: "Combined", primary: "C:/front", folders: ["C:/front", "C:/back"] })
  h.store.registerWorktrees({ worktrees: [{ path: "C:/back" }, { path: "C:/back-tree" }] })
  expect(h.store.projectRoot("C:/back-tree")).toBe("C:/front")
  expect(Array.from(h.store.projectFolders("C:/front"))).toEqual(["C:/front", "C:/back", "C:/back-tree"])
})

test("non-Git directories still register normally", async () => {
  const h = await harness()
  h.workspaceGitInfo = async () => {
    throw new Error("not a repository")
  }
  await h.store.rememberWorkspace("C:/plain")
  expect(Array.from(h.store.projects)).toEqual(["C:/plain"])
})

test("explicitly configured worktree projects keep their grouping and get a badge", async () => {
  const h = await harness()
  h.store.createProject({ name: "Intentional", primary: "C:/tree", folders: ["C:/tree"] })
  h.store.registerWorktrees({ worktrees: [{ path: "C:/main" }, { path: "C:/tree" }] })
  expect(h.store.projectRoot("C:/tree")).toBe("C:/tree")
  expect(h.store.isWorktree("C:/tree")).toBe(true)
  expect(h.store.projectName("C:/tree")).toBe("Intentional")
})

test("backend events synchronize names, folders, pins, removal markers and session order", async () => {
  const h = await harness()
  h.store.histories.one = [
    { file: "a", mtimeMs: 2 },
    { file: "b", mtimeMs: 1 },
  ]
  const state = {
    ...emptyWorkspaceState(),
    revision: 4,
    projects: ["one"],
    pinnedProjects: ["one"],
    projectGroups: { one: { name: "Shared", primary: "one", folders: ["one", "extra"] } },
    removedProjects: ["removed"],
    sessionOrder: { one: ["b", "a"] },
  }
  h.store.applyState(state)
  expect(h.store.projects).toEqual(["one"])
  expect(h.store.pinnedProjects).toEqual(["one"])
  expect(h.store.projectName("extra")).toBe("Shared")
  expect(h.store.projectFolders("one")).toEqual(["one", "extra"])
  expect(h.store.isRemovedProject("removed")).toBe(true)
  expect(h.store.orderedSessions("one").map(row => row.file)).toEqual(["b", "a"])
  h.store.applyState({ ...emptyWorkspaceState(), revision: 3 })
  expect(h.store.projects).toEqual(["one"])
})

test("two clients can add unrelated projects without overwriting each other", async () => {
  const desktop = await harness()
  const web = await harness(desktop.backend)
  desktop.store.remember("desktop")
  web.store.remember("web")
  await Promise.all([desktop.store.flushPersistence(), web.store.flushPersistence()])
  await Promise.all([desktop.store.syncState(), web.store.syncState()])
  expect(new Set(desktop.backend.state.projects)).toEqual(new Set(["desktop", "web"]))
  expect(web.store.projects).toEqual(desktop.store.projects)
})

test("pending edits survive incoming snapshots and an older write acknowledgement", async () => {
  const h = await harness()
  let acknowledge
  mocks.updateWorkspaceState = () =>
    new Promise(resolve => {
      acknowledge = resolve
    })
  h.store.remember("local")
  const saving = h.store.flushPersistence()
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"))
  h.store.applyState({ ...emptyWorkspaceState(), revision: 2, projects: ["remote", "local"] })
  expect(h.store.projects).toEqual(["local", "remote"])
  acknowledge({ ...emptyWorkspaceState(), revision: 1, projects: ["local"] })
  await saving
  expect(h.store.projects).toEqual(["remote", "local"])
})

test("failed writes keep edits queued and reconnect retries them against current backend state", async () => {
  const h = await harness()
  const update = mocks.updateWorkspaceState
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  mocks.updateWorkspaceState = async () => {
    throw new Error("offline")
  }
  h.store.remember("local")
  await expect(h.store.flushPersistence()).rejects.toThrow("offline")
  expect(h.store.projects).toEqual(["local"])
  expect(h.store.persistenceError).toBeInstanceOf(Error)
  h.backend.state.projects = ["remote"]
  h.backend.state.revision++
  mocks.updateWorkspaceState = update
  await h.store.syncState()
  expect(h.store.projects).toEqual(["local", "remote"])
  expect(h.store.persistenceError).toBe(null)
  warning.mockRestore()
})

test("edits made before hydration are replayed without discarding saved projects", async () => {
  const h = await harness({ state: { ...emptyWorkspaceState(), projects: ["saved"] } })
  setActivePinia(createPinia())
  const { useWorkspaceStore } = await import("@/stores/workspace")
  const store = useWorkspaceStore()
  mocks.stores.push(store)
  store.remember("new")
  await store.flushPersistence()
  expect(store.projects).toEqual(["new", "saved"])
  expect(h.backend.state.projects).toEqual(["new", "saved"])
})

test("hydration failure does not write an empty snapshot and can be retried", async () => {
  await harness()
  setActivePinia(createPinia())
  const { useWorkspaceStore } = await import("@/stores/workspace")
  const store = useWorkspaceStore()
  const load = mocks.getWorkspaceState
  const update = vi.fn(mocks.updateWorkspaceState)
  mocks.updateWorkspaceState = update
  mocks.getWorkspaceState = async () => {
    throw new Error("read failed")
  }
  await expect(store.initialize()).rejects.toThrow("read failed")
  expect(update).not.toHaveBeenCalled()
  mocks.getWorkspaceState = load
  await store.initialize()
})

test("changing a grouped project's primary retains persisted session order", async () => {
  const h = await harness()
  h.store.createProject({ name: "Group", primary: "one", folders: ["one", "two"] })
  h.store.reorderSessions("one", ["b", "a"])
  h.store.updateProject("one", { name: "Group", primary: "two", folders: ["one", "two"] })
  await h.store.flushPersistence()
  expect(h.backend.state.sessionOrder).toEqual({ two: ["b", "a"] })
})

test("local group and order mutations never mutate the authoritative snapshot", async () => {
  const h = await harness()
  const state = {
    ...emptyWorkspaceState(),
    revision: 1,
    projects: ["one"],
    projectGroups: { one: { name: "Original", primary: "one", folders: ["one"] } },
    sessionOrder: { one: ["a"] },
  }
  h.store.applyState(state)
  h.store.updateProject("one", { name: "Edited", primary: "one", folders: ["one"] })
  h.store.reorderSessions("one", ["b", "a"])
  expect(state.projectGroups.one.name).toBe("Original")
  expect(state.sessionOrder.one).toEqual(["a"])
  await h.store.flushPersistence()
})

test("late sidebar worktree lookups cannot resurrect removed project-group folders", async () => {
  const h = await harness()
  h.store.createProject({ name: "Group", primary: "one", folders: ["one", "extra"] })
  let resolve
  h.workspaceGitInfo = () =>
    new Promise(done => {
      resolve = done
    })
  const lookup = h.store.registerProjectWorktrees("extra")
  h.store.removeProject("one")
  resolve({ worktrees: [{ path: "extra" }, { path: "extra-tree" }] })
  await lookup
  await h.store.flushPersistence()
  expect(h.store.projects).toEqual([])
  expect(h.backend.state.projects).toEqual([])
  expect(h.store.isWorktree("extra-tree")).toBe(false)
})
