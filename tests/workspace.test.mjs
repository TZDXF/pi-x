import { test } from "node:test"
import assert from "node:assert/strict"
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
  assert.deepEqual(JSON.parse(h.storage.get("pix.recentProjects")), ["C:/two", "C:/one"])
})
test("named projects keep all folders and selected primary without duplicating navigation entries", () => {
  const h = harness()
  h.store.createProject({ name: "Workspace", folders: ["C:/frontend", "C:/backend"], primary: "C:/backend" })
  assert.deepEqual(Array.from(h.store.orderedProjects()), ["C:/backend"])
  assert.equal(h.store.projectName("C:/backend"), "Workspace")
  assert.deepEqual(Array.from(h.store.projectFolders("C:/backend")), ["C:/frontend", "C:/backend"])
  assert.equal(JSON.parse(h.storage.get("pix.projectGroups"))["C:/backend"].primary, "C:/backend")
  const reopened = harness(h.storage)
  assert.equal(reopened.store.projectName("C:/backend"), "Workspace")
  assert.deepEqual(Array.from(reopened.store.projectFolders("C:/backend")), ["C:/frontend", "C:/backend"])
  assert.throws(() => h.store.createProject({ name: "Duplicate", folders: ["C:/frontend"], primary: "C:/frontend" }))
  h.store.removeProject("C:/backend")
  assert.deepEqual(JSON.parse(h.storage.get("pix.projectGroups")), {})
})
test("editing a project rekeys its primary and pin while preserving folder session caches", () => {
  const h = harness()
  h.store.createProject({ name: "Before", folders: ["C:/old", "C:/new"], primary: "C:/old" })
  h.store.togglePin("C:/old")
  h.store.histories.value["C:/old"] = [{ file: "old-chat", cwd: "C:/old" }]
  h.store.updateProject("C:/old", { name: "After", folders: ["C:/old", "C:/new"], primary: "C:/new" })
  assert.deepEqual(Array.from(h.store.orderedProjects()), ["C:/new"])
  assert.deepEqual(JSON.parse(h.storage.get("pix.pinnedProjects")), ["C:/new"])
  assert.equal(h.store.projectRoot("C:/old"), "C:/new")
  assert.equal(h.store.projectName("C:/old"), "After")
  assert.equal(h.store.histories.value["C:/old"][0].file, "old-chat")
  h.store.remember("C:/old")
  assert.deepEqual(Array.from(h.store.orderedProjects()), ["C:/new"])
  assert.equal(harness(h.storage).store.projectName("C:/new"), "After")
  assert.throws(() =>
    h.store.updateProject("C:/new", { name: "Nope", folders: ["C:/old", "C:/old"], primary: "C:/old" }),
  )
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
  assert.equal(h.store.histories.value.project[0].file, "new")
})
test("rename and archive persist and update shared state; restore keeps title", async () => {
  const h = harness()
  const row = { file: "one.jsonl", preview: "first message" }
  h.store.histories.value.project = [row]
  await h.store.update(row, "new title", true)
  assert.equal(row.title, "new title")
  assert.equal(row.archived, true)
  await h.store.update(row, row.title, false)
  assert.equal(row.archived, false)
  assert.equal(row.title, "new title")
  assert.deepEqual(h.writes[0], ["one.jsonl", "new title", true])
})
test("failed metadata write does not change visible title", async () => {
  const h = harness()
  const row = { file: "one", title: "original", archived: false }
  h.store.histories.value.project = [row]
  h.context.updateSession = async () => {
    throw new Error("disk full")
  }
  await assert.rejects(h.store.update(row, "changed", true), /disk full/)
  assert.equal(row.title, "original")
  assert.equal(row.archived, false)
})
test("a stale list request cannot undo a successful rename", async () => {
  const h = harness()
  const row = { file: "one", title: "original" }
  h.store.histories.value.project = [row]
  const refresh = h.store.refresh("project")
  await h.store.update(row, "updated", false)
  h.requests[0].resolve([{ file: "one", title: "original" }])
  await refresh
  assert.equal(h.store.histories.value.project[0].title, "updated")
})
test("pinning moves a project to the top and unpinning restores normal order", () => {
  const h = harness()
  h.store.remember("one")
  h.store.remember("two")
  h.store.togglePin("one")
  assert.deepEqual(Array.from(h.store.orderedProjects()), ["one", "two"])
  assert.deepEqual(JSON.parse(h.storage.get("pix.pinnedProjects")), ["one"])
  h.store.togglePin("one")
  assert.deepEqual(Array.from(h.store.orderedProjects()), ["two", "one"])
  assert.deepEqual(JSON.parse(h.storage.get("pix.pinnedProjects")), [])
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
  assert.deepEqual(JSON.parse(h.storage.get("pix.recentProjects")), ["two"])
  assert.deepEqual(JSON.parse(h.storage.get("pix.pinnedProjects")), [])
  assert.equal(h.store.histories.value.one, undefined)
  assert.equal(h.writes.length, 0)
  h.store.remember("one")
  assert.deepEqual(Array.from(h.store.projects.value), ["one", "two"])
})
test("opening more projects does not evict pinned projects", () => {
  const h = harness()
  h.store.remember("pinned")
  h.store.togglePin("pinned")
  for (let i = 0; i < 10; i++) h.store.remember(`project-${i}`)
  assert.equal(h.store.orderedProjects()[0], "pinned")
})
test("manual project order persists and keeps pinned projects on top", () => {
  const h = harness()
  h.store.remember("one")
  h.store.remember("two")
  h.store.remember("three")
  h.store.reorderProjects(["two", "three", "one"])
  assert.deepEqual(Array.from(h.store.projects.value), ["two", "three", "one"])
  assert.deepEqual(JSON.parse(h.storage.get("pix.recentProjects")), ["two", "three", "one"])
  h.store.togglePin("one")
  assert.deepEqual(Array.from(h.store.orderedProjects()), ["one", "two", "three"])
})
test("manual session order persists, merges with archived rows, and refresh keeps it", async () => {
  const h = harness()
  h.store.histories.value.project = [
    { file: "a", mtimeMs: 3 },
    { file: "b", mtimeMs: 2 },
    { file: "c", mtimeMs: 1, archived: true },
  ]
  h.store.reorderSessions("project", ["b", "a"])
  assert.deepEqual(
    Array.from(h.store.histories.value.project, r => r.file),
    ["b", "a", "c"],
  )
  assert.deepEqual(JSON.parse(h.storage.get("pix.sessionOrder")).project, ["b", "a"])
  const refresh = h.store.refresh("project")
  h.requests[0].resolve([
    { file: "a", mtimeMs: 3 },
    { file: "b", mtimeMs: 2 },
    { file: "c", mtimeMs: 1, archived: true },
  ])
  await refresh
  assert.deepEqual(
    Array.from(h.store.histories.value.project, r => r.file),
    ["b", "a", "c"],
  )
})
test("drag order spans every folder in a grouped project and survives refresh", async () => {
  const h = harness()
  h.store.createProject({ name: "Group", folders: ["front", "back"], primary: "front" })
  h.store.histories.value.front = [
    { file: "a", mtimeMs: 30 },
    { file: "c", mtimeMs: 10, archived: true },
  ]
  h.store.histories.value.back = [{ file: "b", mtimeMs: 20 }]
  assert.deepEqual(
    Array.from(h.store.orderedSessions("front"), r => r.file),
    ["a", "b", "c"],
  )
  h.store.reorderSessions("front", ["b", "a"])
  assert.deepEqual(
    Array.from(h.store.orderedSessions("front"), r => r.file),
    ["b", "a", "c"],
  )
  const refresh = h.store.refresh("front")
  h.requests[0].resolve([
    { file: "a", mtimeMs: 30 },
    { file: "c", mtimeMs: 10, archived: true },
  ])
  await refresh
  assert.deepEqual(
    Array.from(h.store.orderedSessions("front"), r => r.file),
    ["b", "a", "c"],
  )
  assert.deepEqual(JSON.parse(h.storage.get("pix.sessionOrder")).front, ["b", "a"])
  const reopened = harness(h.storage)
  reopened.store.histories.value.front = h.store.histories.value.front
  reopened.store.histories.value.back = h.store.histories.value.back
  assert.deepEqual(
    Array.from(reopened.store.orderedSessions("front"), r => r.file),
    ["b", "a", "c"],
  )
})
test("removing a session deletes its checkpoint manifest", async () => {
  const h = harness()
  h.store.histories.value.project = [{ file: "session.jsonl" }]
  h.store.removeSession("session.jsonl")
  await Promise.resolve()
  assert.deepEqual(JSON.parse(JSON.stringify(h.invokes)), [
    ["session_checkpoint_manifest_delete", { file: "session.jsonl" }],
  ])
})

test("removing a project also clears its session order", () => {
  const h = harness()
  h.store.remember("one")
  h.store.histories.value.one = [{ file: "a", mtimeMs: 1 }]
  h.store.reorderSessions("one", ["a"])
  h.store.removeProject("one")
  assert.deepEqual(JSON.parse(h.storage.get("pix.sessionOrder")), {})
})
