import { readFileSync } from "node:fs"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import { createI18n } from "vue-i18n"
import ts from "typescript"
import * as kanban from "@/lib/kanban"
import { useKanbanCardSorting } from "@/composables/useKanbanCardSorting"
import { useKanbanColumnSorting } from "@/composables/useKanbanColumnSorting"
import { boardDraftFiles, serializeBoardAttachments } from "@/lib/boardDraftAttachments"
import { formatKanbanDuration, formatKanbanTime } from "@/lib/kanbanTime"
import type { KanbanCard, KanbanCardSource } from "@/lib/kanban"
import zhCN from "@/i18n/locales/zh-CN"
import en from "@/i18n/locales/en"

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "task",
    project: "root",
    projectName: "Project",
    title: "Task title",
    preview: "Task message",
    updatedAt: 1000,
    status: "todo",
    ...overrides,
  }
}

describe("kanban projection", () => {
  test("column order is fixed and empty columns are retained", () => {
    expect(kanban.KANBAN_COLUMNS.map(column => column.id)).toEqual(["todo", "running", "waiting", "completed", "idle"])
    expect(kanban.groupKanbanCards([])).toEqual({ todo: [], running: [], waiting: [], completed: [], idle: [] })
  })

  test("projection excludes archived sources and includes sessions without a project by default", () => {
    const sources: KanbanCardSource[] = [
      card({ id: "grouped", cwd: "root/worktree", file: "session.jsonl", runtimeId: "runtime", status: "running" }),
      card({ id: "ungrouped", project: "", projectName: "", updatedAt: 2000 }),
      { ...card({ id: "archived", status: "running", updatedAt: 3000 }), archived: true },
    ]
    const before = structuredClone(sources)
    expect(kanban.projectKanbanCards(sources).map(item => item.id)).toEqual(["ungrouped", "grouped"])
    const projected = kanban.projectKanbanCards(sources, "root")
    expect(projected).toEqual([sources[0]])
    expect(projected[0]).not.toBe(sources[0])
    expect(sources).toEqual(before)
    expect(kanban.projectKanbanCards(sources, "root/worktree")).toEqual([])
  })

  test("titles prefer explicit titles, otherwise use a whitespace-normalized summary without data truncation", () => {
    expect(kanban.kanbanCardTitle("  Session title  ", "message")).toBe("Session title")
    expect(kanban.kanbanCardTitle(" \n ", "  First line\n\tsecond line  ")).toBe("First line second line")
    const longMessage = "完整消息🙂".repeat(1000)
    expect(kanban.kanbanCardTitle(null, longMessage)).toBe(longMessage)
    expect(kanban.kanbanCardTitle(null, " \n\t")).toBe("")
  })

  test("null previews fall back to messages; saved empty drafts remain empty and retain identity", () => {
    const sources: KanbanCardSource[] = [
      { ...card({ id: "fallback" }), title: null, preview: null, message: "  Line one\nLine two  " },
      { ...card({ id: "empty", draftId: "draft", cwd: "root/actual" }), title: "", preview: "", message: "" },
    ]
    const result = kanban.projectKanbanCards(sources)
    expect(result[0]).toMatchObject({ title: "Line one Line two", preview: "Line one\nLine two" })
    expect(result[1]).toMatchObject({ title: "", preview: "", draftId: "draft", cwd: "root/actual" })
    expect(result[0]).not.toHaveProperty("message")
    expect(result[0]).not.toHaveProperty("archived")
  })

  test("filtering compares only grouping projects, never names, prefixes, or actual cwd", () => {
    const cards = [
      card({ id: "one", cwd: "root/worktree" }),
      card({ id: "two", project: "root/two" }),
      card({ id: "three", project: "", cwd: "root" }),
    ]
    expect(kanban.filterKanbanCards(cards).map(item => item.id)).toEqual(["one", "two", "three"])
    expect(kanban.filterKanbanCards(cards, "root").map(item => item.id)).toEqual(["one"])
    expect(kanban.filterKanbanCards(cards, "missing")).toEqual([])
  })

  test("sorting is stable, newest first, does not mutate input, and puts invalid dates last", () => {
    const cards = Object.freeze([
      Object.freeze(card({ id: "old", updatedAt: 1 })),
      Object.freeze(card({ id: "equal-first", updatedAt: 2 })),
      Object.freeze(card({ id: "invalid", updatedAt: NaN })),
      Object.freeze(card({ id: "equal-second", updatedAt: 2 })),
      Object.freeze(card({ id: "infinite", updatedAt: Infinity })),
    ])
    expect(kanban.sortKanbanCards(cards).map(item => item.id)).toEqual([
      "equal-first",
      "equal-second",
      "old",
      "invalid",
      "infinite",
    ])
    expect(cards[0].id).toBe("old")
  })

  test("grouping sorts each column while keeping failed cards in their supplied status", () => {
    const cards = [
      card({ id: "older", status: "waiting", updatedAt: 1 }),
      card({ id: "failed", status: "waiting", failed: true, updatedAt: 3 }),
      card({ id: "done", status: "completed", updatedAt: 2 }),
    ]
    const groups = kanban.groupKanbanCards(cards)
    expect(groups.waiting.map(item => item.id)).toEqual(["failed", "older"])
    expect(groups.completed).toEqual([cards[2]])
    expect(groups.idle).toEqual([])
    expect(Object.values(groups).flat()).toHaveLength(cards.length)
  })
})

// Compile the real board into the same minimal Vue host used by sidebar tests.
// Dialog/textarea widgets and the native select DOM directive are substituted; board state/events are real.
interface HostNode {
  tag: string
  text: string
  props: Record<string, any>
  children: HostNode[]
  parent: HostNode | null
}
function node(tag = "root", text = ""): HostNode {
  return { tag, text, props: {}, children: [], parent: null }
}
const renderer = vue.createRenderer<HostNode, HostNode>({
  createElement: tag => node(tag),
  createText: text => node("text", text),
  createComment: text => node("comment", text),
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
    child.parent = parent
  },
  remove(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = null
  },
  setText: (target, text) => {
    target.text = text
  },
  setElementText: (target, text) => {
    target.text = text
    target.children = []
  },
  parentNode: target => target.parent,
  nextSibling: target => {
    const siblings = target.parent?.children ?? []
    return siblings[siblings.indexOf(target) + 1] ?? null
  },
  patchProp: (target, key, _previous, value) => {
    target.props[key] = value
  },
})
const passthrough = vue.defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      vue.h("div", slots.default?.()),
})
const dialogContent = vue.defineComponent({
  props: { disableOutsidePointerEvents: { type: Boolean, default: true } },
  setup:
    (props, { slots }) =>
    () =>
      vue.h(
        "div",
        { "data-dialog-content": true, "data-disable-outside-pointer-events": props.disableOutsidePointerEvents },
        slots.default?.(),
      ),
})
const button = vue.defineComponent({
  setup:
    (_, { slots, attrs }) =>
    () =>
      vue.h("button", attrs, slots.default?.()),
})
const input = vue.defineComponent({
  props: ["modelValue"],
  emits: ["update:modelValue"],
  setup:
    (props, { emit }) =>
    () =>
      vue.h("input", {
        value: props.modelValue,
        onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
      }),
})
const dialog = vue.defineComponent({
  props: ["open"],
  emits: ["update:open"],
  setup:
    (props, { slots, emit }) =>
    () =>
      props.open
        ? vue.h("div", { "data-dialog": true, onDismiss: () => emit("update:open", false) }, slots.default?.())
        : null,
})
const promptInput = vue.defineComponent({
  props: ["bridge", "submit", "disabled", "initialDraft"],
  emits: ["update:bridge"],
  setup(props, { emit, slots }) {
    const bridge = vue.reactive({
      textInput: props.initialDraft ?? "",
      files: [] as any[],
      isLoading: false,
      addFiles(files: File[]) {
        this.files.push(...files.map(file => ({ file, filename: file.name, mediaType: file.type })))
      },
    })
    emit("update:bridge", bridge)
    return () =>
      vue.h(
        "form",
        {
          "data-files": bridge.files,
          onRemoveFiles: () => {
            bridge.files = []
          },
          onSubmit: async event => {
            event.preventDefault()
            if (props.disabled || (!bridge.textInput.trim() && !bridge.files.length)) return
            try {
              await props.submit({
                text: bridge.textInput,
                files: bridge.files.length ? await serializeBoardAttachments(bridge.files) : [],
              })
            } catch {
              /* Editor retains failed drafts. */
            }
          },
        },
        [
          vue.h("textarea", {
            value: bridge.textInput,
            onInput: event => {
              bridge.textInput = event.target.value
            },
          }),
          slots.model?.(),
          slots.actions?.(),
        ],
      )
  },
})
const source = readFileSync(new URL("../src/components/kanban/KanbanBoard.vue", import.meta.url), "utf8")
const appSource = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: "kanban-board-test", inlineTemplate: true })
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const imports = {
  vue: { ...vue, vModelSelect: {} },
  "vue-i18n": { useI18n: () => ({ t: (key: string) => key, locale: vue.ref("en") }) },
  "@lucide/vue": new Proxy({}, { get: () => () => vue.h("svg") }),
  "@/lib/kanban": kanban,
  "@/lib/boardDraftAttachments": { boardDraftFiles },
  "@/lib/kanbanTime": { formatKanbanDuration, formatKanbanTime },
  "@/composables/useKanbanCardSorting": { useKanbanCardSorting },
  "@/composables/useKanbanColumnSorting": { useKanbanColumnSorting },
  "@/composables/useKanbanSelectionScroll": { useKanbanSelectionScroll: () => {} },
  "@/components/ui/button": { Button: button },
  "@/components/ui/input": { Input: input },
  "@/components/ui/popover": { Popover: passthrough, PopoverContent: passthrough, PopoverTrigger: passthrough },
  "@/components/ui/scroll-area": { ScrollArea: passthrough },
  "@/components/ui/checkbox": {
    Checkbox: vue.defineComponent({
      props: ["modelValue", "disabled"],
      emits: ["update:modelValue"],
      setup:
        (props, { emit }) =>
        () =>
          vue.h("button", {
            type: "button",
            role: "checkbox",
            "aria-checked": String(!!props.modelValue),
            disabled: props.disabled,
            onClick: () => emit("update:modelValue", !props.modelValue),
          }),
    }),
  },
  "@/components/chat/ChatPromptInput.vue": { __esModule: true, default: promptInput },
  "@/components/WorkspaceContext.vue": {
    __esModule: true,
    default: vue.defineComponent({
      props: ["project", "modelValue", "projectPicker", "projectPlaceholder", "disabled"],
      emits: ["update:modelValue", "selectProject", "openProject"],
      setup:
        (props, { emit }) =>
        () =>
          vue.h("div", [
            vue.h("select", {
              required: true,
              disabled: props.disabled,
              "data-workspace-project": true,
              "data-project": props.project,
              "data-selection": props.modelValue,
              "data-project-placeholder": props.projectPlaceholder,
              "onUpdate:modelValue": (project: string) => emit("selectProject", project),
            }),
            vue.h("button", {
              type: "button",
              "data-workspace-selection": true,
              onClick: () => emit("update:modelValue", { project: props.project, worktree: true, branch: "main" }),
            }),
            vue.h("button", {
              type: "button",
              "data-open-project": true,
              onClick: () => emit("openProject"),
            }),
          ]),
    }),
  },
  "@/components/ModelThinkingSelect.vue": {
    __esModule: true,
    default: vue.defineComponent({
      props: ["modelValue", "thinkingLevel", "disabled"],
      emits: ["update:modelValue", "update:thinkingLevel"],
      setup:
        (props, { emit }) =>
        () =>
          vue.h("model-picker", {
            ...props,
            onChoose: value => emit("update:modelValue", value),
            onThinking: value => emit("update:thinkingLevel", value),
          }),
    }),
  },
  "@/components/chat/ImagePreviewContent.vue": { __esModule: true, default: passthrough },
  "@/stores/session/modelSelection": {
    createModelSelection: (_state, models) => {
      const desiredModelKey = vue.ref(null)
      const desiredThinkingLevel = vue.ref(null)
      return {
        desiredModelKey,
        desiredThinkingLevel,
        offlineDefaultModelKey: vue.ref(null),
        availableThinking: vue.ref(["off", "low", "high"]),
        thinkingLevel: vue.computed(() => desiredThinkingLevel.value ?? "off"),
        loadOfflineModels: async () => {
          models.value = [{ provider: "test", id: "model" }]
        },
        setDesiredModel(key) {
          desiredModelKey.value = key
        },
        setDesiredThinkingLevel(level) {
          desiredThinkingLevel.value = level
        },
      }
    },
  },
  "./KanbanSessionMenu.vue": {
    __esModule: true,
    default: vue.defineComponent({
      props: ["card", "disabled"],
      emits: ["open", "export"],
      setup:
        (_, { slots }) =>
        () =>
          slots.default?.(),
    }),
  },
  "./KanbanCardActions.vue": {
    __esModule: true,
    default: vue.defineComponent({
      props: ["card", "editor"],
      emits: ["cardDeleted", "startDraft", "editDraft"],
      setup:
        (props, { slots, emit }) =>
        () =>
          vue.h("div", [
            vue.h("button", { "data-delete-card": true, onClick: () => emit("cardDeleted", props.card) }),
            vue.h("button", { "data-start-card": true, onClick: () => emit("startDraft", props.card) }),
            vue.h("button", { "data-edit-card": true, onClick: editor => emit("editDraft", editor) }),
            slots.default?.({ edit() {}, remove() {}, busy: false }),
          ]),
    }),
  },
  "@/components/ui/dialog": {
    Dialog: dialog,
    DialogContent: dialogContent,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogDescription: passthrough,
  },
}
const componentExports = {} as any
new Function("exports", "require", code)(componentExports, id => {
  if (!(id in imports)) throw new Error(`Unexpected import: ${id}`)
  return imports[id]
})
function descendants(root: HostNode): HostNode[] {
  return root.children.flatMap(child => [child, ...descendants(child)])
}
function textOf(root: HostNode): string {
  return root.text + root.children.map(textOf).join("")
}
const apps: vue.App[] = []
afterEach(() => apps.splice(0).forEach(app => app.unmount()))

async function harness(overrides: Record<string, any> = {}) {
  const state = vue.reactive({
    cards: [] as KanbanCard[],
    projects: [
      { value: "root", label: "Project" },
      { value: "other", label: "Other" },
    ],
    selectedProject: "",
    selectedId: undefined as string | undefined,
    loading: false,
    error: "",
    busy: false,
    navigationBusy: false,
    columnOrder: {} as Record<string, string[]>,
    ...overrides,
  })
  const create = vi.fn(),
    open = vi.fn(),
    openProject = vi.fn(),
    retry = vi.fn(),
    select = vi.fn(),
    cardDeleted = vi.fn(),
    startDraft = vi.fn(),
    dropDraft = vi.fn(),
    reorder = vi.fn((column: kanban.KanbanStatus, ids: string[]) => {
      state.columnOrder = { ...state.columnOrder, [kanban.kanbanColumnOrderKey(state.selectedProject, column)]: ids }
    }),
    reorderColumns = vi.fn((ids: kanban.KanbanStatus[]) => {
      state.columnOrder = { ...state.columnOrder, [kanban.kanbanStatusOrderKey]: ids }
    })
  const board = vue.ref<{ openCreate(project?: string): void }>()
  const app = renderer.createApp({
    setup: () => () =>
      vue.h(
        componentExports.default,
        {
          ...state,
          ref: board,
          onCreate: create,
          onOpen: open,
          onOpenProject: openProject,
          onCardDeleted: cardDeleted,
          onStartDraft: startDraft,
          onDropDraft: dropDraft,
          onRetry: retry,
          onReorder: reorder,
          onReorderColumns: reorderColumns,
          "onUpdate:selectedProject": select,
        },
        { actions: () => vue.h("span", { "data-actions": true }, "Parent actions") },
      ),
  })
  apps.push(app)
  const root = node()
  app.mount(root)
  await vue.nextTick()
  const all = () => descendants(root)
  const byText = (text: string) => all().find(child => child.tag === "button" && textOf(child).includes(text))!
  const columns = () => all().filter(child => child.props["data-kanban-column"])
  const cards = () => all().filter(child => child.props["data-kanban-card"])
  const form = () => all().find(child => child.tag === "form")!
  const isDialogOpen = () => all().some(child => child.props["data-dialog"])
  async function openCreate() {
    byText("kanban.create").props.onClick()
    await vue.nextTick()
  }
  async function fill(project: string, message: string) {
    const projectSelect = all().find(child => child.tag === "select" && child.props.required !== undefined)!
    projectSelect.props["onUpdate:modelValue"](project)
    all()
      .find(child => child.tag === "textarea")!
      .props.onInput({ target: { value: message } })
    await vue.nextTick()
  }
  function submit() {
    return form().props.onSubmit({ preventDefault() {} })
  }
  return {
    state,
    board,
    root,
    all,
    byText,
    columns,
    cards,
    form,
    isDialogOpen,
    openCreate,
    fill,
    submit,
    create,
    open,
    openProject,
    cardDeleted,
    startDraft,
    dropDraft,
    retry,
    reorder,
    reorderColumns,
    select,
  }
}

describe("KanbanBoard", () => {
  test("editing reuses creation controls and saves the original task with restored files and options", async () => {
    const h = await harness({ cards: [card()] })
    const initial = {
      project: "root",
      message: "Original task",
      modelKey: "test/original",
      thinkingLevel: "high",
      selection: { project: "root", worktree: true, branch: "main" },
      attachments: [{ filename: "photo.png", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8=" }],
    }
    const save = vi.fn(async () => {})
    h.all()
      .find(child => child.props["data-edit-card"])!
      .props.onClick({ initial, environmentLocked: false, save })
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(true)
    expect(h.all().some(child => child.text === "kanban.editDraft")).toBe(true)
    expect(h.all().find(child => child.tag === "textarea")!.props.value).toBe("Original task")
    expect(h.all().find(child => child.props["data-workspace-project"])!.props["data-selection"]).toEqual(
      initial.selection,
    )
    expect(await h.form().props["data-files"][0].file.text()).toBe("hello")
    const model = () => h.all().find(child => child.tag === "model-picker")!
    expect(model().props.modelValue).toBe("test/original")
    expect(model().props.thinkingLevel).toBe("high")
    model().props.onChoose("test/updated")
    model().props.onThinking("low")
    await h.fill("other", "  Updated task  ")
    await h.submit()
    expect(save).toHaveBeenCalledExactlyOnceWith({
      project: "other",
      message: "Updated task",
      attachments: initial.attachments,
      modelKey: "test/updated",
      thinkingLevel: "low",
    })
    expect(h.create).not.toHaveBeenCalled()
    expect(h.isDialogOpen()).toBe(false)
    await h.openCreate()
    expect(h.all().find(child => child.tag === "textarea")!.props.value).toBe("")
    expect(h.form().props["data-files"]).toHaveLength(0)
    await h.fill("root", "New task")
    await h.submit()
    expect(h.create).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
  })

  test("failed edits stay open with their content for retry; cancellation does not save", async () => {
    const h = await harness({ cards: [card()] })
    const save = vi.fn(async () => {}).mockRejectedValueOnce(new Error("Save failed"))
    const edit = () =>
      h
        .all()
        .find(child => child.props["data-edit-card"])!
        .props.onClick({
          initial: { project: "root", message: "Original" },
          environmentLocked: false,
          save,
        })
    edit()
    await vue.nextTick()
    await h.fill("root", "Updated")
    await h.submit()
    expect(h.isDialogOpen()).toBe(true)
    expect(h.all().find(child => child.props.role === "alert")!.text).toContain("Save failed")
    expect(h.all().find(child => child.tag === "textarea")!.props.value).toBe("Updated")
    await h.submit()
    expect(h.isDialogOpen()).toBe(false)
    edit()
    await vue.nextTick()
    await h.fill("root", "Unsaved")
    h.byText("kanban.cancel").props.onClick()
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(false)
    expect(save).toHaveBeenCalledTimes(2)
  })

  test("queued todo edits lock their environment while allowing attachment-only updates", async () => {
    const h = await harness({ cards: [card()] })
    const save = vi.fn(async () => {})
    const attachments = [{ filename: "photo.png", mediaType: "image/png", url: "data:image/png;base64,eA==" }]
    h.all()
      .find(child => child.props["data-edit-card"])!
      .props.onClick({
        initial: { project: "root/worktree", message: "", attachments },
        environmentLocked: true,
        save,
      })
    await vue.nextTick()
    expect(h.all().find(child => child.props["data-workspace-project"])!.props.disabled).toBe(true)
    expect(h.all().find(child => child.tag === "model-picker")!.props.disabled).toBe(true)
    expect(h.all().some(child => child.props.role === "checkbox")).toBe(false)
    expect(h.byText("kanban.saveDraft").props.disabled).toBe(false)
    await h.submit()
    expect(save).toHaveBeenCalledExactlyOnceWith({
      project: "root/worktree",
      message: "",
      attachments,
      thinkingLevel: "off",
    })
  })

  test("clicking a todo never opens the conversation panel", async () => {
    const h = await harness({ cards: [card()] })
    h.cards()[0].props.onClick()
    expect(h.open).not.toHaveBeenCalled()
  })

  test("starts a todo from its card action", async () => {
    const todo = card()
    const h = await harness({ cards: [todo] })
    h.all()
      .find(child => child.props["data-start-card"])!
      .props.onClick()
    expect(h.startDraft).toHaveBeenCalledExactlyOnceWith(todo)
    expect(h.open).not.toHaveBeenCalled()
  })

  test("dropping a todo onto running uses background start without opening the card", async () => {
    const todo = card({ draftId: "todo" })
    const h = await harness({ cards: [todo] })
    const event = {
      preventDefault: vi.fn(),
      dataTransfer: { setData: vi.fn() },
      target: { closest: () => null },
    }
    h.cards()[0].props.onDragstart(event)
    h.columns()
      .find(column => column.props["data-kanban-column"] === "running")!
      .children.find(child => child.tag === "div" && child.props.onDrop)!
      .props.onDrop(event)
    expect(h.dropDraft).toHaveBeenCalledExactlyOnceWith(todo)
    expect(h.startDraft).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
  })

  test("forwards cardDeleted with the deleted card", async () => {
    const deleted = card()
    const h = await harness({ cards: [deleted] })
    h.all()
      .find(child => child.props["data-delete-card"])!
      .props.onClick()
    expect(h.cardDeleted).toHaveBeenCalledExactlyOnceWith(deleted)
  })

  test("running cards render live content while other columns retain their task preview", async () => {
    const h = await harness({
      cards: [
        card({
          id: "live",
          status: "running",
          activity: { kind: "text", text: "Current streamed progress\nNext line" },
        }),
        card({ id: "idle", status: "idle", activity: { kind: "text", text: "Stale progress" } }),
      ],
    })
    expect(textOf(h.cards()[0])).toContain("Current streamed progress")
    expect(textOf(h.cards()[0])).not.toContain("Task message")
    expect(textOf(h.cards()[1])).toContain("Task message")
    expect(textOf(h.cards()[1])).not.toContain("Stale progress")
    const livePreview = () =>
      descendants(h.cards()[0]).find(
        child =>
          child.props.title === "Current streamed progress\nNext line" ||
          child.props.title === "kanban.executingTool\nTests: 10 passed",
      )!
    expect(livePreview().props.class.split(" ")).toEqual(expect.arrayContaining(["block", "truncate"]))
    expect(livePreview().props.class).not.toMatch(/line-clamp-2|whitespace-pre-wrap|break-words/)
    expect(livePreview().props.title).toBe("Current streamed progress\nNext line")
    const idlePreview = descendants(h.cards()[1]).find(child => child.props.title === "Task message")!
    expect(idlePreview.props.class).toContain("line-clamp-2")
    h.state.cards[0].activity = { kind: "tool", name: "bash", detail: "Tests: 10 passed" }
    await vue.nextTick()
    expect(textOf(h.cards()[0])).toContain("Tests: 10 passed")
    expect(livePreview().props.class.split(" ")).toContain("truncate")
    h.state.cards[0].activity = { kind: "thinking" }
    await vue.nextTick()
    expect(textOf(h.cards()[0])).toContain("chat.thinking")
  })

  test("running and waiting cards show the current round duration while other cards keep update times", async () => {
    const startedAt = Date.now() - 65_000
    const h = await harness({
      cards: [
        card({ id: "running", status: "running", lastPromptAt: startedAt, updatedAt: Date.now() }),
        card({ id: "waiting", status: "waiting", lastPromptAt: startedAt, updatedAt: Date.now() }),
        card({ id: "idle", status: "idle", lastPromptAt: startedAt, updatedAt: Date.now() - 120_000 }),
      ],
    })
    const rendered = h.cards()
    expect(textOf(rendered[0])).toContain("1 minute 5 seconds")
    expect(textOf(rendered[1])).toContain("1 minute 5 seconds")
    expect(textOf(rendered[2])).toContain("2 minutes ago")
    const time = descendants(rendered[0]).find(child => child.tag === "time")!
    expect(time.props.title).toContain("kanban.executionTime: 1 minute 5 seconds")
    expect(time.props.title).toContain("kanban.startedAt:")
    expect(time.props.datetime).toBeUndefined()
  })

  test("keyboard reordering updates only the active project/column and keeps hidden idle peers", async () => {
    const h = await harness({
      cards: Array.from({ length: 40 }, (_, index) => card({ id: String(index), status: "idle" })),
    })
    const event = { key: "ArrowDown", altKey: true, preventDefault: vi.fn() }
    h.cards()[0].props.onKeydown(event)
    await vue.nextTick()
    expect(h.reorder).toHaveBeenCalledExactlyOnceWith("idle", [
      "1",
      "0",
      ...Array.from({ length: 38 }, (_, i) => String(i + 2)),
    ])
    expect(
      h
        .cards()
        .slice(0, 2)
        .map(card => card.props["data-kanban-card"]),
    ).toEqual(["1", "0"])
    h.state.selectedProject = "root"
    await vue.nextTick()
    expect(
      h
        .cards()
        .slice(0, 2)
        .map(card => card.props["data-kanban-card"]),
    ).toEqual(["0", "1"])
    expect(h.open).not.toHaveBeenCalled()
  })

  test("column headings drag to a new position and persist independently from card order", async () => {
    const h = await harness()
    const heading = (status: kanban.KanbanStatus) =>
      h.all().find(child => child.tag === "h2" && textOf(child) === `kanban.${status}`)!
    const targetHeader = () => h.columns().find(column => column.props["data-kanban-column"] === "idle")!.children[0]
    const dataTransfer = { effectAllowed: "none", dropEffect: "none", setData: vi.fn() }
    heading("todo").props.onDragstart({
      preventDefault: vi.fn(),
      dataTransfer,
    })
    const over = {
      clientX: 90,
      preventDefault: vi.fn(),
      dataTransfer,
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }) },
    }
    targetHeader().props.onDragover(over)
    targetHeader().props.onDrop({ preventDefault: vi.fn() })
    await vue.nextTick()
    expect(h.reorderColumns).toHaveBeenCalledExactlyOnceWith(["running", "waiting", "completed", "idle", "todo"])
    expect(h.columns().map(column => column.props["data-kanban-column"])).toEqual([
      "running",
      "waiting",
      "completed",
      "idle",
      "todo",
    ])
    expect(h.reorder).not.toHaveBeenCalled()
    expect(heading("todo").props["aria-description"]).toBe("kanban.reorderColumn")
  })

  test("cards stay clickable during conversation switches while hard navigation guards still apply", async () => {
    const first = card({ id: "first", status: "idle" })
    const second = card({ id: "second", status: "idle" })
    const h = await harness({ cards: [first, second] })
    h.cards()[0].props.onClick()
    h.state.busy = true
    await vue.nextTick()
    expect(h.cards().every(rendered => !rendered.props.disabled)).toBe(true)
    h.cards()[1].props.onClick()
    expect(h.open.mock.calls.map(([selected]) => selected.id)).toEqual(["first", "second"])
    expect(h.byText("kanban.create").props.disabled).toBeFalsy()
    h.state.navigationBusy = true
    await vue.nextTick()
    expect(h.cards().every(rendered => rendered.props.disabled)).toBe(true)
  })

  test("creation uses the session project picker and forwards opening a project", async () => {
    const h = await harness()
    await h.openCreate()

    const picker = h.all().find(child => child.props["data-workspace-project"])!
    expect(picker.props["data-project-placeholder"]).toBeUndefined()
    h.all()
      .find(child => child.props["data-open-project"])!
      .props.onClick()
    expect(h.openProject).toHaveBeenCalledOnce()
  })

  test("parent can preset a project, while an invalid preset defaults to no project", async () => {
    const h = await harness()
    h.board.value!.openCreate("other")
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(true)
    h.all()
      .find(child => child.tag === "textarea")!
      .props.onInput({ target: { value: "Task" } })
    await vue.nextTick()
    h.submit()
    await vue.nextTick()
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ project: "other", message: "Task", thinkingLevel: "off" })
    h.board.value!.openCreate("missing")
    await vue.nextTick()
    h.all()
      .find(child => child.tag === "textarea")!
      .props.onInput({ target: { value: "Task" } })
    await vue.nextTick()
    h.submit()
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.create).toHaveBeenLastCalledWith({ project: "", message: "Task", thinkingLevel: "off" })
  })

  test("keeps five empty columns, renders parent actions, and emits project changes without mutating props", async () => {
    const h = await harness()
    expect(h.columns().map(column => column.props["data-kanban-column"])).toEqual(
      kanban.KANBAN_COLUMNS.map(column => column.id),
    )
    expect(h.columns().every(column => textOf(column).includes("kanban.emptyColumn"))).toBe(true)
    expect(h.all().some(child => child.props["data-actions"])).toBe(true)
    const header = h.all().find(child => child.tag === "header" && child.props.class?.includes("workspace-header"))!
    expect(header.props.class).toContain("min-h-12")
    expect(header.props.class).toContain("py-1.5")
    expect(textOf(header)).not.toContain("kanban.title")
    expect(textOf(header)).not.toContain("kanban.projectFilter")
    h.byText("Other").props.onClick()
    expect(h.select).toHaveBeenCalledExactlyOnceWith("other")
    expect(h.state.selectedProject).toBe("")
  })

  test("project filter searches labels and paths and can be cleared without mutating props", async () => {
    const h = await harness()
    const trigger = () => h.all().find(child => child.props["aria-label"] === "kanban.projectFilter")!
    expect(textOf(trigger())).toContain("kanban.allTasks")
    const search = h
      .all()
      .find(child => child.tag === "input" && child.props["aria-label"] === "workspace.searchProject")!
    search.props.onInput({ target: { value: "OTHER" } })
    await vue.nextTick()
    expect(h.all().some(child => child.tag === "button" && child.props.title === "root")).toBe(false)
    expect(h.all().some(child => child.tag === "button" && child.props.title === "other")).toBe(true)
    h.state.selectedProject = "other"
    await vue.nextTick()
    expect(textOf(trigger())).toContain("Other")
    h.all()
      .find(child => child.tag === "button" && child.props["aria-label"] === "common.clear")!
      .props.onClick()
    expect(h.select).toHaveBeenCalledExactlyOnceWith("")
    expect(h.state.selectedProject).toBe("other")
  })

  test("opens the original card with cwd and marks selection/failure; empty drafts have localized fallbacks", async () => {
    const input = card({
      id: "selected",
      cwd: "root/worktree",
      status: "waiting",
      failed: true,
      title: "",
      preview: "",
    })
    const h = await harness({ cards: [input], selectedId: input.id })
    const rendered = h.cards()[0]
    expect(rendered.props["aria-pressed"]).toBe(true)
    expect(textOf(rendered)).toContain("kanban.untitled")
    expect(textOf(rendered)).toContain("kanban.emptyPreview")
    expect(textOf(rendered)).toContain("kanban.failed")
    rendered.props.onClick()
    expect(h.open).toHaveBeenCalledExactlyOnceWith(input)
    expect(h.open.mock.calls[0][0].cwd).toBe("root/worktree")
  })

  test("all tasks includes ungrouped sessions, while project changes filter and keep empty columns", async () => {
    const h = await harness({ cards: [card(), card({ id: "none", project: "", projectName: "" })] })
    expect(h.cards()).toHaveLength(2)
    expect(textOf(h.cards()[1])).not.toContain("kanban.noProject")
    h.state.selectedProject = "other"
    await vue.nextTick()
    expect(h.cards()).toHaveLength(0)
    expect(h.columns()).toHaveLength(5)
  })

  test("idle lists load more locally; changing project resets pagination without limiting other columns", async () => {
    const cards = Array.from({ length: 65 }, (_, index) =>
      card({ id: `idle-${index}`, status: "idle", updatedAt: index }),
    )
    cards.push(...Array.from({ length: 35 }, (_, index) => card({ id: `todo-${index}` })))
    const h = await harness({ cards })
    expect(h.cards()).toHaveLength(65)
    h.byText("kanban.loadMoreIdle").props.onClick()
    await vue.nextTick()
    expect(h.cards()).toHaveLength(95)
    h.byText("kanban.loadMoreIdle").props.onClick()
    await vue.nextTick()
    expect(h.cards()).toHaveLength(100)
    expect(h.byText("kanban.loadMoreIdle")).toBeUndefined()
    h.state.selectedProject = "root"
    await vue.nextTick()
    expect(h.cards()).toHaveLength(65)
  })

  test("creation rejects unknown projects and whitespace messages; no title or message limit is added", async () => {
    const h = await harness()
    await h.openCreate()
    await h.fill("missing", "message")
    h.submit()
    await h.fill("root", " \n\t ")
    h.submit()
    await h.fill("", " \n\t ")
    h.submit()
    expect(h.create).not.toHaveBeenCalled()
    const dialog = h.all().find(child => child.props["data-dialog"])!
    expect(descendants(dialog).filter(child => child.tag === "input")).toHaveLength(0)
    expect(h.all().find(child => child.tag === "textarea")!.props.maxlength).toBeUndefined()
    const message = "long message\n".repeat(1000)
    await h.fill("root", `  ${message}  `)
    const saved = h.submit()
    h.submit()
    await vue.nextTick()
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ project: "root", message: message.trim(), thinkingLevel: "off" })
    await saved
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(false)
  })

  test("creation carries the selected worktree and base branch", async () => {
    const h = await harness({ selectedProject: "root" })
    await h.openCreate()
    await h.fill("root", "Start in a worktree")
    h.all()
      .find(child => child.props["data-workspace-selection"])!
      .props.onClick()
    await vue.nextTick()
    await h.submit()
    expect(h.create).toHaveBeenCalledExactlyOnceWith({
      project: "root",
      message: "Start in a worktree",
      selection: { project: "root", worktree: true, branch: "main" },
      thinkingLevel: "off",
    })
  })

  test("creation can start immediately and resets the option when reopened", async () => {
    const h = await harness({ selectedProject: "root" })
    await h.openCreate()
    await h.fill("root", "Start now")
    const checkbox = () => h.all().find(child => child.props.role === "checkbox")!
    const nodes = h.all()
    expect(nodes.indexOf(checkbox())).toBeLessThan(nodes.indexOf(h.byText("kanban.cancel")))
    expect(nodes.indexOf(h.byText("kanban.cancel"))).toBeLessThan(nodes.indexOf(h.byText("kanban.saveDraft")))
    expect(checkbox().props["aria-checked"]).toBe("false")
    checkbox().props.onClick()
    await vue.nextTick()
    expect(h.byText("kanban.startDraft")).toBeDefined()
    await h.submit()
    expect(h.create).toHaveBeenCalledExactlyOnceWith({
      project: "root",
      message: "Start now",
      startImmediately: true,
      thinkingLevel: "off",
    })
    await h.openCreate()
    expect(checkbox().props["aria-checked"]).toBe("false")
  })

  test("async creation remains locked until busy settles and retains input on failure for retry", async () => {
    const h = await harness({ selectedProject: "root" })
    h.create.mockImplementation(() => {
      h.state.busy = true
    })
    await h.openCreate()
    await h.fill("root", "Keep this message")
    const failed = h.submit()
    await vue.nextTick()
    h.submit()
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.isDialogOpen()).toBe(true)
    h.all()
      .find(child => child.props["data-dialog"])!
      .props.onDismiss()
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(true)
    h.state.error = "Save failed"
    h.state.busy = false
    await failed
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(true)
    expect(h.all().find(child => child.tag === "textarea")!.props.value).toBe("Keep this message")
    h.state.error = ""
    await vue.nextTick()
    const retried = h.submit()
    await vue.nextTick()
    expect(h.create).toHaveBeenCalledTimes(2)
    h.state.busy = false
    await retried
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(false)
  })

  test("invalid timestamps render safely; loading and retry preserve all columns", async () => {
    const h = await harness({ cards: [card({ updatedAt: Infinity })], loading: true, error: "Offline" })
    expect(textOf(h.cards()[0])).toContain("kanban.unknownTime")
    expect(h.byText("kanban.retry").props.disabled).toBe(true)
    expect(h.columns()).toHaveLength(5)
    h.state.loading = false
    await vue.nextTick()
    h.byText("kanban.retry").props.onClick()
    expect(h.retry).toHaveBeenCalledOnce()
  })

  test.each([
    { busy: true },
    { navigationBusy: true },
    { loading: true },
    { projects: [] },
    { busy: true, navigationBusy: true, loading: true, projects: [] },
  ])("creation entry stays enabled and opens the dialog with %j", async overrides => {
    const h = await harness(overrides)
    expect(h.byText("kanban.create").props.disabled).toBeFalsy()
    await h.openCreate()
    expect(h.isDialogOpen()).toBe(true)
  })

  test("creation keeps native title bar pointer events enabled", async () => {
    const h = await harness()
    await h.openCreate()
    const content = h.all().find(child => child.props["data-dialog-content"])!
    expect(content.props["data-disable-outside-pointer-events"]).toBe(true)
  })

  test("parent can open creation while busy and without projects", async () => {
    const h = await harness({ busy: true, projects: [] })
    h.board.value!.openCreate()
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(true)
  })

  test.each([undefined, []])("creation defaults to no project with project options %j", async projects => {
    const h = await harness(projects ? { projects } : {})
    await h.openCreate()
    h.all()
      .find(child => child.tag === "textarea")!
      .props.onInput({ target: { value: "Task" } })
    await vue.nextTick()
    expect(h.byText("kanban.saveDraft").props.disabled).toBe(false)
    await h.submit()
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ project: "", message: "Task", thinkingLevel: "off" })
    expect(h.isDialogOpen()).toBe(false)
  })

  test("without projects, new tasks can be saved while ungrouped existing cards remain displayed", async () => {
    const h = await harness({ projects: [], cards: [card({ project: "", projectName: "" })] })
    await h.openCreate()
    expect(h.isDialogOpen()).toBe(true)
    expect(h.cards()).toHaveLength(1)
    await h.fill("", "Task")
    await h.submit()
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ project: "", message: "Task", thinkingLevel: "off" })
  })

  test("projectless cards omit the folder/name row without hiding normal projects with the same label", async () => {
    const h = await harness({
      cards: [
        card({ id: "loose", project: "/workspace/loose", projectName: "No project", projectless: true }),
        card({ id: "named", project: "/project", projectName: "No project" }),
      ],
    })
    expect(h.cards()).toHaveLength(2)
    expect(textOf(h.cards()[0])).not.toContain("No project")
    expect(descendants(h.cards()[0]).some(child => child.props.title === "/workspace/loose")).toBe(false)
    expect(textOf(h.cards()[1])).toContain("No project")
  })
})

test("dropping a todo submits in the background with its saved workspace selection", async () => {
  const functionSource = appSource.slice(
    appSource.indexOf("let boardDraftStart ="),
    appSource.indexOf("function startBoardDraft"),
  )
  const code = ts.transpileModule(functionSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const draft = { id: "draft", selection: { project: "/root", worktree: true, branch: "main" } }
  const owner = { runtimeId: "draft", cwd: "/root", started: false }
  const board = {
    selection: { id: "visible" },
    detailsOpen: false,
    startDraft: vi.fn(async (_card, submit) => submit(draft, owner)),
  }
  let finish!: () => void
  const startSession = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        finish = () => resolve(true)
      }),
  )
  const submitBoardDraft = vi.fn(async (_draft, _owner, deps) => deps.ensureStarted())
  const trustStatus = vi.fn(async () => ({ needsDecision: false }))
  const dropBoardDraft = new Function(
    "board",
    "navigating",
    "phase",
    "submitBoardDraft",
    "workspace",
    "t",
    "loadTrustStatus",
    "config",
    "trustStatus",
    "sshTrustStatus",
    "requestWorkspaceTrust",
    "isRemoteProject",
    "startSession",
    "tBackendError",
    "ui",
    `${code}; return dropBoardDraft`,
  )(
    board,
    { value: false },
    { value: "pick" },
    submitBoardDraft,
    { histories: {} },
    String,
    (_cwd, _connections, api) => api.trustStatus(),
    { value: {} },
    trustStatus,
    vi.fn(),
    vi.fn(),
    () => false,
    startSession,
    String,
    { pushToast: vi.fn() },
  )
  dropBoardDraft({ id: "todo" })
  await vi.waitFor(() => expect(startSession).toHaveBeenCalledExactlyOnceWith("draft", draft.selection, true))
  expect(board.detailsOpen).toBe(false)
  expect(board.selection.id).toBe("visible")
  finish()
  await vi.waitFor(() => expect(board.startDraft.mock.settledResults[0]?.type).toBe("fulfilled"))
})

test("creating a todo only opens a conversation when immediate start is requested", async () => {
  const functionSource = appSource.slice(
    appSource.indexOf("async function createBoardDraft"),
    appSource.indexOf("async function ensureBoardStarted"),
  )
  const code = ts.transpileModule(functionSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const board = {
    error: "",
    cards: [{ draftId: "draft" }],
    createDraft: vi.fn(async () => ({ id: "draft" })),
  }
  const openBoardCard = vi.fn()
  const startBoardDraft = vi.fn()
  const createBoardDraft = new Function(
    "board",
    "creatingBoardDraft",
    "openBoardCard",
    "startBoardDraft",
    "tBackendError",
    "ui",
    `${code}; return createBoardDraft`,
  )(board, { value: false }, openBoardCard, startBoardDraft, String, { pushToast: vi.fn() })

  await createBoardDraft({ project: "root", message: "Save only" })
  expect(openBoardCard).not.toHaveBeenCalled()
  expect(startBoardDraft).not.toHaveBeenCalled()

  await createBoardDraft({ project: "root", message: "Start now", startImmediately: true })
  expect(startBoardDraft).toHaveBeenCalledExactlyOnceWith(board.cards[0])
  expect(openBoardCard).not.toHaveBeenCalled()
})

test("the board header exposes project creation through the existing guarded navigation flow", () => {
  const board = appSource.slice(appSource.indexOf("<KanbanBoard"), appSource.indexOf("</KanbanBoard>"))
  const actions = board.match(/<template #actions>([\s\S]*?)<\/template>/)?.[1]
  expect(actions).toBeDefined()
  expect(actions).toContain('t("kanban.createProject")')
  expect(actions).toContain('@click="requestNavigation(switchProject)"')
  expect(actions).toContain(":disabled=\"(workspace.gitBusy && !connecting) || phase === 'trust'\"")
})

test("the board details panel defers read receipts and does not duplicate the todo start action", () => {
  const panel = appSource.slice(appSource.indexOf("<KanbanDetailsPanel"), appSource.indexOf("</KanbanDetailsPanel>"))
  expect(panel).toContain("defer-read-receipt")
  expect(panel).not.toContain("kanban.startDraft")
  expect(panel).not.toContain("boardChat?.submitDraft()")
})

test("both locales translate board UI, fixed columns, and parent layout/drawer/draft actions", () => {
  expect(Object.keys(zhCN.kanban).sort()).toEqual(Object.keys(en.kanban).sort())
  for (const [locale, messages] of [
    ["zh-CN", zhCN],
    ["en", en],
  ] as const) {
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })
    const keys = new Set([
      ...Array.from(source.matchAll(/\bt\(\s*["'](kanban\.[^"']+)["']/g), match => match[1]),
      ...kanban.KANBAN_COLUMNS.map(column => column.labelKey),
      ...[
        "layoutBoard",
        "layoutChat",
        "createProject",
        "openInChat",
        "closeDetails",
        "detailsTitle",
        "draftTitle",
        "startDraft",
        "saveDraft",
        "deleteDraft",
        "draftMessage",
        "starting",
        "saving",
        "cancel",
        "save",
        "close",
      ].map(key => `kanban.${key}`),
    ])
    for (const key of keys) {
      const translated = i18n.global.t(key, { count: 3, error: "Offline" })
      expect(translated).not.toBe(key)
      expect(translated.trim()).not.toBe("")
    }
  }
})
