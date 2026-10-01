import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const EDITORS = [
  { id: "vscode", label: "Visual Studio Code" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
]

function harness(props: {
  showOpenInEditor?: boolean
  openInEditorProject?: string
  isDesktop?: boolean
  availability?: Record<string, boolean>
  customExecutable?: string
  failOpen?: boolean
}) {
  const source = readFileSync(new URL("../src/components/WindowTitleBar.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
    .replace(/import\.meta\.env\.DEV/g, "false")
  const launched: { project: string; kind: string }[] = []
  const toasts: { message: string; kind: string }[] = []
  const mounted: (() => void | Promise<void>)[] = []
  const context = vm.createContext({
    computed: (fn: () => unknown) => ({
      get value() {
        return fn()
      },
    }),
    ref: (value: unknown) => ({ value }),
    onMounted: (fn: () => void | Promise<void>) => {
      mounted.push(fn)
    },
    onUnmounted: () => {},
    useI18n: () => ({ t: (key: string) => key }),
    useRoute: () => ({ name: "session" }),
    navigate: () => {},
    canGoBack: false,
    canGoForward: false,
    isDesktop: props.isDesktop ?? true,
    getCurrentWindow: () => ({
      onResized: async () => () => {},
      isMaximized: async () => false,
      isMaximizable: async () => true,
    }),
    // availability 未提供时模拟检测失败（如远程模式），组件应保留完整列表
    detectEditors: async () => {
      if (!props.availability) throw new Error("detection unavailable")
      return props.availability
    },
    detectIcons: async () => ({}),
    EDITOR_OPTIONS: EDITORS,
    openWithPreference: { value: { kind: "vscode", executable: props.customExecutable ?? "" } },
    openProjectInEditor: async (project: string, kind: string) => {
      if (props.failOpen) throw new Error("boom")
      launched.push({ project, kind })
    },
    openPath: async (path: string) => {
      if (props.failOpen) throw new Error("boom")
      launched.push({ project: path, kind: "explorer" })
    },
    openTerminalInDir: async (dir: string) => {
      if (props.failOpen) throw new Error("boom")
      launched.push({ project: dir, kind: "terminal" })
    },
    useUiStore: () => ({
      pushToast: (message: string, kind: string) => {
        toasts.push({ message, kind })
      },
    }),
    // 组件宏由 vue 编译器展开，这里直接提供运行时等价物以便对逻辑求值。
    defineProps: () => ({ ...props }),
    defineEmits: () => (event: string, payload: unknown) => {
      void event
      void payload
    },
  })
  vm.runInContext(
    ts.transpile(
      source +
        `
globalThis.api = {
  get openInEditorVisible() { return openInEditorVisible.value },
  get editorMenuItems() { return editorMenuItems.value },
  get editorsDetected() { return editorsDetected.value },
  get editorAvailability() { return editorAvailability.value },
  get openingProject() { return openingProject.value },
  openInEditor,
  openInExplorer,
  openInTerminal,
};`,
      { target: ts.ScriptTarget.ES2022 },
    ),
    context,
  )
  return {
    api: (context as { api: Record<string, { value?: unknown }> | Record<string, unknown> }).api,
    launched,
    toasts,
    mounted,
  }
}

async function mount(h: ReturnType<typeof harness>) {
  for (const fn of h.mounted) await fn()
}

test("the IDE entry is visible only with a project in an active desktop session", async () => {
  const shown = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x" })
  await mount(shown)
  expect(shown.api.openInEditorVisible).toBe(true)

  const noProject = harness({ showOpenInEditor: true })
  await mount(noProject)
  expect(noProject.api.openInEditorVisible).toBe(false)

  const hidden = harness({ openInEditorProject: "C:/code/pi-x" })
  await mount(hidden)
  expect(hidden.api.openInEditorVisible).toBe(false)

  const remote = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x", isDesktop: false })
  await mount(remote)
  expect(remote.api.openInEditorVisible).toBe(false)
})

test("detected availability filters the menu and custom IDE is appended only when configured", async () => {
  const detected = harness({
    showOpenInEditor: true,
    openInEditorProject: "C:/code/pi-x",
    availability: { vscode: true, cursor: false, zed: false },
  })
  await mount(detected)
  expect(detected.api.editorsDetected).toBe(true)
  expect(detected.api.editorMenuItems).toEqual([{ id: "vscode", label: "Visual Studio Code" }])

  const withCustom = harness({
    showOpenInEditor: true,
    openInEditorProject: "C:/code/pi-x",
    availability: { vscode: false, cursor: false, zed: false },
    customExecutable: "C:/editors/ide.exe",
  })
  await mount(withCustom)
  expect(withCustom.api.editorMenuItems).toEqual([{ id: "custom", label: "openWith.custom" }])

  const undetected = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x" })
  await mount(undetected)
  expect(undetected.api.editorsDetected).toBe(false)
  expect(undetected.api.editorMenuItems).toHaveLength(EDITORS.length)

  // 检测成功但全部未安装且未配置自定义 IDE：菜单为空，由模板渲染提示项
  const none = harness({
    showOpenInEditor: true,
    openInEditorProject: "C:/code/pi-x",
    availability: { vscode: false, cursor: false, zed: false },
  })
  await mount(none)
  expect(none.api.editorMenuItems).toEqual([])
})

test("choosing an entry opens the session project with that editor and reports failures", async () => {
  const h = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x", availability: { vscode: true } })
  await mount(h)
  await (h.api.openInEditor as (kind: string) => Promise<void>)("vscode")
  expect(h.launched).toEqual([{ project: "C:/code/pi-x", kind: "vscode" }])

  const failing = harness({
    showOpenInEditor: true,
    openInEditorProject: "C:/code/pi-x",
    failOpen: true,
  })
  await mount(failing)
  await (failing.api.openInEditor as (kind: string) => Promise<void>)("vscode")
  expect(failing.launched).toEqual([])
  expect(failing.toasts).toEqual([{ message: "openWith.openProjectFailed", kind: "error" }])
})

test("explorer and terminal entries open the session project in the same way", async () => {
  const h = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x" })
  await mount(h)
  await (h.api.openInExplorer as () => Promise<void>)()
  await (h.api.openInTerminal as () => Promise<void>)()
  expect(h.launched).toEqual([
    { project: "C:/code/pi-x", kind: "explorer" },
    { project: "C:/code/pi-x", kind: "terminal" },
  ])

  const failing = harness({
    showOpenInEditor: true,
    openInEditorProject: "C:/code/pi-x",
    failOpen: true,
  })
  await mount(failing)
  await (failing.api.openInTerminal as () => Promise<void>)()
  expect(failing.launched).toEqual([])
  expect(failing.toasts).toEqual([{ message: "openWith.openProjectFailed", kind: "error" }])
})
