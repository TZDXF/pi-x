import { afterEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import path from "node:path"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import ts from "typescript"

/**
 * 远程会话列表（契约 §2.4）：
 * - store.refresh 远程分支走 ssh_sessions（连接 id 复用 resolveSshConnectionId），
 *   加载状态由 remoteSessionsLoading 驱动；失败置空并上抛，不影响其它项目
 * - 连接缺失降级：coded error sshConnectionMissing，histories 置空
 * - 侧栏渲染：远程空态文案、历史区头部刷新按钮；远程会话行菜单仅保留“打开”
 */

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  connections: [] as { id: string; host: string; port?: number; user?: string | null }[],
  remoteRows: [] as unknown[],
  remoteError: null as Error | null,
  sshSessionsImpl: null as null | ((project: string, sshConnectionId: string) => Promise<unknown[]>),
  localRows: [] as unknown[],
  sshSessionsCalls: [] as { project: string; sshConnectionId: string }[],
  localListCalls: [] as string[],
}))

vi.mock("@/api/piClient", () => ({
  listSessions: (path: string) => {
    mocks.localListCalls.push(path)
    return Promise.resolve(mocks.localRows)
  },
  updateSession: async () => 0,
  resolveProjectlessDir: async () => ({ dir: "/tmp/ws", defaultDir: "/tmp/ws", isDefault: true }),
  workspaceGitInfo: async () => {
    throw new Error("not a repository")
  },
  sshConnectionList: async () => mocks.connections,
  sshSessions: (project: string, sshConnectionId: string) => {
    mocks.sshSessionsCalls.push({ project, sshConnectionId })
    if (mocks.sshSessionsImpl) return mocks.sshSessionsImpl(project, sshConnectionId)
    if (mocks.remoteError) return Promise.reject(mocks.remoteError)
    return Promise.resolve(mocks.remoteRows)
  },
  pixLog: () => {},
}))

vi.mock("@/api/transport", () => ({
  invoke: async () => undefined,
}))

function localStorageFor(storage: Map<string, string>) {
  return {
    getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
    removeItem: (key: string) => {
      storage.delete(key)
    },
  }
}

async function harness() {
  vi.resetModules()
  setActivePinia(createPinia())
  vi.stubGlobal("localStorage", localStorageFor(mocks.storage))
  const { useWorkspaceStore } = await import("@/stores/workspace")
  return useWorkspaceStore()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function resetMocks() {
  mocks.storage = new Map()
  mocks.connections = []
  mocks.remoteRows = []
  mocks.remoteError = null
  mocks.sshSessionsImpl = null
  mocks.localRows = []
  mocks.sshSessionsCalls.length = 0
  mocks.localListCalls.length = 0
}

const URI = "ssh://dev@host:2222/home/dev/proj"

test("workspace.refresh：远程项目按连接 id 调 ssh_sessions 并填充历史", async () => {
  resetMocks()
  mocks.connections = [{ id: "ssh-1", host: "host", port: 2222, user: "dev" }]
  mocks.remoteRows = [
    { file: "/home/dev/proj/.pi/sessions/a.jsonl", id: "a", cwd: URI, mtimeMs: 200, title: "Remote A" },
    { file: "/home/dev/proj/.pi/sessions/b.jsonl", id: "b", cwd: URI, mtimeMs: 100 },
  ]
  const store = await harness()
  await store.refresh(URI)
  expect(mocks.sshSessionsCalls).toEqual([{ project: URI, sshConnectionId: "ssh-1" }])
  expect(mocks.localListCalls).toHaveLength(0)
  expect(store.histories[URI]).toEqual(mocks.remoteRows)
  expect(store.remoteSessionsLoading[URI]).toBe(false)
})

test("workspace.refresh：加载期间 remoteSessionsLoading 为真，结束后复位", async () => {
  resetMocks()
  mocks.connections = [{ id: "ssh-1", host: "host", port: 2222, user: "dev" }]
  let release!: (rows: unknown[]) => void
  const gated = new Promise<unknown[]>(resolve => {
    release = resolve
  })
  mocks.sshSessionsImpl = () => gated
  const store = await harness()
  const pending = store.refresh(URI)
  await Promise.resolve()
  expect(store.remoteSessionsLoading[URI]).toBe(true)
  release([])
  await pending
  expect(store.remoteSessionsLoading[URI]).toBe(false)
  expect(mocks.sshSessionsCalls).toEqual([{ project: URI, sshConnectionId: "ssh-1" }])
})

test("workspace.refresh：连接缺失抛 coded sshConnectionMissing，历史置空", async () => {
  resetMocks()
  mocks.connections = []
  const store = await harness()
  await expect(store.refresh(URI)).rejects.toThrow("sshConnectionMissing")
  expect(mocks.sshSessionsCalls).toHaveLength(0)
  expect(store.histories[URI]).toEqual([])
  expect(store.remoteSessionsLoading[URI]).toBe(false)
})

test("workspace.refresh：远程失败置空自身历史并上抛，不清空其它项目", async () => {
  resetMocks()
  mocks.connections = [{ id: "ssh-1", host: "host", port: 2222, user: "dev" }]
  const store = await harness()
  const localUri = "C:/code/local"
  mocks.localRows = [{ file: "l.jsonl", id: "l", cwd: localUri, mtimeMs: 1 }]
  await store.refresh(localUri)
  expect(store.histories[localUri]).toHaveLength(1)
  mocks.remoteError = new Error("sshTimeout")
  await expect(store.refresh(URI)).rejects.toThrow("sshTimeout")
  expect(store.histories[URI]).toEqual([])
  expect(store.histories[localUri]).toHaveLength(1)
})

test("workspace.refresh：过期的远程响应不覆盖最新结果", async () => {
  resetMocks()
  mocks.connections = [{ id: "ssh-1", host: "host", port: 2222, user: "dev" }]
  let releaseFirst!: (rows: unknown[]) => void
  const first = new Promise<unknown[]>(resolve => {
    releaseFirst = resolve
  })
  let call = 0
  mocks.sshSessionsImpl = () =>
    call++ === 0 ? first : Promise.resolve([{ file: "new.jsonl", id: "new", cwd: URI, mtimeMs: 9 }])
  const store = await harness()
  const pendingFirst = store.refresh(URI)
  await store.refresh(URI)
  releaseFirst([{ file: "old.jsonl", id: "old", cwd: URI, mtimeMs: 1 }])
  await pendingFirst
  expect(mocks.sshSessionsCalls).toHaveLength(2)
  expect(store.histories[URI]).toEqual([{ file: "new.jsonl", id: "new", cwd: URI, mtimeMs: 9 }])
})

// ---- 侧栏渲染：真实 SFC 编译 + 最小 Vue host ----

const directory = path.resolve("src/components/workspace/sidebar")
const session = vue.reactive({ sessionFile: "" })
const activeRuntimeId = vue.ref("")
const workspace = vue.reactive({
  isWorktree: () => false,
  projectRoot: () => "root",
  projectName: (cwd: string) => `name:${cwd}`,
  pinnedProjects: [] as string[],
  remoteSessionsLoading: { [URI]: false } as Record<string, boolean>,
})
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
    (props, { slots }) =>
    () =>
      vue.h("div", null, slots.default?.()),
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
    if (id === "vue-i18n") return { useI18n: () => ({ t: key => key }) }
    if (id === "@lucide/vue")
      return new Proxy({}, { get: (_, name) => ({ render: () => vue.h("svg", { icon: name }) }) })
    if (id === "vue-draggable-plus") return { VueDraggable: draggable }
    if (id === "@/stores/conversations")
      return {
        useSessionStore: () => session,
        activeRuntimeId,
        findConversation: () => undefined,
        useUiStore: () => ({ pushToast: () => {} }),
      }
    if (id === "@/stores/sessionRunStatus") return { sessionRunStatus: () => undefined }
    if (id === "@/stores/workspace") return { useWorkspaceStore: () => workspace }
    if (id === "@/api/transport") return { isDesktop: true }
    if (id === "@/api/piClient") return { openPath: vi.fn(async () => {}) }
    if (id === "@/components/ui/button") return { Button: button }
    if (id.startsWith("@/components/ui/"))
      return new Proxy({}, { get: (_, name) => (String(name).endsWith("Item") ? menuItem : passthrough) })
    if (id.endsWith(".vue")) return { __esModule: true, default: loadComponent(id) }
    if (id === "./useSidebarSessionOrdering") return { setSidebarSessionDragData: () => {} }
    if (id === "./useSidebarSessionStatus") return { sidebarQueueTitle: () => "" }
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
  createComment: () => node("comment", ""),
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
const byText = (root, text) =>
  find(root, item => item.tag === "button" && item.children.some(child => child.text === text))

const saved = { file: "a.jsonl", id: "a", cwd: URI, mtimeMs: 0, title: "Remote session" }
const listProps = {
  path: URI,
  rows: [] as unknown[],
  orderedFiles: [] as string[],
  pending: [],
  query: "",
  disabled: false,
  navigationDisabled: false,
  queueNow: 0,
  showDraft: false,
  hasHistory: false,
  remote: true,
}

test("远程列表空态展示 remoteSessionsEmpty 并提供历史区刷新按钮", async () => {
  const refresh = vi.fn()
  const root = mount("SidebarSessionList.vue", { ...listProps, onRefresh: refresh })
  expect(find(root, item => item.text === "ssh.remoteSessionsEmpty")).toHaveLength(1)
  const refreshButton = find(root, item => item.tag === "button" && item.props.title === "ssh.sessionsRefresh")[0]
  expect(refreshButton).toBeTruthy()
  expect(refreshButton.props.disabled).toBe(false)
  refreshButton.props.onClick()
  expect(refresh).toHaveBeenCalledOnce()
  // 加载中：按钮禁用并带旋转动画
  workspace.remoteSessionsLoading[URI] = true
  await vue.nextTick()
  expect(
    find(root, item => item.tag === "button" && item.props.title === "ssh.sessionsRefresh")[0].props.disabled,
  ).toBe(true)
  workspace.remoteSessionsLoading[URI] = false
})

test("本地项目不渲染远程空态与刷新按钮", () => {
  const root = mount("SidebarSessionList.vue", { ...listProps, remote: false, path: "C:/code/local" })
  expect(find(root, item => item.text === "ssh.remoteSessionsEmpty")).toHaveLength(0)
  expect(find(root, item => item.tag === "button" && item.props.title === "ssh.sessionsRefresh")).toHaveLength(0)
})

test("远程会话行右键菜单仅保留“打开”，本地操作入口隐藏", async () => {
  const open = vi.fn()
  const rename = vi.fn()
  const archive = vi.fn()
  const duplicate = vi.fn()
  const copyLink = vi.fn()
  const exportFile = vi.fn()
  const root = mount("SidebarSavedSessionRow.vue", {
    s: saved,
    path: URI,
    active: false,
    disabled: false,
    navigationDisabled: false,
    query: "",
    queueNow: 0,
    worktree: false,
    remote: true,
    onOpen: open,
    onRename: rename,
    onArchive: archive,
    onDuplicate: duplicate,
    onCopyLink: copyLink,
    onExport: exportFile,
  })
  // 归档悬浮按钮隐藏；打开仍可用
  expect(find(root, item => String(item.props.class || "").includes("session-archive"))).toHaveLength(0)
  const link = find(root, item => String(item.props.class || "").includes("session-link"))[0]
  link.props.onClick()
  expect(open).toHaveBeenCalledWith(saved)
  // 双击重命名禁用
  link.props.onDblclick({ stopPropagation() {} })
  expect(rename).not.toHaveBeenCalled()
  // 右键菜单仅 workspace.open
  const menuButtons = byText(root, "workspace.rename")
    .concat(byText(root, "workspace.duplicate"))
    .concat(byText(root, "workspace.copyLink"))
    .concat(byText(root, "chat.export"))
  expect(menuButtons).toHaveLength(0)
  const openItems = byText(root, "workspace.open")
  expect(openItems).toHaveLength(1)
  openItems[0].props.onClick()
  expect(open).toHaveBeenCalledTimes(2)
  expect(archive).not.toHaveBeenCalled()
  expect(duplicate).not.toHaveBeenCalled()
  expect(copyLink).not.toHaveBeenCalled()
  expect(exportFile).not.toHaveBeenCalled()
})

test("本地会话行保留完整菜单", () => {
  const root = mount("SidebarSavedSessionRow.vue", {
    s: { ...saved, cwd: "C:/code/local" },
    path: "C:/code/local",
    active: false,
    disabled: false,
    navigationDisabled: false,
    query: "",
    queueNow: 0,
    worktree: false,
  })
  expect(byText(root, "workspace.rename")).toHaveLength(1)
  expect(byText(root, "workspace.duplicate")).toHaveLength(1)
  expect(byText(root, "workspace.copyLink")).toHaveLength(1)
  expect(byText(root, "chat.export")).toHaveLength(1)
  expect(find(root, item => String(item.props.class || "").includes("session-archive"))).toHaveLength(1)
})
