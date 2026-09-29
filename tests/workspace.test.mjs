import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { pathsModule } from "./lib/load-ts.mjs"
const paths = pathsModule()
function harness(initialStorage = new Map()) {
  const source =
    readFileSync(new URL("../src/stores/workspace.ts", import.meta.url), "utf8")
      .replace(/^import .*$/gm, "")
      .replace(/export /g, "") + "\nglobalThis.store = useWorkspaceStore();"
  const requests = [],
    writes = [],
    invokes = [],
    storage = initialStorage
  const context = vm.createContext({
    defineStore: (_, setup) => setup,
    ref: value => ({ value }),
    listSessions: path => new Promise(resolve => requests.push({ path, resolve })),
    updateSession: async (...args) => writes.push(args),
    invoke: async (command, args) => {
      invokes.push([command, args])
    },
    localStorage: { getItem: key => storage.get(key), setItem: (k, v) => storage.set(k, v) },
    samePath: paths.samePath,
    normalizeProjectPath: paths.normalizeProjectPath,
    baseName: paths.baseName,
  })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context)
  return { store: context.store, requests, writes, invokes, storage, context }
}
test("projects are persisted without duplicates", () => {
  const h = harness()
  h.store.remember("C:/one")
  h.store.remember("C:/one")
  h.store.remember("C:/two")
  expect(JSON.parse(h.storage.get("pix.recentProjects"))).toEqual(["C:/two", "C:/one"])
})
test("legacy Windows path variants merge with pins, groups and order", () => {
  const storage = new Map([
    ["pix.recentProjects", JSON.stringify(["C:\\code\\pi-x", "C:/code/pi-x", "C:\\code\\other"])],
    ["pix.pinnedProjects", JSON.stringify(["C:/code/pi-x"])],
    [
      "pix.projectGroups",
      JSON.stringify({ "C:/code/pi-x": { name: "PiX", primary: "C:/code/pi-x", folders: ["C:/code/pi-x"] } }),
    ],
    ["pix.sessionOrder", JSON.stringify({ "C:\\code\\pi-x": ["chat.jsonl"] })],
  ])
  const h = harness(storage)
  expect(Array.from(h.store.projects.value)).toEqual(["C:/code/pi-x", "C:/code/other"])
  expect(JSON.parse(storage.get("pix.pinnedProjects"))).toEqual(["C:/code/pi-x"])
  expect(h.store.projectName("C:\\code\\pi-x")).toBe("PiX")
  expect(JSON.parse(storage.get("pix.sessionOrder"))["C:/code/pi-x"]).toEqual(["chat.jsonl"])
  h.store.remember("C:\\CODE\\pi-x\\")
  expect(h.store.projects.value.length).toBe(2)
})
test("new project folders are stored with forward slashes and reject equivalent paths", () => {
  const h = harness()
  h.store.createProject({ name: "PiX", primary: "C:\\code\\pi-x", folders: ["C:\\code\\pi-x"] })
  expect(Array.from(h.store.orderedProjects())).toEqual(["C:/code/pi-x"])
  expect(JSON.parse(h.storage.get("pix.projectGroups"))["C:/code/pi-x"].folders).toEqual(["C:/code/pi-x"])
  expect(() =>
    h.store.createProject({ name: "Duplicate", primary: "C:/code/pi-x", folders: ["C:/code/pi-x"] }),
  ).toThrow()
})
test("named projects keep all folders and selected primary without duplicating navigation entries", () => {
  const h = harness()
  h.store.createProject({ name: "Workspace", folders: ["C:/frontend", "C:/backend"], primary: "C:/backend" })
  expect(Array.from(h.store.orderedProjects())).toEqual(["C:/backend"])
  expect(h.store.projectName("C:/backend")).toBe("Workspace")
  expect(Array.from(h.store.projectFolders("C:/backend"))).toEqual(["C:/frontend", "C:/backend"])
  expect(JSON.parse(h.storage.get("pix.projectGroups"))["C:/backend"].primary).toBe("C:/backend")
  const reopened = harness(h.storage)
  expect(reopened.store.projectName("C:/backend")).toBe("Workspace")
  expect(Array.from(reopened.store.projectFolders("C:/backend"))).toEqual(["C:/frontend", "C:/backend"])
  expect(() => h.store.createProject({ name: "Duplicate", folders: ["C:/frontend"], primary: "C:/frontend" })).toThrow()
  h.store.removeProject("C:/backend")
  expect(JSON.parse(h.storage.get("pix.projectGroups"))).toEqual({})
})
test("editing a project rekeys its primary and pin while preserving folder session caches", () => {
  const h = harness()
  h.store.createProject({ name: "Before", folders: ["C:/old", "C:/new"], primary: "C:/old" })
  h.store.togglePin("C:/old")
  h.store.histories.value["C:/old"] = [{ file: "old-chat", cwd: "C:/old" }]
  h.store.updateProject("C:/old", { name: "After", folders: ["C:/old", "C:/new"], primary: "C:/new" })
  expect(Array.from(h.store.orderedProjects())).toEqual(["C:/new"])
  expect(JSON.parse(h.storage.get("pix.pinnedProjects"))).toEqual(["C:/new"])
  expect(h.store.projectRoot("C:/old")).toBe("C:/new")
  expect(h.store.projectName("C:/old")).toBe("After")
  expect(h.store.histories.value["C:/old"][0].file).toBe("old-chat")
  h.store.remember("C:/old")
  expect(Array.from(h.store.orderedProjects())).toEqual(["C:/new"])
  expect(harness(h.storage).store.projectName("C:/new")).toBe("After")
  expect(() =>
    h.store.updateProject("C:/new", { name: "Nope", folders: ["C:/old", "C:/old"], primary: "C:/old" }),
  ).toThrow()
})
test("removed projects stay removed until they are explicitly re-added", async () => {
  const h = harness()
  h.store.remember("C:/one")
  h.store.removeProject("C:/one")
  expect(Array.from(h.store.projects.value)).toEqual([])
  expect(JSON.parse(h.storage.get("pix.removedProjects"))).toEqual(["C:/one"])
  // Automatic paths (sidebar watcher, session restore) must not resurrect it.
  await h.store.rememberWorkspace("C:/one")
  expect(Array.from(h.store.projects.value)).toEqual([])
  // Reloading the store from the same storage keeps it removed.
  const reopened = harness(h.storage)
  await reopened.store.rememberWorkspace("C:/one")
  expect(Array.from(reopened.store.projects.value)).toEqual([])
  // Explicitly creating the project again lifts the marker.
  reopened.store.createProject({ name: "One", primary: "C:/one", folders: ["C:/one"] })
  expect(Array.from(reopened.store.projects.value)).toEqual(["C:/one"])
  expect(JSON.parse(reopened.storage.get("pix.removedProjects"))).toEqual([])
  reopened.store.removeProject("C:/one")
  reopened.store.unremoveProject("C:/one")
  reopened.store.remember("C:/one")
  expect(Array.from(reopened.store.projects.value)).toEqual(["C:/one"])
})
test("refresh sorts by time and ignores stale responses", async () => {
  const h = harness()
  const a = h.store.refresh("project"),
    b = h.store.refresh("project")
  h.requests[1].resolve([
    { file: "new", mtimeMs: 20 },
    { file: "old", mtimeMs: 10 },
  ])
  await b
  h.requests[0].resolve([{ file: "stale", mtimeMs: 30 }])
  await a
  expect(h.store.histories.value.project[0].file).toBe("new")
})
test("rename and archive persist and update shared state; restore keeps title", async () => {
  const h = harness()
  const row = { file: "one.jsonl", preview: "first message" }
  h.store.histories.value.project = [row]
  await h.store.update(row, "new title", true)
  expect(row.title).toBe("new title")
  expect(row.archived).toBe(true)
  await h.store.update(row, row.title, false)
  expect(row.archived).toBe(false)
  expect(row.title).toBe("new title")
  expect(h.writes[0]).toEqual(["one.jsonl", "new title", true])
})
test("failed metadata write does not change visible title", async () => {
  const h = harness()
  const row = { file: "one", title: "original", archived: false }
  h.store.histories.value.project = [row]
  h.context.updateSession = async () => {
    throw new Error("disk full")
  }
  await expect(h.store.update(row, "changed", true)).rejects.toThrow(/disk full/)
  expect(row.title).toBe("original")
  expect(row.archived).toBe(false)
})
test("a stale list request cannot undo a successful rename", async () => {
  const h = harness()
  const row = { file: "one", title: "original" }
  h.store.histories.value.project = [row]
  const refresh = h.store.refresh("project")
  await h.store.update(row, "updated", false)
  h.requests[0].resolve([{ file: "one", title: "original" }])
  await refresh
  expect(h.store.histories.value.project[0].title).toBe("updated")
})
test("pinning moves a project to the top and unpinning restores normal order", () => {
  const h = harness()
  h.store.remember("one")
  h.store.remember("two")
  h.store.togglePin("one")
  expect(Array.from(h.store.orderedProjects())).toEqual(["one", "two"])
  expect(JSON.parse(h.storage.get("pix.pinnedProjects"))).toEqual(["one"])
  h.store.togglePin("one")
  expect(Array.from(h.store.orderedProjects())).toEqual(["two", "one"])
  expect(JSON.parse(h.storage.get("pix.pinnedProjects"))).toEqual([])
})
test("removing a project clears its pin and cached list but does not modify conversations", async () => {
  const h = harness()
  h.store.remember("one")
  h.store.remember("two")
  h.store.togglePin("one")
  h.store.histories.value.one = [{ file: "chat.jsonl" }]
  const request = h.store.refresh("one")
  h.store.removeProject("one")
  h.requests[0].resolve([{ file: "chat.jsonl" }])
  await request
  expect(JSON.parse(h.storage.get("pix.recentProjects"))).toEqual(["two"])
  expect(JSON.parse(h.storage.get("pix.pinnedProjects"))).toEqual([])
  expect(h.store.histories.value.one).toBe(undefined)
  expect(h.writes.length).toBe(0)
  // A removed project must not come back through automatic paths.
  h.store.remember("one")
  expect(Array.from(h.store.projects.value)).toEqual(["two"])
  // Explicitly clearing the removal marker re-registers it.
  h.store.unremoveProject("one")
  h.store.remember("one")
  expect(Array.from(h.store.projects.value)).toEqual(["one", "two"])
})
test("opening more projects does not evict pinned projects", () => {
  const h = harness()
  h.store.remember("pinned")
  h.store.togglePin("pinned")
  for (let i = 0; i < 10; i++) h.store.remember(`project-${i}`)
  expect(h.store.orderedProjects()[0]).toBe("pinned")
})
test("manual project order persists and keeps pinned projects on top", () => {
  const h = harness()
  h.store.remember("one")
  h.store.remember("two")
  h.store.remember("three")
  h.store.reorderProjects(["two", "three", "one"])
  expect(Array.from(h.store.projects.value)).toEqual(["two", "three", "one"])
  expect(JSON.parse(h.storage.get("pix.recentProjects"))).toEqual(["two", "three", "one"])
  h.store.togglePin("one")
  expect(Array.from(h.store.orderedProjects())).toEqual(["one", "two", "three"])
})
test("manual session order persists, merges with archived rows, and refresh keeps it", async () => {
  const h = harness()
  h.store.histories.value.project = [
    { file: "a", mtimeMs: 3 },
    { file: "b", mtimeMs: 2 },
    { file: "c", mtimeMs: 1, archived: true },
  ]
  h.store.reorderSessions("project", ["b", "a"])
  expect(Array.from(h.store.histories.value.project, r => r.file)).toEqual(["b", "a", "c"])
  expect(JSON.parse(h.storage.get("pix.sessionOrder")).project).toEqual(["b", "a"])
  const refresh = h.store.refresh("project")
  h.requests[0].resolve([
    { file: "a", mtimeMs: 3 },
    { file: "b", mtimeMs: 2 },
    { file: "c", mtimeMs: 1, archived: true },
  ])
  await refresh
  expect(Array.from(h.store.histories.value.project, r => r.file)).toEqual(["b", "a", "c"])
})
test("drag order spans every folder in a grouped project and survives refresh", async () => {
  const h = harness()
  h.store.createProject({ name: "Group", folders: ["front", "back"], primary: "front" })
  h.store.histories.value.front = [
    { file: "a", mtimeMs: 30 },
    { file: "c", mtimeMs: 10, archived: true },
  ]
  h.store.histories.value.back = [{ file: "b", mtimeMs: 20 }]
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
  expect(JSON.parse(h.storage.get("pix.sessionOrder")).front).toEqual(["b", "a"])
  const reopened = harness(h.storage)
  reopened.store.histories.value.front = h.store.histories.value.front
  reopened.store.histories.value.back = h.store.histories.value.back
  expect(Array.from(reopened.store.orderedSessions("front"), r => r.file)).toEqual(["b", "a", "c"])
})
test("removing a session deletes its checkpoint manifest", async () => {
  const h = harness()
  h.store.histories.value.project = [{ file: "session.jsonl" }]
  h.store.removeSession("session.jsonl")
  await Promise.resolve()
  expect(JSON.parse(JSON.stringify(h.invokes))).toEqual([
    ["session_checkpoint_manifest_delete", { file: "session.jsonl" }],
  ])
})

test("removing a project also clears its session order", () => {
  const h = harness()
  h.store.remember("one")
  h.store.histories.value.one = [{ file: "a", mtimeMs: 1 }]
  h.store.reorderSessions("one", ["a"])
  h.store.removeProject("one")
  expect(JSON.parse(h.storage.get("pix.sessionOrder"))).toEqual({})
})

test("worktrees merge into their main project without losing sessions, pins or ordering", () => {
  const h = harness(
    new Map([
      ["pix.recentProjects", JSON.stringify(["C:/trees/pi-x", "C:/code/pi-x"])],
      ["pix.pinnedProjects", JSON.stringify(["C:/trees/pi-x"])],
      ["pix.sessionOrder", JSON.stringify({ "C:/trees/pi-x": ["tree-session"] })],
    ]),
  )
  h.store.histories.value["C:/trees/pi-x"] = [{ file: "tree-session", cwd: "C:/trees/pi-x", mtimeMs: 1 }]
  h.store.histories.value["C:/code/pi-x"] = [{ file: "main-session", cwd: "C:/code/pi-x", mtimeMs: 2 }]
  h.store.registerWorktrees({ worktrees: [{ path: "C:/code/pi-x" }, { path: "C:/trees/pi-x" }] })
  expect(Array.from(h.store.projects.value)).toEqual(["C:/code/pi-x"])
  expect(h.store.projectRoot("C:\\trees\\pi-x")).toBe("C:/code/pi-x")
  expect(h.store.isWorktree("C:/trees/pi-x")).toBe(true)
  expect(h.store.isWorktree("C:/code/pi-x")).toBe(false)
  expect(Array.from(h.store.orderedSessions("C:/code/pi-x"), s => s.file)).toEqual(["tree-session", "main-session"])
  expect(JSON.parse(h.storage.get("pix.pinnedProjects"))).toEqual(["C:/code/pi-x"])
  h.store.remember("C:/trees/pi-x")
  expect(h.store.projects.value.length).toBe(1)
})

test("opening an external worktree registers only its main project", async () => {
  const h = harness()
  h.context.workspaceGitInfo = async () => ({ worktrees: [{ path: "C:/main" }, { path: "C:/tree" }] })
  await h.store.rememberWorkspace("C:/tree")
  expect(Array.from(h.store.projects.value)).toEqual(["C:/main"])
  expect(Array.from(h.store.projectFolders("C:/main"))).toEqual(["C:/main", "C:/tree"])
})

test("worktrees of a grouped folder belong to the named project", () => {
  const h = harness()
  h.store.createProject({ name: "Combined", primary: "C:/front", folders: ["C:/front", "C:/back"] })
  h.store.registerWorktrees({ worktrees: [{ path: "C:/back" }, { path: "C:/back-tree" }] })
  expect(h.store.projectRoot("C:/back-tree")).toBe("C:/front")
  expect(Array.from(h.store.projectFolders("C:/front"))).toEqual(["C:/front", "C:/back", "C:/back-tree"])
})

test("non-Git directories still register normally", async () => {
  const h = harness()
  h.context.workspaceGitInfo = async () => {
    throw new Error("not a repository")
  }
  await h.store.rememberWorkspace("C:/plain")
  expect(Array.from(h.store.projects.value)).toEqual(["C:/plain"])
})

test("explicitly configured worktree projects keep their grouping and get a badge", () => {
  const h = harness()
  h.store.createProject({ name: "Intentional", primary: "C:/tree", folders: ["C:/tree"] })
  h.store.registerWorktrees({ worktrees: [{ path: "C:/main" }, { path: "C:/tree" }] })
  expect(h.store.projectRoot("C:/tree")).toBe("C:/tree")
  expect(h.store.isWorktree("C:/tree")).toBe(true)
  expect(h.store.projectName("C:/tree")).toBe("Intentional")
})
