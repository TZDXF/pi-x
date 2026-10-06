import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import * as vue from "vue"
import { createTerminalOutputRouter } from "@/lib/terminalOutput"
import { terminalConnectionId } from "@/lib/sshTrust"
import { parseCodedError } from "@/lib/backendError"

/**
 * 终端入口守卫解除（契约 §3.4）：
 * - ChatView 的终端快捷键守卫移除（files 守卫保留）
 * - RightSidebar 终端入口对远程项目开放（files 仍本地专属）
 * - TerminalPanel 的 term_create：远程项目带 sshConnectionId，本地恒 undefined；
 *   连接缺失或创建失败时经 translateError toast 展示
 */

const chatViewSource = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
const rightSidebarSource = readFileSync(new URL("../src/components/RightSidebar.vue", import.meta.url), "utf8")

test("ChatView 终端快捷键不再受 isSshProject 守卫，files 守卫保留", () => {
  expect(chatViewSource).toMatch(/registerShortcutHandler\("sidebar\.terminal", \(\) => addSidebarTab\("terminal"\)\)/)
  expect(chatViewSource).toMatch(
    /registerShortcutHandler\("sidebar\.files", \(\) => \{\s*\n\s*if \(!isSshProject\(props\.project\)\) addSidebarTab\("files"\)/,
  )
  // 切换到远程项目时仍关闭 files tab，但不再关闭终端 tab
  expect(chatViewSource).toMatch(/if \(tab\.type === "files"\) closeSidebarTab\(tab\.id\)/)
  expect(chatViewSource).not.toMatch(/tab\.type === "files" \|\| tab\.type === "terminal"/)
})

test("RightSidebar 终端入口对远程项目开放，files 入口保持本地专属", () => {
  expect(rightSidebarSource).toContain("filesAvailable")
  expect(rightSidebarSource).not.toContain("localOnlyAvailable")
  // 两个 add-tab 模块（下拉菜单 + 空态宫格）里：files 各带 v-if，terminal 不带
  const [addMenu, tabsBody] = rightSidebarSource.split("<TabsContent")
  const emptyGrid = tabsBody.split("</TabsContent")[1] ?? ""
  expect(addMenu.match(/v-if="filesAvailable"/g)).toHaveLength(1)
  expect(addMenu.match(/@click="addTab\('terminal'\)"/g)).toHaveLength(1)
  expect(emptyGrid.match(/v-if="filesAvailable"/g)).toHaveLength(1)
  expect(emptyGrid.match(/@click="addTab\('terminal'\)"/g)).toHaveLength(1)
})

// ---- TerminalPanel 行为：复用 terminal-panel.test.ts 的 VM harness ----

const source = readFileSync(new URL("../src/components/terminal/TerminalPanel.vue", import.meta.url), "utf8")
function harness(options: {
  project: string
  connections: { id: string; host: string; port?: number; user?: string | null }[]
  create?: (args: Record<string, any>) => Promise<number>
}) {
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, "")
  const toasts: unknown[][] = []
  const unsubscribe = vi.fn()
  const create =
    options.create ??
    (async () => {
      throw new Error("term_create boom")
    })
  const invoke = vi.fn(async (command: string, args: Record<string, any>) =>
    command === "term_create" ? create(args) : undefined,
  )
  class Terminal {
    options: any = {}
    write = vi.fn()
    writeln = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
  }
  const context = vm.createContext({
    ...vue,
    createTerminalOutputRouter,
    terminalConnectionId,
    sshConnectionList: async () => options.connections,
    tBackendError: (error: unknown) => String(error).replace(/^Error: /, ""),
    useUiStore: () => ({ pushToast: (message: string, kind: string) => toasts.push([message, kind]) }),
    defineProps: () => ({ project: options.project, visible: false, embedded: true }),
    defineEmits: () => vi.fn(),
    defineExpose: () => {},
    useI18n: () => ({ t: (key: string) => key }),
    terminalTheme: vue.ref({ colors: {} }),
    invoke,
    listen: async () => unsubscribe,
    Terminal,
    FitAddon: class {
      fit() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    onBeforeUnmount: () => {},
    window: { removeEventListener() {}, addEventListener() {} },
    atob,
    console: { error: vi.fn() },
  })
  const scope = vue.effectScope()
  scopes.push(scope)
  scope.run(() =>
    vm.runInContext(
      ts.transpile(script + "\nglobalThis.api = { openTerminal, tabs, instances };", {
        target: ts.ScriptTarget.ES2022,
      }),
      context,
    ),
  )
  const api = context.api as { openTerminal(): Promise<void>; tabs: { id: number }[]; instances: Map<number, unknown> }
  return { api, invoke, toasts }
}
const scopes: vue.EffectScope[] = []

afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.restoreAllMocks()
})

test("本地项目 term_create 不带 sshConnectionId", async () => {
  const h = harness({ project: "C:/code/local", connections: [] })
  await h.api.openTerminal()
  expect(h.invoke).toHaveBeenCalledWith(
    "term_create",
    expect.objectContaining({ cwd: "C:/code/local", cols: 80, rows: 24, sshConnectionId: undefined }),
  )
})

test("远程项目 term_create 携带解析出的连接 id", async () => {
  const h = harness({
    project: "ssh://dev@host:2222/home/dev/proj",
    connections: [{ id: "ssh-1", host: "host", port: 2222, user: "dev" }],
  })
  await h.api.openTerminal()
  expect(h.invoke).toHaveBeenCalledWith(
    "term_create",
    expect.objectContaining({ cwd: "ssh://dev@host:2222/home/dev/proj", sshConnectionId: "ssh-1" }),
  )
})

test("远程项目连接缺失：不发 term_create，toast coded sshConnectionMissing", async () => {
  const h = harness({ project: "ssh://dev@host:2222/home/dev/proj", connections: [] })
  await h.api.openTerminal()
  expect(h.invoke).not.toHaveBeenCalled()
  expect(h.toasts).toHaveLength(1)
  const coded = parseCodedError(String(h.toasts[0]![0]))
  expect(coded?.code).toBe("sshConnectionMissing")
  expect(h.toasts[0]![1]).toBe("error")
})

test("term_create 失败经 toast 展示而不再只进 console", async () => {
  const h = harness({ project: "C:/code/local", connections: [] })
  await h.api.openTerminal()
  expect(h.toasts).toEqual([["term_create boom", "error"]])
  expect(h.api.tabs.value).toEqual([])
})
