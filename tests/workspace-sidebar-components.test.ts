import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import path from "node:path"
import * as vue from "vue"
import { compileScript, compileStyle, parse } from "vue/compiler-sfc"
import ts from "typescript"
import * as sessionIdentity from "@/lib/sessionIdentity"
import { setSidebarSessionDragData } from "@/components/workspace/sidebar/useSidebarSessionOrdering"
import { sidebarQueueTitle } from "@/components/workspace/sidebar/useSidebarSessionStatus"

// Compile the actual SFCs against a minimal Vue host; only external widgets/stores are stubbed.
// This avoids browser/E2E dependencies while testing render branches and emitted events.
const directory = path.resolve("src/components/workspace/sidebar")
const session = vue.reactive({ sessionFile: "saved.jsonl", cwd: "root" })
const activeRuntimeId = vue.ref("pending-1")
const workspace = {
  isWorktree: (cwd: string) => cwd.endsWith("worktree"),
  projectRoot: () => "root",
  projectName: (cwd: string) => `name:${cwd}`,
  pinnedProjects: ["root"],
  togglePin: vi.fn(),
}
const queue = vue.reactive([{ text: "saved prompt", sendAt: 61000 }])
const runStatus = vue.ref<string | undefined>("running")
const passthrough = {
  setup:
    (_, { slots }) =>
    () =>
      slots.default?.(),
}
const button = {
  setup:
    (_, { slots, attrs }) =>
    () =>
      vue.h("button", attrs, slots.default?.()),
}
const menuItem = {
  emits: ["select"],
  setup:
    (_, { slots, attrs, emit }) =>
    () =>
      vue.h("button", { ...attrs, onClick: () => emit("select") }, slots.default?.()),
}
const draggable = {
  props: ["modelValue", "disabled", "setData", "animation", "chosenClass", "tag"],
  emits: ["update:modelValue"],
  setup:
    (props, { slots, emit }) =>
    () =>
      vue.h(
        "div",
        {
          sortableFiles: props.modelValue,
          sortableDisabled: props.disabled,
          setData: props.setData,
          onSort: files => emit("update:modelValue", files),
        },
        slots.default?.(),
      ),
}
const cache = new Map()
function loadComponent(filename: string) {
  const file = path.resolve(directory, filename)
  if (cache.has(file)) return cache.get(file)
  const source = readFileSync(file, "utf8")
  const { descriptor } = parse(source, { filename: file })
  const compiled = compileScript(descriptor, { id: filename, inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} as any }
  const require = (id: string) => {
    if (id === "vue") return vue
    if (id === "@/lib/sessionIdentity") return sessionIdentity
    if (id === "vue-i18n") return { useI18n: () => ({ t: key => key }) }
    if (id === "@lucide/vue")
      return new Proxy({}, { get: (_, name) => ({ render: () => vue.h("svg", { icon: name }) }) })
    if (id === "vue-draggable-plus") return { VueDraggable: draggable }
    if (id === "@/stores/conversations")
      return {
        useSessionStore: () => session,
        activeRuntimeId,
        findConversation: () => ({ promptQueue: queue, runtimeId: "saved-runtime" }),
        useUiStore: () => ({ pushToast: vi.fn() }),
      }
    if (id === "@/stores/sessionRunStatus") return { sessionRunStatus: () => runStatus.value }
    if (id === "@/stores/workspace") return { useWorkspaceStore: () => workspace }
    if (id === "@/api/transport") return { isDesktop: true }
    if (id === "@/api/piClient") return { openPath: vi.fn(async () => {}) }
    if (id === "@/components/ui/button") return { Button: button }
    if (id.startsWith("@/components/ui/"))
      return new Proxy({}, { get: (_, name) => (String(name).endsWith("Item") ? menuItem : passthrough) })
    if (id.endsWith(".vue")) return { __esModule: true, default: loadComponent(id) }
    if (id === "./useSidebarSessionOrdering") return { setSidebarSessionDragData }
    if (id === "./useSidebarSessionStatus") return { sidebarQueueTitle }
    throw new Error(`Unexpected import: ${id}`)
  }
  vm.runInNewContext(code, { exports: module.exports, require }, { filename: file })
  cache.set(file, module.exports.default)
  return module.exports.default
}
const node = (tag: string, text = "") => ({ tag, text, props: {} as any, children: [] as any[], parent: null as any })
const renderer = vue.createRenderer({
  createElement: tag => node(tag),
  createText: text => node("text", text),
  createComment: text => node("comment", text),
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    const at = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(at < 0 ? parent.children.length : at, 0, child)
    child.parent = parent
  },
  remove(child) {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
  },
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
    node.children = []
  },
  patchProp: (node, key, _, value) => {
    node.props[key] = value
  },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
})
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const unmount of cleanup.splice(0)) unmount()
})
beforeEach(() => {
  session.sessionFile = "saved.jsonl"
  activeRuntimeId.value = "pending-1"
  runStatus.value = "running"
  vi.clearAllMocks()
})
function mount(filename: string, props = {}) {
  const root = node("root")
  const app = renderer.createApp(loadComponent(filename), props)
  app.mount(root)
  cleanup.push(() => app.unmount())
  return root
}
function find(root, predicate) {
  return [root, ...root.children.flatMap(child => find(child, () => true))].filter(predicate)
}
const byClass = (root, name) =>
  find(root, item =>
    String(item.props.class || "")
      .split(" ")
      .includes(name),
  )
const saved = { file: "saved.jsonl", id: "saved", cwd: "worktree", mtimeMs: 0, title: "Saved title" }
const pending = { runtimeId: "pending-1", cwd: "worktree", promptQueue: [{ text: "Pending prompt" }] }
const listProps = {
  path: "root",
  rows: [saved],
  orderedFiles: ["saved.jsonl", "other.jsonl"],
  pending: [pending],
  query: "",
  disabled: false,
  navigationDisabled: false,
  queueNow: 1000,
  showDraft: true,
  draftWorktree: true,
  hasHistory: true,
}

test("shared list preserves draft → pending → saved order and all session menu events", () => {
  const open = vi.fn(),
    rename = vi.fn(),
    archive = vi.fn(),
    duplicate = vi.fn(),
    copyLink = vi.fn(),
    exportFile = vi.fn(),
    select = vi.fn()
  const root = mount("SidebarSessionList.vue", {
    ...listProps,
    onOpen: open,
    onRenameOnDoubleClick: rename,
    onArchive: archive,
    onDuplicate: duplicate,
    onCopyLink: copyLink,
    onExport: exportFile,
    onSelectConversation: select,
  })
  const rows = byClass(root, "session-row")
  expect(rows).toHaveLength(3)
  expect(rows[0].props["aria-current"]).toBe("page")
  const links = byClass(root, "session-link")
  expect(links.map(link => link.props.title)).toEqual(["Pending prompt", "Saved title"])
  links[0].props.onClick()
  expect(select).toHaveBeenCalledWith("pending-1")
  links[1].props.onClick()
  links[1].props.onDblclick({ stopPropagation() {} })
  expect(open).toHaveBeenCalledWith(saved)
  expect(rename).toHaveBeenCalledWith(saved)
  byClass(root, "session-archive")[0].props.onClick()
  expect(archive).toHaveBeenCalledWith(saved)
  const menuButtons = find(
    root,
    item =>
      item.tag === "button" &&
      item.children.some(
        child =>
          child.text === "workspace.duplicate" || child.text === "workspace.copyLink" || child.text === "chat.export",
      ),
  )
  expect(menuButtons).toHaveLength(3)
  menuButtons.forEach(item => item.props.onClick())
  expect(duplicate).toHaveBeenCalledWith(saved)
  expect(copyLink).toHaveBeenCalledWith(saved)
  expect(exportFile).toHaveBeenCalledWith("saved.jsonl")
  expect(find(root, item => item.props.icon === "Layers")).toHaveLength(3)
})

test("query disables sorting without replacing the full sortable model; navigation and archive busy flags stay separate", () => {
  const reorder = vi.fn()
  const root = mount("SidebarSessionList.vue", {
    ...listProps,
    query: "saved",
    disabled: true,
    navigationDisabled: false,
    onReorder: reorder,
  })
  const sortable = find(root, item => item.props.sortableFiles)[0]
  expect(sortable.props.sortableFiles).toEqual(listProps.orderedFiles)
  expect(sortable.props.sortableDisabled).toBe(true)
  const transfer = { effectAllowed: "none", setData: vi.fn() }
  sortable.props.setData(transfer, { dataset: { file: "saved.jsonl", path: "root" } })
  expect(transfer.setData).toHaveBeenCalledWith("application/x-pix-session", "saved.jsonl")
  expect(transfer.setData).toHaveBeenCalledWith(
    "application/x-pix-session-drag",
    JSON.stringify({ file: "saved.jsonl", path: "root", runtimeId: "saved-runtime" }),
  )
  expect(byClass(root, "session-archive")[0].props.disabled).toBe(true)
  expect(byClass(root, "session-link").every(link => !link.props.disabled)).toBe(true)
  sortable.props.onSort(["other.jsonl", "saved.jsonl"])
  expect(reorder).toHaveBeenCalledWith(["other.jsonl", "saved.jsonl"])
  const navigationBusy = mount("SidebarSessionList.vue", { ...listProps, navigationDisabled: true })
  expect(byClass(navigationBusy, "session-link").every(link => link.props.disabled)).toBe(true)
  const searching = mount("SidebarSessionList.vue", { ...listProps, query: "saved" })
  expect(find(searching, item => item.props.sortableFiles)[0].props.sortableDisabled).toBe(true)
})

test("projectless rows use the same saved/pending components without project worktree badges", () => {
  const root = mount("SidebarSessionList.vue", { ...listProps, projectless: true, draftWorktree: false })
  expect(byClass(root, "session-row")).toHaveLength(3)
  expect(find(root, item => item.props.icon === "Layers")).toHaveLength(0)
  expect(byClass(root, "session-queue-status")).toHaveLength(2)
  expect(byClass(root, "session-running")).toHaveLength(1)
})

test("run and queue indicators react without changing row padding/positions", async () => {
  const root = mount("SidebarSavedSessionRow.vue", {
    s: saved,
    path: "root",
    active: true,
    disabled: false,
    navigationDisabled: false,
    query: "",
    queueNow: 1000,
    worktree: true,
  })
  expect(byClass(root, "session-row")[0].props["data-file"]).toBe("saved.jsonl")
  expect(byClass(root, "session-row")[0].props["data-path"]).toBe("root")
  expect(byClass(root, "session-row")[0].props.class).toContain("pl-11")
  expect(byClass(root, "session-queue-status")[0].props.class).toContain("left-[23px]")
  runStatus.value = "error"
  await vue.nextTick()
  expect(byClass(root, "session-running")).toHaveLength(0)
  expect(byClass(root, "session-status-error")).toHaveLength(1)
  runStatus.value = undefined
  await vue.nextTick()
  expect(byClass(root, "session-row")[0].props.class).toContain("pl-7")
  expect(byClass(root, "session-queue-status")[0].props.class).toContain("left-[7px]")
})

test("project group keeps pin, missing-directory handling and independent collapse/new-session actions", () => {
  const toggle = vi.fn(),
    newSession = vi.fn()
  const root = mount("SidebarProjectGroup.vue", {
    path: "root",
    project: "root",
    ready: false,
    collapsed: false,
    error: "missing",
    disabled: true,
    navigationDisabled: false,
    onToggle: toggle,
    onNewSession: newSession,
  })
  expect(byClass(root, "project-pin")).toHaveLength(1)
  expect(find(root, item => item.props.role === "alert")).toHaveLength(1)
  byClass(root, "project-row")[0].props.onClick()
  expect(toggle).toHaveBeenCalledOnce()
  const newButton = find(root, item => item.tag === "button" && item.props.title === "sidebar.newSession")[0]
  expect(newButton.props.disabled).toBe(true)
  newButton.props.onClick()
  expect(newSession).toHaveBeenCalledWith("root")
})

test("scoped hover selectors remain attached to row/group DOM, including touch spacing and open menus", () => {
  const read = name => readFileSync(path.join(directory, name), "utf8")
  const row = read("SidebarSavedSessionRow.vue")
  const style = parse(row).descriptor.styles[0]!
  const compiled = compileStyle({ source: style.content, filename: "row.vue", id: "data-v-row", scoped: true })
  expect(compiled.errors).toEqual([])
  expect(compiled.code).toContain(".session-row:is(:hover, :has(:focus-visible)) .session-archive[data-v-row]")
  expect(style.content).toMatch(/@media \(hover: none\)[\s\S]*margin-right: 28px/)
  expect(style.content).toMatch(/@media \(pointer: coarse\)[\s\S]*margin-right: 36px/)
  const group = read("SidebarProjectGroup.vue")
  expect(group).toContain(".project-heading:is(:hover, :has(:focus-visible)) > .hover-action")
  expect(group).toContain('.hover-action:has([data-state="open"])')
  const parent = readFileSync(path.resolve(directory, "../../WorkspaceSidebar.vue"), "utf8")
  expect(parent.match(/<SidebarSessionList/g)).toHaveLength(2)
  expect(parent.match(/v-on="sessionActions"/g)).toHaveLength(2)
  expect(parent).toContain("emit('projectless')")
  expect(parent).toContain(".sidebar-section-label:is(:hover, :has(:focus-visible)) > .hover-action")
})

test("a same-path remote row is active only in its own project", () => {
  session.cwd = "ssh://dev@first:22/project"
  const first = mount("SidebarSessionList.vue", { ...listProps, path: session.cwd, pending: [], showDraft: false })
  const second = mount("SidebarSessionList.vue", { ...listProps, path: "ssh://dev@second:22/project", pending: [], showDraft: false })
  expect(byClass(first, "session-row")[0].props["aria-current"]).toBe("page")
  expect(byClass(second, "session-row")[0].props["aria-current"]).toBeUndefined()
  session.cwd = "root"
})
