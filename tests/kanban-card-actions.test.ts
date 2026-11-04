import { readFileSync } from "node:fs"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import ts from "typescript"
import { isRemoteProject } from "@/lib/ssh"
import { normalizeProjectPath, samePath } from "@/lib/paths"
import type { KanbanCard } from "@/lib/kanban"

const workspace = vue.reactive({
  boardDrafts: {} as Record<string, any>,
  histories: {} as Record<string, any[]>,
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
const passthrough = {
  setup:
    (_, { slots, attrs }) =>
    () =>
      vue.h("div", attrs, slots.default?.()),
}
const button = {
  setup:
    (_, { slots, attrs }) =>
    () =>
      vue.h("button", attrs, slots.default?.()),
}
const textarea = {
  props: ["modelValue"],
  emits: ["update:modelValue"],
  setup:
    (props, { attrs, emit }) =>
    () =>
      vue.h("textarea", {
        ...attrs,
        value: props.modelValue,
        onInput: value => emit("update:modelValue", value),
      }),
}
const dialog = {
  props: ["open"],
  emits: ["update:open"],
  setup:
    (props, { slots, emit }) =>
    () =>
      props.open ? vue.h("dialog", { onDismiss: () => emit("update:open", false) }, slots.default?.()) : null,
}
const { descriptor } = parse(readFileSync("src/components/kanban/KanbanCardActions.vue", "utf8"))
const compiled = compileScript(descriptor, { id: "kanban-card-actions-test", inlineTemplate: true })
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const imports = {
  vue: { ...vue, vModelSelect: {} },
  "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
  "@lucide/vue": new Proxy({}, { get: () => () => vue.h("svg") }),
  "@/components/ui/button": { Button: button },
  "@/components/ui/textarea": { Textarea: textarea },
  "@/components/ui/dialog": {
    Dialog: dialog,
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  },
  "@/stores/workspace": { useWorkspaceStore: () => workspace },
  "@/stores/conversations": { peekConversation, useUiStore: () => ({ pushToast }) },
  "@/lib/ssh": { isRemoteProject },
  "@/lib/paths": { normalizeProjectPath, samePath },
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
  const open = vi.fn()
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
          onOpen: open,
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
  const action = (label: string) => all().find(n => n.props["aria-label"] === label)
  async function click(label: string) {
    await action(label)!.props.onClick({ stopPropagation() {} })
    await vue.nextTick()
  }
  const save = () =>
    all()
      .find(n => n.tag === "form")!
      .props.onSubmit({ preventDefault() {} })
  const edit = async (text: string) => {
    all()
      .find(n => n.tag === "textarea")!
      .props.onInput(text)
    await vue.nextTick()
  }
  const isEditing = () => all().some(n => n.tag === "dialog")
  const editFromMenu = async () => {
    actions.edit()
    await vue.nextTick()
  }
  const removeFromMenu = () => actions.remove()
  return { card, disabled, all, action, click, save, edit, isEditing, open, editFromMenu, removeFromMenu }
}

test("todo menu editing reuses the existing editor and deletion removes only the chosen persisted draft", async () => {
  workspace.boardDrafts.task = { id: "task", project: "/project", message: "Original" }
  workspace.boardDrafts.other = { id: "other", project: "/project", message: "Keep" }
  const h = await harness()
  await h.editFromMenu()
  expect(h.isEditing()).toBe(true)
  await h.edit("Updated")
  await h.save()
  await h.removeFromMenu()
  expect(workspace.removeBoardDraft).toHaveBeenCalledExactlyOnceWith("task")
  expect(workspace.boardDrafts.task).toBeUndefined()
  expect(workspace.boardDrafts.other.message).toBe("Keep")
  expect(workspace.flushPersistence).toHaveBeenCalledTimes(2)
  expect(h.open).not.toHaveBeenCalled()
  expect(workspace.update).not.toHaveBeenCalled()
})

test("deleting a queued todo cancels the prompt without writing session metadata", async () => {
  const removeQueuedPrompt = vi.fn()
  owners.set("runtime", { entries: [], promptQueue: [{ id: 7, text: "Queued" }], removeQueuedPrompt })
  const h = await harness({ draftId: undefined, runtimeId: "runtime", file: "/reserved.jsonl" })
  await h.removeFromMenu()
  expect(removeQueuedPrompt).toHaveBeenCalledExactlyOnceWith(7)
  expect(workspace.removeBoardDraft).not.toHaveBeenCalled()
  expect(workspace.update).not.toHaveBeenCalled()
  expect(h.open).not.toHaveBeenCalled()
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

test("todo editing opens a dialog and saves only the chosen draft without opening or creating a conversation", async () => {
  const original = {
    id: "task",
    project: "/project",
    message: "Original",
    createdAt: 1,
    updatedAt: 1,
    modelKey: "provider/model",
    thinkingLevel: "high",
    attachments: [{ url: "data:image/png;base64,eA==" }],
  }
  workspace.boardDrafts.task = original
  const h = await harness()
  await h.click("kanban.editDraft")
  expect(h.isEditing()).toBe(true)
  expect(h.all().find(n => n.tag === "textarea")!.props.value).toBe("Original")
  await h.edit("  Updated task  ")
  h.all()
    .find(n => n.tag === "select")!
    .props["onUpdate:modelValue"]("/other")
  await vue.nextTick()
  await h.save()
  await vue.nextTick()
  expect(workspace.boardDrafts.task).toMatchObject({
    ...original,
    project: "/other",
    message: "Updated task",
    updatedAt: expect.any(Number),
  })
  expect(workspace.flushPersistence).toHaveBeenCalledOnce()
  expect(h.open).not.toHaveBeenCalled()
  expect(h.isEditing()).toBe(false)
})

test("cancel discards changes; a failed save stays open and supports retry", async () => {
  workspace.boardDrafts.task = { id: "task", project: "/project", message: "Original" }
  const h = await harness()
  await h.click("kanban.editDraft")
  await h.edit("Unsaved")
  h.all()
    .find(n => n.tag === "dialog")!
    .props.onDismiss()
  await vue.nextTick()
  expect(workspace.upsertBoardDraft).not.toHaveBeenCalled()
  await h.click("kanban.editDraft")
  expect(h.all().find(n => n.tag === "textarea")!.props.value).toBe("Original")
  await h.edit("Updated")
  workspace.flushPersistence.mockRejectedValueOnce(new Error("Save failed"))
  await h.save()
  await vue.nextTick()
  expect(h.isEditing()).toBe(true)
  expect(h.all().find(n => n.props.role === "alert")!.text).toContain("Save failed")
  await h.save()
  await vue.nextTick()
  expect(h.isEditing()).toBe(false)
})

test("a delayed todo edits its original queued prompt and never rewrites it once execution starts", async () => {
  const owner = vue.reactive({
    started: true,
    isStreaming: false,
    entries: [],
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
  const h = await harness({ draftId: undefined, runtimeId: "runtime", file: "/queued.jsonl" })
  await h.click("kanban.editDraft")
  expect(h.all().find(n => n.tag === "select")!.props.disabled).toBe(true)
  await h.edit("Updated delayed task")
  await h.save()
  expect(owner.promptQueue[0]).toMatchObject({
    id: 7,
    text: "Updated delayed task",
    expandedText: undefined,
    sendAt: 5000,
  })
  expect(owner.promptQueue[0].images).toHaveLength(1)
  await h.click("kanban.editDraft")
  await h.edit("Too late")
  owner.isStreaming = true
  await h.save()
  await vue.nextTick()
  expect(owner.promptQueue[0].text).toBe("Updated delayed task")
  expect(h.isEditing()).toBe(true)
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
    expect(h.open).not.toHaveBeenCalled()
  },
)

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
