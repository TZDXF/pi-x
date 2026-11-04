import { readFileSync } from "node:fs"
import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, reactive, ref } from "vue"
import * as vue from "vue"
import { transpileModule, ModuleKind, ScriptTarget } from "typescript"
import * as paths from "@/lib/paths"
import * as identities from "@/lib/sessionIdentity"
import { useWorkspaceLayout } from "@/composables/useWorkspaceLayout"
import { kanbanLivePreview } from "@/lib/kanbanLivePreview"

const source = readFileSync(new URL("../src/composables/useKanbanWorkspace.ts", import.meta.url), "utf8")
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.unstubAllGlobals()
})

function harness() {
  const owners = reactive(new Map())
  const interfaces = reactive(new Map())
  const activities = reactive(new Map())
  const statuses = reactive(new Map())
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
    histories: {},
    projectless: "/loose",
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
    "@/lib/sessionIdentity": identities,
    "@/lib/paths": paths,
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
  return { board, workspace, owners, sessionFor, uiFor, activities, statuses, enabled }
}

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

test("a delayed first prompt created in the ordinary layout appears as a todo without sending it", () => {
  const { board, sessionFor } = harness()
  const owner = sessionFor("delayed-first-prompt")
  Object.assign(owner, { cwd: "/root", sessionFile: "/sessions/delayed.jsonl" })
  owner.promptQueue.push({ text: "Delayed task", sendAt: Date.now() + 60000 })
  expect(board.cards.value).toHaveLength(1)
  expect(board.cards.value[0]).toMatchObject({ status: "todo", title: "Delayed task", runtimeId: owner.runtimeId })
  expect(owner.entries).toEqual([])
})

test("attachment-only todos persist model choices without starting pi and restore them on opening", async () => {
  const { board, workspace, sessionFor } = harness()
  const attachments = [{ filename: "photo.png", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8=" }]
  const draft = await board.createDraft({
    project: "/root",
    message: "  ",
    modelKey: "test/reasoner",
    thinkingLevel: "high",
    attachments,
  })
  expect(sessionFor).not.toHaveBeenCalled()
  expect(workspace.boardDrafts[draft.id]).toMatchObject({
    message: "",
    modelKey: "test/reasoner",
    thinkingLevel: "high",
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
