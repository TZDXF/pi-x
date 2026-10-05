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
  defaultKind?: string
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
  const preference = { value: { kind: props.defaultKind ?? "vscode", executable: props.customExecutable ?? "" } }
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
    openWithPreference: preference,
    setOpenWith: (kind: string) => {
      preference.value.kind = kind
    },
    openProjectInEditor: async (project: string, kind: string) => {
      if (props.failOpen) throw new Error("boom")
      launched.push({ project, kind })
    },
    openPath: async (path: string) => {
      if (props.failOpen) throw new Error("boom")
      launched.push({ project: path, kind: "system" })
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
    useAppUpdateStore: () => ({ status: null }),
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
  get defaultKind() { return defaultKind.value },
  get defaultLabel() { return defaultLabel.value },
  get openWithMenuItems() { return openWithMenuItems.value },
  openWithDefault,
  chooseOpenWith,
  openInTerminal,
};`,
      { target: ts.ScriptTarget.ES2022 },
    ),
    context,
  )
  return {
    api: context.api as Record<string, unknown> & {
      openInEditorVisible: boolean
      defaultKind: string
      defaultLabel: string
      openWithMenuItems: { id: string; label: string }[]
    },
    launched,
    toasts,
    mounted,
    preference,
  }
}

async function mount(h: ReturnType<typeof harness>) {
  for (const fn of h.mounted) await fn()
}

test("the entry is visible only with a project in an active desktop session", async () => {
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

test("the menu lists the system default first, hides undetected IDEs and appends custom", async () => {
  const detected = harness({
    showOpenInEditor: true,
    openInEditorProject: "C:/code/pi-x",
    availability: { vscode: true, cursor: false, zed: false },
  })
  await mount(detected)
  expect(detected.api.openWithMenuItems).toEqual([
    { id: "system", label: "openWith.system" },
    { id: "vscode", label: "Visual Studio Code" },
  ])

  const withCustom = harness({
    showOpenInEditor: true,
    openInEditorProject: "C:/code/pi-x",
    availability: { vscode: false, cursor: false, zed: false },
    customExecutable: "C:/editors/ide.exe",
  })
  await mount(withCustom)
  expect(withCustom.api.openWithMenuItems).toEqual([
    { id: "system", label: "openWith.system" },
    { id: "custom", label: "openWith.custom" },
  ])

  // 检测失败（如远程模式）时保留完整列表
  const undetected = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x" })
  await mount(undetected)
  expect(undetected.api.openWithMenuItems).toHaveLength(EDITORS.length + 1)
})

test("the main button opens with the default method and system falls back to the opener", async () => {
  const h = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x", defaultKind: "vscode" })
  await mount(h)
  expect(h.api.defaultLabel).toBe("Visual Studio Code")
  await (h.api.openWithDefault as () => Promise<void>)()
  expect(h.launched).toEqual([{ project: "C:/code/pi-x", kind: "vscode" }])

  const system = harness({
    showOpenInEditor: true,
    openInEditorProject: "C:/code/pi-x",
    defaultKind: "system",
  })
  await mount(system)
  expect(system.api.defaultLabel).toBe("openWith.system")
  await (system.api.openWithDefault as () => Promise<void>)()
  expect(system.launched).toEqual([{ project: "C:/code/pi-x", kind: "system" }])
})

test("choosing from the dropdown switches the default and opens with the chosen method", async () => {
  const h = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x", defaultKind: "vscode" })
  await mount(h)
  await (h.api.chooseOpenWith as (kind: string) => Promise<void>)("cursor")
  expect(h.preference.value.kind).toBe("cursor")
  expect(h.launched).toEqual([{ project: "C:/code/pi-x", kind: "cursor" }])

  const toSystem = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x" })
  await mount(toSystem)
  await (toSystem.api.chooseOpenWith as (kind: string) => Promise<void>)("system")
  expect(toSystem.preference.value.kind).toBe("system")
  expect(toSystem.launched).toEqual([{ project: "C:/code/pi-x", kind: "system" }])
})

test("terminal entry opens the session project and failures surface as toasts", async () => {
  const h = harness({ showOpenInEditor: true, openInEditorProject: "C:/code/pi-x" })
  await mount(h)
  await (h.api.openInTerminal as () => Promise<void>)()
  expect(h.launched).toEqual([{ project: "C:/code/pi-x", kind: "terminal" }])

  const failing = harness({
    showOpenInEditor: true,
    openInEditorProject: "C:/code/pi-x",
    failOpen: true,
  })
  await mount(failing)
  await (failing.api.chooseOpenWith as (kind: string) => Promise<void>)("zed")
  expect(failing.launched).toEqual([])
  expect(failing.toasts).toEqual([{ message: "openWith.openProjectFailed", kind: "error" }])
})
