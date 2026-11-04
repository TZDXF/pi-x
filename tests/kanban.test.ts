import { readFileSync } from "node:fs"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import { createI18n } from "vue-i18n"
import ts from "typescript"
import * as kanban from "@/lib/kanban"
import { useKanbanCardSorting } from "@/composables/useKanbanCardSorting"
import { formatKanbanTime } from "@/lib/kanbanTime"
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
const button = vue.defineComponent({
  setup:
    (_, { slots, attrs }) =>
    () =>
      vue.h("button", attrs, slots.default?.()),
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
const textarea = vue.defineComponent({
  props: ["modelValue"],
  emits: ["update:modelValue"],
  setup:
    (props, { attrs, emit }) =>
    () =>
      vue.h("textarea", {
        ...attrs,
        value: props.modelValue,
        onInput: event => emit("update:modelValue", event.target.value),
      }),
})
const source = readFileSync(new URL("../src/components/kanban/KanbanBoard.vue", import.meta.url), "utf8")
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
  "@/lib/kanbanTime": { formatKanbanTime },
  "@/composables/useKanbanCardSorting": { useKanbanCardSorting },
  "@/composables/useKanbanSelectionScroll": { useKanbanSelectionScroll: () => {} },
  "@/components/ui/button": { Button: button },
  "@/components/ui/textarea": { Textarea: textarea },
  "@/components/ui/dialog": {
    Dialog: dialog,
    DialogContent: passthrough,
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
    retry = vi.fn(),
    select = vi.fn(),
    reorder = vi.fn((column: kanban.KanbanStatus, ids: string[]) => {
      state.columnOrder = { ...state.columnOrder, [kanban.kanbanColumnOrderKey(state.selectedProject, column)]: ids }
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
          onRetry: retry,
          onReorder: reorder,
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
    retry,
    reorder,
    select,
  }
}

describe("KanbanBoard", () => {
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

  test("cards stay clickable during conversation switches while hard navigation guards still apply", async () => {
    const first = card({ id: "first" })
    const second = card({ id: "second" })
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

  test("parent can open creation with an explicit project, while an invalid preset requires a new selection", async () => {
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
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ project: "other", message: "Task" })
    h.board.value!.openCreate("missing")
    await vue.nextTick()
    h.all()
      .find(child => child.tag === "textarea")!
      .props.onInput({ target: { value: "Task" } })
    await vue.nextTick()
    h.submit()
    expect(h.create).toHaveBeenCalledOnce()
  })

  test("keeps five empty columns, renders parent actions, and emits project changes without mutating props", async () => {
    const h = await harness()
    expect(h.columns().map(column => column.props["data-kanban-column"])).toEqual(
      kanban.KANBAN_COLUMNS.map(column => column.id),
    )
    expect(h.columns().every(column => textOf(column).includes("kanban.emptyColumn"))).toBe(true)
    expect(h.all().some(child => child.props["data-actions"])).toBe(true)
    const select = h.all().find(child => child.tag === "select")!
    expect(select.props.value).toBe("")
    select.props.onChange({ target: { value: "other" } })
    expect(h.select).toHaveBeenCalledExactlyOnceWith("other")
    expect(h.state.selectedProject).toBe("")
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

  test("creation requires a known project and non-whitespace message; no title or message limit is added", async () => {
    const h = await harness()
    await h.openCreate()
    await h.fill("", "message")
    h.submit()
    await h.fill("missing", "message")
    h.submit()
    await h.fill("root", " \n\t ")
    h.submit()
    expect(h.create).not.toHaveBeenCalled()
    expect(h.all().filter(child => child.tag === "input")).toHaveLength(0)
    expect(h.all().find(child => child.tag === "textarea")!.props.maxlength).toBeUndefined()
    const message = "long message\n".repeat(1000)
    await h.fill("root", `  ${message}  `)
    const saved = h.submit()
    h.submit()
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ project: "root", message: message.trim() })
    await saved
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(false)
  })

  test("async creation remains locked until busy settles and retains input on failure for retry", async () => {
    const h = await harness({ selectedProject: "root" })
    h.create.mockImplementation(() => {
      h.state.busy = true
    })
    await h.openCreate()
    await h.fill("root", "Keep this message")
    h.submit()
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
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(true)
    expect(h.all().find(child => child.tag === "textarea")!.props.value).toBe("Keep this message")
    h.state.error = ""
    await vue.nextTick()
    h.submit()
    await vue.nextTick()
    expect(h.create).toHaveBeenCalledTimes(2)
    h.state.busy = false
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

  test("parent can open creation while busy and without projects", async () => {
    const h = await harness({ busy: true, projects: [] })
    h.board.value!.openCreate()
    await vue.nextTick()
    expect(h.isDialogOpen()).toBe(true)
  })

  test("without projects, creation opens while ungrouped existing cards are still displayed", async () => {
    const h = await harness({ projects: [], cards: [card({ project: "", projectName: "" })] })
    await h.openCreate()
    expect(h.isDialogOpen()).toBe(true)
    expect(h.cards()).toHaveLength(1)
    await h.fill("", "Task")
    h.submit()
    expect(h.create).not.toHaveBeenCalled()
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
