import { readFileSync } from "node:fs"
import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, reactive, ref } from "vue"
import * as vue from "vue"
import { transpileModule, ModuleKind, ScriptTarget } from "typescript"
import * as paths from "@/lib/paths"
import * as identities from "@/lib/sessionIdentity"
import { isRemoteProject } from "@/lib/ssh"
import { useWorkspaceLayout } from "@/composables/useWorkspaceLayout"
import { kanbanLivePreview } from "@/lib/kanbanLivePreview"
import { groupKanbanCards } from "@/lib/kanban"
import { sidebarSessionRows } from "@/components/workspace/sidebar/useSidebarSessionOrdering"

const source = readFileSync(new URL("../src/composables/useKanbanWorkspace.ts", import.meta.url), "utf8")
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.unstubAllGlobals()
})

function harness(historyLoaded = true) {
  const owners = reactive(new Map())
  const interfaces = reactive(new Map())
  const activities = reactive(new Map())
  const statuses = reactive(new Map())
  const composerDrafts = reactive(new Map())
  let sequence = 0
  const sessionFor = vi.fn(id => {
    if (!owners.has(id))
      owners.set(
        id,
        reactive({
          runtimeId: id,
          cwd: "",
          sessionFile: null,
          entries: [],
          partialBlocks: null,
          runs: {},
          promptQueue: [],
          isStreaming: false,
          isCompacting: false,
          retryInfo: null,
          loadOfflineModels: vi.fn(async () => {}),
          setDesiredModel: vi.fn(),
          setDesiredThinkingLevel: vi.fn(),
        }),
      )
    return owners.get(id)
  })
  const uiFor = id => {
    if (!interfaces.has(id)) interfaces.set(id, reactive({ activeDialog: null }))
    return interfaces.get(id)
  }
  const workspace = reactive({
    boardDrafts: {},
    sessionActivities: {},
    sessionAcknowledgements: {},
    histories: historyLoaded ? { "/root": [], "/root/linked": [], "/loose": [] } : {},
    projectless: "/loose",
    ensureProjectless: vi.fn(async () => {
      workspace.projectless = "/loose"
      return workspace.projectless
    }),
    orderedProjects: () => ["/root"],
    projectFolders: () => ["/root", "/root/linked"],
    projectRoot: path => (path === "/root/linked" ? "/root" : path),
    projectName: path => (path === "/loose" ? "No project" : "Project"),
    isProjectless: path => path === "/loose",
    refresh: vi.fn(async () => {}),
    flushPersistence: vi.fn(async () => {}),
    upsertBoardDraft: vi.fn(draft => {
      workspace.boardDrafts[draft.id] = { ...draft }
    }),
  })
  const dependencies = {
    vue,
    "@/stores/conversations": {
      allConversations: () => [...owners.values()],
      sessionFor,
      uiFor,
      findConversation: (file, project) =>
        [...owners.values()].find(owner => identities.sameSessionIdentity(owner.sessionFile, owner.cwd, file, project)),
    },
    "@/stores/sessionRunStatus": {
      sessionRunStatus: (file, project) => statuses.get(identities.sessionIdentityKey(file, project)),
      sessionActivitySnapshot: (file, project) => activities.get(identities.sessionIdentityKey(file, project)),
    },
    "@/stores/composerDrafts": {
      composerDraftText: (project, file) => composerDrafts.get(file)?.text ?? "",
      composerDraftFiles: (project, file) => composerDrafts.get(file)?.files ?? [],
    },
    "@/lib/sessionIdentity": identities,
    "@/lib/paths": paths,
    "@/lib/ssh": { isRemoteProject },
    "@/lib/uuid": { createUuid: () => `draft-${++sequence}` },
    "@/lib/kanbanLivePreview": { kanbanLivePreview },
  }
  const code = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function("exports", "require", "module", code)(module.exports, id => dependencies[id], module)
  const scope = effectScope()
  scopes.push(scope)
  const enabled = ref(false)
  const board = scope.run(() => module.exports.useKanbanWorkspace(workspace, () => enabled.value))
  return { board, workspace, owners, sessionFor, uiFor, activities, statuses, composerDrafts, enabled }
}

test("board idle and expanded sidebar reconcile IDs across statuses, previews and archive refresh", async () => {
  const { board, workspace, statuses } = harness()
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/session-visibility.json", import.meta.url), "utf8"))
  const rows = fixture.activeIds.map((id, index) => ({
    id,
    file: `/sessions/${id}.jsonl`,
    cwd: "/root",
    mtimeMs: index,
  }))
  const archived = fixture.archivedIds.map(id => ({ ...rows[0], id, file: `/sessions/${id}.jsonl`, archived: true }))
  const orphan = { ...rows[0], id: fixture.orphanId, file: `/sessions/${fixture.orphanId}.jsonl`, cwd: "/removed" }
  const preview = { ...rows[0], id: fixture.previewId, file: `/sessions/${fixture.previewId}.jsonl` }
  const persisted = [...rows, ...archived, orphan]
  workspace.histories["/root"] = [...rows, ...archived, preview]
  workspace.histories["/removed"] = [orphan]
  statuses.set(identities.sessionIdentityKey(`/sessions/${fixture.completedId}.jsonl`, "/root"), "completed")
  statuses.set(identities.sessionIdentityKey(`/sessions/${fixture.runningId}.jsonl`, "/root"), "running")
  const visible = () => sidebarSessionRows(workspace.histories["/root"], {}, "", row => row.id)
  const files = values => values.map(row => row.file).sort()
  const idle = () => board.cards.value.filter(card => card.status === "idle")
  expect(visible()).toHaveLength(61) // 60 on disk + one unflushed preview.
  expect(idle()).toHaveLength(59) // 58 idle on disk + preview.
  expect(idle().filter(card => !visible().some(row => row.file === card.file))).toEqual([])
  expect(files(visible().filter(row => !idle().some(card => card.file === row.file)))).toEqual(files(rows.slice(0, 2)))
  expect(files(persisted.filter(row => !row.archived && !visible().some(item => item.file === row.file)))).toEqual([
    orphan.file,
  ])
  expect(files(visible().filter(row => !persisted.some(item => item.file === row.file)))).toEqual([preview.file])
  // Same updated history drives both projections after archive and restore.
  workspace.refresh.mockImplementation(async folder => {
    if (folder === "/root")
      workspace.histories[folder] = workspace.histories[folder].map(row => ({
        ...row,
        archived: row.file === rows[2].file || row.archived,
      }))
  })
  await board.refresh()
  expect(visible()).toHaveLength(60)
  expect(idle()).toHaveLength(58)
  workspace.histories["/root"].find(row => row.file === rows[2].file).archived = false
  expect(visible()).toHaveLength(61)
  expect(idle()).toHaveLength(59)
})

test("the ordinary layout is the default and switching layouts survives a reload", () => {
  const storage = new Map()
  vi.stubGlobal("localStorage", { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) })
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => {
    const first = useWorkspaceLayout()
    expect(first.workspaceLayout.value).toBe("chat")
    first.workspaceLayout.value = "board"
    expect(useWorkspaceLayout().workspaceLayout.value).toBe("board")
    first.workspaceLayout.value = "chat"
    expect(useWorkspaceLayout().workspaceLayout.value).toBe("chat")
  })
})

test("entering the board loads every project folder and the no-project history without creating runtimes", async () => {
  const { board, workspace, sessionFor, enabled } = harness()
  expect(workspace.refresh).not.toHaveBeenCalled()
  enabled.value = true
  await nextTick()
  expect(workspace.refresh.mock.calls.map(([path]) => path)).toEqual(["/root", "/root/linked", "/loose"])
  expect(board.selectedProject.value).toBe("")
  expect(sessionFor).not.toHaveBeenCalled()
})

test("completed draft indexes absent from complete local history do not create phantom idle cards", async () => {
  const { board, workspace, statuses, activities } = harness()
  const saved = { file: "/sessions/current.jsonl", cwd: "/root", title: "Current", mtimeMs: 1 }
  workspace.histories["/root"] = [saved]
  statuses.set(identities.sessionIdentityKey(saved.file, saved.cwd), "running")
  for (let index = 0; index < 15; index++) {
    const id = `submitted-${index}`
    const project = ["/root", "/root/linked", "/loose"][index % 3]
    const file = `/sessions/missing-${index}.jsonl`
    workspace.boardDrafts[id] = { id, project, sessionFile: file, message: "Submitted", createdAt: 1, updatedAt: 2 }
    // Acknowledged completion projects as idle; persisted indexes are not files.
    activities.set(identities.sessionIdentityKey(file, project), { status: "completed", updatedAt: 2 })
  }
  const original = JSON.stringify(workspace.boardDrafts)
  expect(board.cards.value.map(card => card.file)).toEqual([saved.file])
  await board.refresh()
  expect(board.cards.value.map(card => card.file)).toEqual([saved.file])
  expect(JSON.stringify(workspace.boardDrafts)).toBe(original)
  expect(workspace.upsertBoardDraft).not.toHaveBeenCalled()
  expect(workspace.flushPersistence).not.toHaveBeenCalled()
  // Restoring the file (or selecting the right root) makes its index usable again.
  workspace.histories["/root"].push({ file: "/sessions/missing-0.jsonl", cwd: "/root", mtimeMs: 3 })
  expect(board.cards.value.some(card => card.draftId === "submitted-0")).toBe(true)
})

test.each(["worker", "streaming", "queue", "memory"])("an unflushed submitted draft retains a real %s source", kind => {
  const { board, workspace, sessionFor } = harness()
  const file = "/sessions/unflushed.jsonl"
  workspace.boardDrafts.pending = {
    id: "pending",
    project: "/root",
    sessionFile: file,
    message: "Prompt",
    createdAt: 1,
    updatedAt: 2,
  }
  const owner = sessionFor("pending")
  Object.assign(owner, { cwd: "/root", sessionFile: file })
  if (kind === "worker") owner.started = true
  if (kind === "streaming") owner.isStreaming = true
  if (kind === "queue") owner.promptQueue.push({ text: "Pending" })
  if (kind === "memory") owner.entries.push({ kind: "user", text: "Recoverable prompt" })
  expect(board.cards.value).toEqual([expect.objectContaining({ file, draftId: "pending" })])
})

test.each(["empty", "reused"])("a %s runtime placeholder is insufficient to restore a missing draft", kind => {
  const { board, workspace, sessionFor } = harness()
  workspace.boardDrafts.old = {
    id: "old",
    project: "/root",
    sessionFile: "/sessions/old.jsonl",
    message: "Old",
    createdAt: 1,
    updatedAt: 2,
  }
  Object.assign(sessionFor("old"), {
    cwd: "/root",
    sessionFile: kind === "empty" ? "/sessions/old.jsonl" : "/sessions/new.jsonl",
  })
  expect(board.cards.value).toEqual([])
})

test("absence from a capped remote history does not suppress a saved remote draft", () => {
  const { board, workspace } = harness()
  const project = "ssh://server/project"
  workspace.orderedProjects = () => [project]
  workspace.projectFolders = () => [project]
  workspace.histories[project] = []
  workspace.boardDrafts.remote = {
    id: "remote",
    project,
    sessionFile: "/remote/old.jsonl",
    message: "Remote",
    createdAt: 1,
    updatedAt: 2,
  }
  expect(board.cards.value).toEqual([expect.objectContaining({ draftId: "remote" })])
})

test.each(["/root", "/root/linked", "/loose"])(
  "restored cards in %s wait for archive metadata while unsent todos stay visible",
  async project => {
    const { board, workspace, sessionFor } = harness(false)
    const todo = await board.createDraft({ project: workspace.projectRoot(project), message: "Unsent task" })
    for (const id of ["archived", "saved", "not-yet-on-disk"]) {
      workspace.boardDrafts[id] = {
        id,
        project,
        message: id,
        sessionFile: `/sessions/${id}.jsonl`,
        createdAt: 1,
        updatedAt: 2,
      }
    }
    for (const id of ["archived", "archived-runtime", "live", "not-yet-on-disk"]) {
      Object.assign(sessionFor(id), {
        cwd: project,
        sessionFile: `/sessions/${id}.jsonl`,
        started: true,
        entries: [{ kind: "user", text: id }],
      })
    }
    expect(board.cards.value.map(card => card.draftId)).toEqual([todo.id])

    let finish!: () => void
    workspace.refresh.mockImplementation(async folder => {
      if (folder !== project) {
        workspace.histories[folder] = []
        return
      }
      await new Promise<void>(resolve => {
        finish = resolve
      })
      workspace.histories[folder] = [
        { file: "/sessions/archived.jsonl", cwd: project, archived: true },
        { file: "/sessions/archived-runtime.jsonl", cwd: project, archived: true },
        { file: "/sessions/saved.jsonl", cwd: project, title: "Saved title" },
      ]
    })
    const refresh = board.refresh()
    await nextTick()
    expect(board.loading.value).toBe(true)
    expect(board.cards.value.map(card => card.draftId)).toEqual([todo.id])
    finish()
    await refresh
    expect(board.loading.value).toBe(false)
    expect(
      board.cards.value
        .map(card => card.file)
        .filter(Boolean)
        .sort(),
    ).toEqual(["/sessions/live.jsonl", "/sessions/not-yet-on-disk.jsonl", "/sessions/saved.jsonl"])
    expect(board.cards.value.find(card => card.draftId === "saved")?.title).toBe("Saved title")
    expect(board.cards.value.some(card => card.draftId === todo.id)).toBe(true)

    const secondRefresh = board.refresh()
    expect(board.cards.value).toHaveLength(4)
    finish()
    await secondRefresh
    expect(board.cards.value).toHaveLength(4)
  },
)

test("failed initial history loads hide restored cards until their file is found on retry", async () => {
  const { board, workspace } = harness(false)
  workspace.boardDrafts.restored = {
    id: "restored",
    project: "/root",
    message: "Restored task",
    sessionFile: "/sessions/restored.jsonl",
    createdAt: 1,
    updatedAt: 2,
  }
  workspace.refresh.mockRejectedValue(new Error("history unavailable"))
  await board.refresh()
  expect(board.error.value).toContain("history unavailable")
  expect(board.loading.value).toBe(false)
  expect(board.cards.value).toEqual([])

  workspace.refresh.mockImplementation(async folder => {
    workspace.histories[folder] = []
  })
  await board.refresh()
  expect(board.error.value).toBe("")
  expect(board.cards.value).toEqual([])
  workspace.histories["/root"] = [{ file: "/sessions/restored.jsonl", cwd: "/root", mtimeMs: 1 }]
  expect(board.cards.value).toEqual([expect.objectContaining({ draftId: "restored" })])
})

test("projectless history, drafts and live sessions retain identity while hiding their project label", async () => {
  const { board, workspace, sessionFor } = harness()
  workspace.histories["/loose"] = [{ file: "/saved.jsonl", cwd: "/loose", title: "Saved", mtimeMs: 5 }]
  await board.createDraft({ project: "/loose", message: "Draft" })
  const owner = sessionFor("loose-live")
  Object.assign(owner, { cwd: "/loose", sessionFile: "/live.jsonl", isStreaming: true })
  expect(board.cards.value).toHaveLength(3)
  expect(board.cards.value.every(card => card.project === "/loose" && card.projectless)).toBe(true)
  expect(board.projects.value.some(project => project.value === "/loose")).toBe(true)
})

test("running cards follow live deltas even when history already provides the card and title", () => {
  const { board, workspace, sessionFor } = harness()
  const file = "/sessions/live.jsonl"
  workspace.histories["/root"] = [{ file, cwd: "/root", title: "Stable title", preview: "Original task", mtimeMs: 5 }]
  const owner = sessionFor("worker")
  Object.assign(owner, {
    cwd: "/root",
    sessionFile: file,
    isStreaming: true,
    partialBlocks: [{ type: "text", text: "First progress" }],
  })
  expect(board.cards.value[0]).toMatchObject({
    title: "Stable title",
    activity: { kind: "text", text: "First progress" },
  })
  owner.partialBlocks[0].text = "Latest progress"
  expect(board.cards.value[0].activity).toEqual({ kind: "text", text: "Latest progress" })
  owner.isStreaming = false
  expect(board.cards.value[0]).toMatchObject({ status: "idle", preview: "Original task" })
  expect(board.cards.value[0].activity).toBeUndefined()
})

test("saved cards use the latest prompt while retaining the session title and legacy preview fallback", () => {
  const { board, workspace, sessionFor } = harness()
  workspace.histories["/root"] = [
    {
      file: "/saved.jsonl",
      cwd: "/root",
      title: "Session title",
      preview: "First question",
      lastUserMessage: "Latest question",
      mtimeMs: 5,
    },
    { file: "/legacy.jsonl", cwd: "/root", preview: "Legacy question", mtimeMs: 4 },
  ]
  expect(board.cards.value[0]).toMatchObject({ title: "Session title", preview: "Latest question" })
  expect(board.cards.value[1].preview).toBe("Legacy question")
  expect(sessionFor).not.toHaveBeenCalled()
})

test.each([false, true])("live cards follow the latest submitted prompt with saved history=%s", saved => {
  const { board, workspace, sessionFor } = harness()
  const file = "/sessions/latest.jsonl"
  if (saved)
    workspace.histories["/root"] = [
      { file, cwd: "/root", title: "Session title", preview: "First question", lastUserMessage: "Stale question" },
    ]
  const owner = sessionFor("worker")
  Object.assign(owner, { cwd: "/root", sessionFile: file })
  owner.entries.push(
    { kind: "user", text: "First question", timestamp: 1 },
    { kind: "assistant", blocks: [{ type: "text", text: "First answer" }] },
    { kind: "user", text: "Latest question", timestamp: 2 },
    { kind: "assistant", blocks: [{ type: "text", text: "Latest answer" }] },
  )
  expect(board.cards.value[0]).toMatchObject({
    title: saved ? "Session title" : "First question",
    preview: "Latest question",
  })
  owner.promptQueue.push({ text: "Not sent yet" })
  expect(board.cards.value[0].preview).toBe("Latest question")
  owner.entries.push({ kind: "user", text: "Follow-up question", timestamp: 3 })
  expect(board.cards.value[0].preview).toBe("Follow-up question")
  owner.entries.splice(-1)
  expect(board.cards.value[0].preview).toBe("Latest question")
})

test("running cards reorder when a newer follow-up starts, independently of update time", () => {
  const { board, workspace, sessionFor } = harness()
  workspace.histories["/root"] = [
    { file: "/sessions/one.jsonl", cwd: "/root", mtimeMs: 100 },
    { file: "/sessions/two.jsonl", cwd: "/root", mtimeMs: 200 },
  ]
  const first = sessionFor("first-worker")
  Object.assign(first, { cwd: "/root", sessionFile: "/sessions/one.jsonl", isStreaming: true })
  first.entries.push({ kind: "user", text: "First question", timestamp: 10 })
  const second = sessionFor("second-worker")
  Object.assign(second, { cwd: "/root", sessionFile: "/sessions/two.jsonl", isStreaming: true })
  second.entries.push({ kind: "user", text: "Second question", timestamp: 20 })
  const runningIds = () => groupKanbanCards(board.cards.value).running.map(card => card.file)
  expect(runningIds()).toEqual(["/sessions/two.jsonl", "/sessions/one.jsonl"])

  first.entries.push({ kind: "user", text: "Follow-up question", timestamp: 30 })
  expect(board.cards.value.find(card => card.file === first.sessionFile)?.lastPromptAt).toBe(30)
  expect(runningIds()).toEqual(["/sessions/one.jsonl", "/sessions/two.jsonl"])
})

test("an image-only latest prompt does not fall back to an older question", () => {
  const { board, workspace, sessionFor } = harness()
  workspace.histories["/root"] = [
    { file: "/saved.jsonl", cwd: "/root", preview: "First question", lastUserMessage: "" },
  ]
  expect(board.cards.value[0].preview).toBe("")
  const owner = sessionFor("worker")
  Object.assign(owner, { cwd: "/root", sessionFile: "/saved.jsonl" })
  owner.entries.push({ kind: "user", text: "First question" }, { kind: "user", text: "", images: [{ url: "image" }] })
  expect(board.cards.value[0].preview).toBe("")
})

test("more than twelve independent todos in one project are persisted without starting pi", async () => {
  const { board, workspace, sessionFor } = harness()
  for (let index = 0; index < 20; index++) await board.createDraft({ project: "/root", message: `Task ${index}` })
  expect(board.cards.value).toHaveLength(20)
  expect(board.cards.value.every(card => card.status === "todo")).toBe(true)
  expect(new Set(board.cards.value.map(card => card.draftId)).size).toBe(20)
  expect(workspace.flushPersistence).toHaveBeenCalledTimes(20)
  expect(sessionFor).not.toHaveBeenCalled()
  expect(await board.createDraft({ project: "/missing", message: "Task" })).toBeNull()
  expect(await board.createDraft({ project: "/root", message: "  " })).toBeNull()
})

test.each([true, false])(
  "unselected projects resolve and persist as projectless tasks (directory resolved: %s)",
  async resolved => {
    const { board, workspace, sessionFor } = harness()
    workspace.orderedProjects = () => []
    if (!resolved) workspace.projectless = ""
    const draft = await board.createDraft({ project: "", message: "  Task  " })
    expect(workspace.ensureProjectless).toHaveBeenCalledOnce()
    expect(draft).toMatchObject({ project: "/loose", message: "Task" })
    expect(workspace.boardDrafts[draft.id]).toEqual(draft)
    expect(workspace.flushPersistence).toHaveBeenCalledOnce()
    expect(board.cards.value).toEqual([
      expect.objectContaining({ draftId: draft.id, project: "/loose", projectless: true, status: "todo" }),
    ])
    expect(sessionFor).not.toHaveBeenCalled()
  },
)

test("projectless tasks support attachments and propagate directory resolution failures", async () => {
  const { board, workspace } = harness()
  expect(await board.createDraft({ project: "", message: "  " })).toBeNull()
  expect(workspace.ensureProjectless).not.toHaveBeenCalled()
  workspace.ensureProjectless.mockRejectedValueOnce(new Error("directory unavailable"))
  await expect(board.createDraft({ project: "", message: "Task" })).rejects.toThrow("directory unavailable")
  expect(workspace.upsertBoardDraft).not.toHaveBeenCalled()
  const attachments = [{ filename: "notes.txt", mediaType: "text/plain", url: "data:text/plain;base64,aGVsbG8=" }]
  expect(await board.createDraft({ project: "", message: "", attachments })).toMatchObject({
    project: "/loose",
    message: "",
    attachments,
  })
})

test("opening a todo or reserving a filename does not start it; the first prompt keeps a single card", async () => {
  const { board, workspace, sessionFor, statuses } = harness()
  const draft = await board.createDraft({ project: "/root", message: "First task" })
  const owner = board.draftConversation(draft)
  expect(owner.runtimeId).toBe(draft.id)
  expect(owner.entries).toEqual([])
  owner.sessionFile = "/sessions/one.jsonl"
  await nextTick()
  expect(board.cards.value).toHaveLength(1)
  expect(board.cards.value[0].status).toBe("todo")
  expect(workspace.boardDrafts[draft.id].sessionFile).toBeUndefined()
  owner.entries.push({ kind: "user", text: "First task", timestamp: 10 })
  owner.isStreaming = true
  statuses.set(owner.sessionFile, "running")
  await nextTick()
  expect(board.cards.value).toHaveLength(1)
  expect(board.cards.value[0].status).toBe("running")
  expect(board.cards.value[0].draftId).toBe(draft.id)
  workspace.histories["/root"] = [{ file: owner.sessionFile, cwd: "/root", title: "Generated title", mtimeMs: 10 }]
  expect(board.cards.value).toHaveLength(1)
  expect(board.cards.value[0].title).toBe("Generated title")
  expect(sessionFor).toHaveBeenCalledWith(draft.id)
  workspace.histories["/root"][0].archived = true
  expect(board.cards.value).toEqual([])
})

test("starting a dropped todo changes status before session creation and preserves panel selection", async () => {
  const { board, workspace } = harness()
  const draft = await board.createDraft({ project: "/root", message: "First task" })
  const original = board.cards.value[0]
  board.selection.value = { id: "another-card" }
  let finish!: () => void
  let owner
  const submit = vi.fn(async (_draft, session) => {
    owner = session
    await new Promise<void>(resolve => {
      finish = resolve
    })
  })
  const starting = board.startDraft(original, submit)
  expect(board.cards.value).toEqual([expect.objectContaining({ draftId: draft.id, status: "running" })])
  expect(board.cards.value[0].lastPromptAt).toBeGreaterThan(0)
  expect(owner.sessionFile).toBeNull()
  expect(board.detailsOpen.value).toBe(false)
  expect(board.selection.value.id).toBe("another-card")
  await board.startDraft(original, submit)
  expect(submit).toHaveBeenCalledOnce()

  owner.sessionFile = "/sessions/started.jsonl"
  expect(board.cards.value).toHaveLength(1)
  expect(board.cards.value[0].status).toBe("running")
  owner.entries.push({ kind: "user", text: draft.message })
  owner.isStreaming = true
  await nextTick()
  finish()
  await starting
  expect(workspace.boardDrafts[draft.id].sessionFile).toBe(owner.sessionFile)
  expect(board.cards.value).toEqual([expect.objectContaining({ draftId: draft.id, status: "running" })])
})

test("failed background starts return to todo and can be retried", async () => {
  const { board } = harness()
  await board.createDraft({ project: "/root", message: "Task" })
  const original = board.cards.value[0]
  const failure = board.startDraft(original, async () => {
    throw new Error("startup failed")
  })
  expect(board.cards.value[0].status).toBe("running")
  await expect(failure).rejects.toThrow("startup failed")
  expect(board.cards.value[0].status).toBe("todo")
  const retry = vi.fn(async () => {})
  await board.startDraft(original, retry)
  expect(retry).toHaveBeenCalledOnce()
})

test("another todo can move to running while the first session is still being created", async () => {
  const { board } = harness()
  await board.createDraft({ project: "/root", message: "First" })
  await board.createDraft({ project: "/root", message: "Second" })
  const cards = [...board.cards.value]
  let finish!: () => void
  const waiting = new Promise<void>(resolve => {
    finish = resolve
  })
  const pending = cards.map(card => board.startDraft(card, async () => waiting))
  expect(board.cards.value.map(card => card.status)).toEqual(["running", "running"])
  expect(board.cards.value.every(card => !card.file)).toBe(true)
  expect(board.detailsOpen.value).toBe(false)
  finish()
  await Promise.all(pending)
})

test.each(["idle", "completed"])("%s cards with an unsent composer draft become todo immediately", expectedStatus => {
  const { board, workspace, statuses, composerDrafts } = harness()
  const file = "/sessions/draft.jsonl"
  workspace.histories["/root"] = [{ file, cwd: "/root", title: "Saved task", mtimeMs: 5 }]
  if (expectedStatus === "completed") statuses.set(identities.sessionIdentityKey(file, "/root"), "completed")

  expect(board.cards.value[0].status).toBe(expectedStatus)
  composerDrafts.set(file, { text: "Unsent follow-up", files: [] })
  expect(board.cards.value[0].status).toBe("todo")

  composerDrafts.set(file, { text: "", files: [] })
  expect(board.cards.value[0].status).toBe(expectedStatus)
})

test("an attachment-only composer draft moves an idle card to todo", () => {
  const { board, workspace, composerDrafts } = harness()
  const file = "/sessions/attachment-draft.jsonl"
  workspace.histories["/root"] = [{ file, cwd: "/root", title: "Saved task", mtimeMs: 5 }]
  composerDrafts.set(file, { text: "", files: [{}] })
  expect(board.cards.value[0].status).toBe("todo")
})

test("worktree cards filter by their project but keep their real cwd and waiting takes precedence", () => {
  const { board, workspace, sessionFor, uiFor, activities, statuses } = harness()
  const file = "/sessions/worktree.jsonl"
  workspace.histories["/root/linked"] = [{ file, cwd: "/root/linked", preview: "Question", mtimeMs: 5 }]
  const owner = sessionFor("worker")
  Object.assign(owner, { cwd: "/root/linked", sessionFile: file, isStreaming: true })
  expect(board.cards.value[0]).toMatchObject({ project: "/root", cwd: "/root/linked", status: "running" })
  uiFor("worker").activeDialog = { id: "confirm-1", method: "confirm" }
  expect(board.cards.value[0].status).toBe("waiting")
  uiFor("worker").activeDialog = null
  owner.isStreaming = false
  activities.set(file, { status: "error", updatedAt: 20 })
  statuses.set(file, "error")
  expect(board.cards.value[0]).toMatchObject({ status: "completed", failed: true, updatedAt: 20 })
  statuses.delete(file)
  expect(board.cards.value[0]).toMatchObject({ status: "idle", failed: true })
})

test("remote history uses its source folder URI for identity, ownership, activity and navigation", () => {
  const { board, workspace, sessionFor, activities, statuses } = harness()
  const project = "ssh://dev@example.com:2222/home/dev/project"
  const file = "/home/dev/.pi/sessions/saved.jsonl"
  workspace.orderedProjects = () => [project]
  workspace.projectFolders = () => [project]
  workspace.histories[project] = [{ file, cwd: "/home/dev/project", title: "Remote", mtimeMs: 5 }]
  const owner = sessionFor("remote-worker")
  Object.assign(owner, { cwd: project, sessionFile: file })
  const identity = identities.sessionIdentityKey(file, project)
  statuses.set(identity, "running")
  activities.set(identity, { status: "running", updatedAt: 20 })
  expect(board.cards.value).toHaveLength(1)
  expect(board.cards.value[0]).toMatchObject({
    id: identity,
    file,
    cwd: project,
    project,
    runtimeId: owner.runtimeId,
    status: "running",
    updatedAt: 20,
    lastPromptAt: 20,
  })
  expect(board.cards.value[0].id).not.toBe(file)
})

test("a delayed first prompt created in the ordinary layout appears as a todo without sending it", () => {
  const { board, sessionFor } = harness()
  const owner = sessionFor("delayed-first-prompt")
  Object.assign(owner, { cwd: "/root", sessionFile: "/sessions/delayed.jsonl" })
  owner.promptQueue.push({ text: "Delayed task", sendAt: Date.now() + 60000 })
  expect(board.cards.value).toHaveLength(1)
  expect(board.cards.value[0]).toMatchObject({ status: "todo", title: "Delayed task", runtimeId: owner.runtimeId })
  expect(owner.entries).toEqual([])
})

test("saved history keeps an unsent delayed first prompt in todo", () => {
  const { board, workspace, sessionFor } = harness()
  const file = "/sessions/delayed.jsonl"
  workspace.histories["/root"] = [{ file, cwd: "/root", title: "Delayed", mtimeMs: 5 }]
  const owner = sessionFor("delayed-worker")
  Object.assign(owner, { cwd: "/root", sessionFile: file })
  owner.promptQueue.push({ text: "Not yet", sendAt: Date.now() + 60000 })
  expect(board.cards.value[0]).toMatchObject({ status: "todo", runtimeId: owner.runtimeId })
  owner.entries.push({ kind: "user", text: "Not yet", timestamp: 1 })
  expect(board.cards.value[0].status).toBe("running")
})

test("attachment-only todos persist model choices without starting pi and restore them on opening", async () => {
  const { board, workspace, sessionFor } = harness()
  const attachments = [{ filename: "photo.png", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8=" }]
  const draft = await board.createDraft({
    project: "/root",
    message: "  ",
    modelKey: "test/reasoner",
    thinkingLevel: "high",
    selection: { project: "/root", worktree: true, branch: "main" },
    attachments,
  })
  expect(sessionFor).not.toHaveBeenCalled()
  expect(workspace.boardDrafts[draft.id]).toMatchObject({
    message: "",
    modelKey: "test/reasoner",
    thinkingLevel: "high",
    selection: { project: "/root", worktree: true, branch: "main" },
    attachments,
  })
  expect(board.cards.value[0].status).toBe("todo")
  const owner = board.draftConversation(draft)
  expect(owner.setDesiredModel).toHaveBeenCalledWith("test/reasoner")
  expect(owner.setDesiredThinkingLevel).toHaveBeenCalledWith("high")
  expect(owner.loadOfflineModels).toHaveBeenCalledOnce()
  expect(owner.entries).toEqual([])
  expect(await board.createDraft({ project: "/missing", message: "", attachments })).toBeNull()
})
