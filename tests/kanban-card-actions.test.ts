import { readFileSync } from "node:fs"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import ts from "typescript"
import { isRemoteProject } from "@/lib/ssh"
import { normalizeProjectPath, samePath } from "@/lib/paths"
import { dataUrlToImage } from "@/lib/attachments"
import { modelKey } from "@/lib/modelKey"
import { notifySessionArchived } from "@/lib/sessionArchiveToast"
import type { KanbanCard, KanbanCreatePayload, KanbanDraftEditor } from "@/lib/kanban"

const workspace = vue.reactive({
  boardDrafts: {} as Record<string, any>,
  histories: {} as Record<string, any[]>,
  isProjectless: (project: string) => project === "/loose",
  ensureProjectless: vi.fn(async () => "/loose"),
  upsertBoardDraft: vi.fn((draft: any) => {
    workspace.boardDrafts[draft.id] = draft
  }),
  removeBoardDraft: vi.fn((id: string) => {
    delete workspace.boardDrafts[id]
  }),
  flushPersistence: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
})
const owners = vue.reactive(new Map<string, any>())
const peekConversation = vi.fn((id: string) => owners.get(id))
const pushToast = vi.fn()
const button = {
  setup:
    (_, { slots, attrs }) =>
    () =>
      vue.h("button", attrs, slots.default?.()),
}
const { descriptor } = parse(readFileSync("src/components/kanban/KanbanCardActions.vue", "utf8"))
const compiled = compileScript(descriptor, { id: "kanban-card-actions-test", inlineTemplate: true })
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const imports = {
  vue,
  "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
  "@lucide/vue": new Proxy({}, { get: () => () => vue.h("svg") }),
  "@/components/ui/button": { Button: button },
  "@/stores/workspace": { useWorkspaceStore: () => workspace },
  "@/stores/conversations": { peekConversation, useUiStore: () => ({ pushToast }) },
  "@/lib/ssh": { isRemoteProject },
  "@/lib/paths": { normalizeProjectPath, samePath },
  "@/lib/attachments": { dataUrlToImage },
  "@/lib/modelKey": { modelKey },
  "@/lib/sessionArchiveToast": { notifySessionArchived },
}
const module = { exports: {} as any }
new Function("exports", "require", code)(module.exports, id => {
  if (!(id in imports)) throw new Error(`Unexpected import: ${id}`)
  return imports[id]
})

interface HostNode {
  tag: string
  text: string
  props: Record<string, any>
  children: HostNode[]
  parent: HostNode | null
}
const node = (tag = "root", text = ""): HostNode => ({ tag, text, props: {}, children: [], parent: null })
const renderer = vue.createRenderer<HostNode, HostNode>({
  createElement: tag => node(tag),
  createText: text => node("text", text),
  createComment: () => node("comment"),
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
    child.parent = parent
  },
  remove(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
  },
  parentNode: child => child.parent,
  nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
  setText: (child, text) => {
    child.text = text
  },
  setElementText: (child, text) => {
    child.text = text
    child.children = []
  },
  patchProp: (child, key, _old, value) => {
    child.props[key] = value
  },
})
const apps: vue.App[] = []
beforeEach(() => {
  vi.clearAllMocks()
  workspace.boardDrafts = {}
  workspace.histories = {}
  owners.clear()
})
afterEach(() => apps.splice(0).forEach(app => app.unmount()))

async function harness(overrides: Partial<KanbanCard> = {}) {
  const card = vue.reactive<KanbanCard>({
    id: "draft:task",
    draftId: "task",
    project: "/project",
    projectName: "Project",
    title: "Task",
    preview: "Task",
    status: "todo",
    updatedAt: 1,
    ...overrides,
  })
  const disabled = vue.ref(false)
  const startDraft = vi.fn()
  const editDraft = vi.fn<(editor: KanbanDraftEditor) => void>()
  const cardDeleted = vi.fn()
  let actions: { edit(): void; remove(): Promise<void> }
  const app = renderer.createApp({
    render: () =>
      vue.h(
        module.exports.default,
        {
          card,
          disabled: disabled.value,
          projects: [
            { value: "/project", label: "Project" },
            { value: "/other", label: "Other" },
          ],
          onStartDraft: startDraft,
          onEditDraft: editDraft,
          onCardDeleted: cardDeleted,
        },
        {
          default: value => {
            actions = value
            return vue.h("button", { "data-card": true })
          },
        },
      ),
  })
  apps.push(app)
  const root = node()
  app.mount(root)
  await vue.nextTick()
  const descendants = (target: HostNode): HostNode[] => target.children.flatMap(child => [child, ...descendants(child)])
  const all = () => descendants(root)
  const textOf = (target: HostNode): string => target.text + target.children.map(textOf).join("")
  const action = (label: string) => all().find(n => n.props["aria-label"] === label)
  async function click(label: string) {
    await action(label)!.props.onClick({ stopPropagation() {} })
    await vue.nextTick()
  }
  const editor = () => editDraft.mock.lastCall![0]
  const save = (payload: Partial<KanbanCreatePayload> = {}) => editor().save({ ...editor().initial, ...payload })
  const editFromMenu = async () => {
    actions.edit()
    await vue.nextTick()
  }
  const removeFromMenu = () => actions.remove()
  return {
    card,
    disabled,
    all,
    action,
    click,
    save,
    editor,
    editDraft,
    startDraft,
    textOf,
    cardDeleted,
    editFromMenu,
    removeFromMenu,
  }
}

test("todo menu editing reuses the existing editor and deletion removes only the chosen persisted draft", async () => {
  workspace.boardDrafts.task = { id: "task", project: "/project", message: "Original" }
  workspace.boardDrafts.other = { id: "other", project: "/project", message: "Keep" }
  const h = await harness()
  await h.editFromMenu()
  expect(h.editDraft).toHaveBeenCalledOnce()
  await h.save({ message: "Updated" })
  await h.removeFromMenu()
  expect(workspace.removeBoardDraft).toHaveBeenCalledExactlyOnceWith("task")
  expect(workspace.boardDrafts.task).toBeUndefined()
  expect(workspace.boardDrafts.other.message).toBe("Keep")
  expect(workspace.flushPersistence).toHaveBeenCalledTimes(2)
  expect(h.cardDeleted).toHaveBeenCalledExactlyOnceWith(h.card)
  expect(workspace.update).not.toHaveBeenCalled()
})

test("failed draft deletion does not emit cardDeleted", async () => {
  workspace.boardDrafts.task = { id: "task", project: "/project", message: "Keep" }
  workspace.flushPersistence.mockRejectedValueOnce(new Error("Delete failed"))
  const h = await harness()
  await h.removeFromMenu()
  expect(workspace.removeBoardDraft).toHaveBeenCalledExactlyOnceWith("task")
  expect(workspace.upsertBoardDraft).toHaveBeenCalledWith(expect.objectContaining({ id: "task", message: "Keep" }))
  expect(workspace.boardDrafts.task).toMatchObject({ id: "task", message: "Keep" })
  expect(h.cardDeleted).not.toHaveBeenCalled()
  expect(pushToast).toHaveBeenCalledWith("Error: Delete failed", "error")
})

test("deleting a queued todo cancels the prompt without writing session metadata", async () => {
  const removeQueuedPrompt = vi.fn()
  owners.set("runtime", { entries: [], promptQueue: [{ id: 7, text: "Queued" }], removeQueuedPrompt })
  const h = await harness({ draftId: undefined, runtimeId: "runtime", file: "/reserved.jsonl" })
  await h.removeFromMenu()
  expect(removeQueuedPrompt).toHaveBeenCalledExactlyOnceWith(7)
  expect(workspace.removeBoardDraft).not.toHaveBeenCalled()
  expect(workspace.update).not.toHaveBeenCalled()
})

test("disabled or started tasks cannot be deleted through a stale todo menu", async () => {
  workspace.boardDrafts.task = { id: "task", project: "/project", message: "Keep" }
  const h = await harness()
  h.disabled.value = true
  await vue.nextTick()
  await h.removeFromMenu()
  expect(workspace.removeBoardDraft).not.toHaveBeenCalled()
  h.disabled.value = false
  await vue.nextTick()
  owners.set("task", { isStreaming: true, entries: [], promptQueue: [] })
  await h.removeFromMenu()
  expect(workspace.removeBoardDraft).not.toHaveBeenCalled()
  expect(pushToast).toHaveBeenCalledWith("Error: kanban.draftUnavailable", "error")
})

test("todo editing supplies the shared dialog with every saved option and updates only that draft", async () => {
  const original = {
    id: "task",
    project: "/project",
    message: "Original",
    createdAt: 1,
    updatedAt: 1,
    modelKey: "provider/model",
    thinkingLevel: "high",
    selection: { project: "/project", worktree: true, branch: "main" },
    attachments: [{ mediaType: "image/png", url: "data:image/png;base64,eA==" }],
  }
  workspace.boardDrafts.task = original
  workspace.boardDrafts.other = { id: "other", project: "/project", message: "Keep" }
  const h = await harness()
  await h.click("kanban.editDraft")
  expect(h.editor().initial).toEqual({
    project: original.project,
    message: original.message,
    attachments: original.attachments,
    modelKey: original.modelKey,
    thinkingLevel: original.thinkingLevel,
    selection: original.selection,
  })
  expect(h.editor().initial.selection).not.toBe(workspace.boardDrafts.task.selection)
  expect(h.editor().environmentLocked).toBe(false)
  expect(h.all().some(n => n.tag === "dialog")).toBe(false)
  await h.save({
    project: "/other",
    message: "  Updated task  ",
    attachments: [],
    modelKey: "provider/other",
    thinkingLevel: "low",
  })
  expect(workspace.boardDrafts.task).toMatchObject({
    id: "task",
    project: "/other",
    message: "Updated task",
    createdAt: 1,
    updatedAt: expect.any(Number),
    attachments: [],
    modelKey: "provider/other",
    thinkingLevel: "low",
  })
  expect(workspace.boardDrafts.task.selection).toBeUndefined()
  expect(workspace.boardDrafts.other.message).toBe("Keep")
  expect(workspace.flushPersistence).toHaveBeenCalledOnce()
  expect(h.startDraft).not.toHaveBeenCalled()
})

test("disabled edits are rejected and a failed save restores the original draft for retry", async () => {
  const original = { id: "task", project: "/project", message: "Original" }
  workspace.boardDrafts.task = original
  const h = await harness()
  h.disabled.value = true
  await vue.nextTick()
  await h.editFromMenu()
  expect(h.editDraft).not.toHaveBeenCalled()
  h.disabled.value = false
  await vue.nextTick()
  await h.editFromMenu()
  workspace.flushPersistence.mockRejectedValueOnce(new Error("Save failed"))
  await expect(h.save({ message: "Updated", startImmediately: true })).rejects.toThrow("Save failed")
  expect(workspace.boardDrafts.task).toEqual(original)
  expect(h.startDraft).not.toHaveBeenCalled()
  await h.save({ message: "Updated", startImmediately: true })
  expect(workspace.boardDrafts.task.message).toBe("Updated")
  expect(h.startDraft).toHaveBeenCalledExactlyOnceWith(h.card)
})

test("projectless edits can retain no project, change project, and save attachment-only tasks", async () => {
  workspace.boardDrafts.task = { id: "task", project: "/loose", message: "Original" }
  const h = await harness({ project: "/loose", projectless: true })
  await h.editFromMenu()
  expect(h.editor().initial.project).toBe("")
  await expect(h.save({ message: "  ", attachments: [] })).rejects.toThrow()
  const attachments = [{ mediaType: "image/png", url: "data:image/png;base64,eA==" }]
  await h.save({ message: "", attachments })
  expect(workspace.ensureProjectless).toHaveBeenCalledOnce()
  expect(workspace.boardDrafts.task).toMatchObject({ project: "/loose", message: "", attachments })
  await h.save({ project: "/other", message: "Moved" })
  expect(workspace.boardDrafts.task.project).toBe("/other")
  await h.save({ project: "", message: "No project" })
  expect(workspace.boardDrafts.task.project).toBe("/loose")
})

test("a delayed todo edits its original queued prompt and refuses to rewrite a task that started", async () => {
  const owner = vue.reactive({
    started: true,
    isStreaming: false,
    entries: [] as any[],
    promptQueue: [
      {
        id: 7,
        text: "Delayed",
        expandedText: "Old expansion",
        sendAt: 5000,
        images: [{ data: "eA==", mimeType: "image/png" }],
      },
    ],
  })
  owners.set("runtime", owner)
  workspace.boardDrafts.task = {
    id: "task",
    project: "/project",
    message: "Stale draft",
    sessionFile: "/queued.jsonl",
  }
  const h = await harness({ runtimeId: "runtime", file: "/queued.jsonl" })
  await h.click("kanban.editDraft")
  expect(h.editor().environmentLocked).toBe(true)
  expect(h.editor().initial.message).toBe("Delayed")
  expect(h.editor().initial.attachments).toEqual([{ mediaType: "image/png", url: "data:image/png;base64,eA==" }])
  await h.save({ message: "Updated delayed task", attachments: [] })
  expect(owner.promptQueue[0]).toMatchObject({
    id: 7,
    text: "Updated delayed task",
    expandedText: undefined,
    sendAt: 5000,
    images: [],
  })
  await h.click("kanban.editDraft")
  expect(h.editor().initial.message).toBe("Updated delayed task")
  owner.isStreaming = true
  await expect(h.save({ message: "Too late" })).rejects.toThrow("kanban.draftUnavailable")
  expect(owner.promptQueue[0].text).toBe("Updated delayed task")
  expect(workspace.upsertBoardDraft).not.toHaveBeenCalled()
})

test.each(["idle", "completed"] as const)(
  "%s cards archive through the workspace without opening a conversation",
  async status => {
    const h = await harness({ status, draftId: undefined, file: "/session.jsonl", cwd: "/project/worktree" })
    expect(h.action("kanban.editDraft")).toBeUndefined()
    await h.click("workspace.archive")
    expect(workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({ file: "/session.jsonl", cwd: "/project/worktree" }),
      "Task",
      true,
    )
    expect(workspace.refresh).toHaveBeenCalledWith("/project/worktree")
  },
)

test("todo actions replace the card time on hover or focus; idle cards keep their archive action", async () => {
  workspace.boardDrafts.task = { id: "task", project: "/project", message: "Delete me" }
  const todo = await harness()
  expect(todo.action("kanban.startDraft")!.props.class).toContain("kanban-card-action")
  expect(todo.action("kanban.editDraft")!.props.class).toContain("kanban-card-action")
  expect(todo.action("kanban.delete")!.props.class).toContain("kanban-card-delete")
  expect(todo.action("kanban.delete")!.props.class).toContain("bottom-2")
  await todo.click("kanban.startDraft")
  expect(todo.startDraft).toHaveBeenCalledExactlyOnceWith(todo.card)
  expect(todo.editDraft).not.toHaveBeenCalled()

  const idle = await harness({ status: "idle", file: "/session.jsonl" })
  expect(idle.action("workspace.archive")!.props.class).toContain("kanban-archive")
  const styles = descriptor.styles.map(style => style.content).join("\n")
  expect(styles).toContain(
    ".kanban-card-actions:is(:hover, :focus-within) :is(.kanban-card-action, .kanban-card-delete, .kanban-archive)",
  )
  expect(styles).toContain(".has-todo-actions:is(:hover, :focus-within) :deep(.kanban-card-time)")
  await todo.click("kanban.delete")
  expect(workspace.removeBoardDraft).toHaveBeenCalledExactlyOnceWith("task")
  expect(todo.cardDeleted).toHaveBeenCalledExactlyOnceWith(todo.card)
})

test("archive failure restores the card and reports the error", async () => {
  workspace.update.mockRejectedValueOnce(new Error("Archive failed"))
  const h = await harness({ status: "idle", file: "/session.jsonl" })
  await h.click("workspace.archive")
  expect(pushToast).toHaveBeenCalledWith("Error: Archive failed", "error")
  expect(h.all().some(n => n.props["data-card"])).toBe(true)
  expect(workspace.refresh).not.toHaveBeenCalled()
})

test.each([
  { status: "running" },
  { status: "waiting" },
  { status: "todo" },
  { status: "idle", project: "ssh://host/project" },
  { status: "completed", cwd: "ssh://host/project" },
] as const)("archive is absent for unsupported status or remote project: %j", async overrides => {
  const h = await harness({ file: "/session.jsonl", ...overrides })
  expect(h.action("workspace.archive")).toBeUndefined()
})
