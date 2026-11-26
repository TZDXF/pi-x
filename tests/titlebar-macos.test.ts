import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { expect, test } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const titlebar = read("../src/components/WindowTitleBar.vue")

// 组件脚本在模板之外只依赖这些运行时设施：用 vm 直接求值真实源码，
// 避免为「双击按系统偏好而不是硬编码最大化」写一个与实现无关的桩。
function harness(props: { isMac: boolean; action?: "maximize" | "minimize" | "none" }) {
  const script = titlebar
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
    .replace(/import\.meta\.env\.DEV/g, "false")
  const calls: string[] = []
  const window = {
    startDragging: async () => {
      calls.push("startDragging")
    },
    minimize: async () => {
      calls.push("minimize")
    },
    toggleMaximize: async () => {
      calls.push("toggleMaximize")
    },
    close: async () => {
      calls.push("close")
    },
    onResized: async () => () => {},
    isMaximized: async () => false,
    isMaximizable: async () => true,
  }
  const context = vm.createContext({
    computed: (fn: () => unknown) => ({
      get value() {
        return fn()
      },
    }),
    ref: (value: unknown) => ({ value }),
    onMounted: () => {},
    onUnmounted: () => {},
    useI18n: () => ({ t: (key: string) => key }),
    getCurrentWindow: () => window,
    isDesktop: true,
    isMacOS: {
      get value() {
        return props.isMac
      },
    },
    resolveTitleBarDoubleClickAction: async () => props.action ?? "maximize",
    useRoute: () => ({ name: "session" }),
    navigate: () => {},
    canGoBack: false,
    canGoForward: false,
    // import 被剥离，这里提供等价语义；这里不涉及远程项目判定。
    isRemoteProject: () => false,
    detectEditors: async () => ({}),
    detectIcons: async () => ({}),
    EDITOR_OPTIONS: [],
    openWithPreference: { value: { kind: "system", executable: "" } },
    setOpenWith: async () => {},
    openPath: async () => {},
    openProjectInEditor: async () => {},
    openTerminalInDir: async () => {},
    useUiStore: () => ({ pushToast: () => {} }),
    useAppUpdateStore: () => ({ status: null }),
    defineProps: () => ({}),
    defineEmits: () => () => {},
  })
  vm.runInContext(
    ts.transpile(
      script +
        `
globalThis.api = {
  get dragRegion() { return macDragRegion.value },
  onDragRegionMouseDown,
  onDragRegionMouseUp,
  onDragRegionDoubleClick,
};`,
      { target: ts.ScriptTarget.ES2022 },
    ),
    context,
  )
  const api = context.api as {
    dragRegion: string
    onDragRegionMouseDown: (event: {
      button: number
      detail: number
      clientX: number
      clientY: number
      preventDefault: () => void
    }) => void
    onDragRegionMouseUp: (event: { button: number; detail: number; clientX: number; clientY: number }) => Promise<void>
    onDragRegionDoubleClick: () => void
  }
  const press = (detail: number, x = 100, y = 10) =>
    api.onDragRegionMouseDown({ button: 0, detail, clientX: x, clientY: y, preventDefault: () => {} })
  const release = (detail: number, x = 100, y = 10) =>
    api.onDragRegionMouseUp({ button: 0, detail, clientX: x, clientY: y })
  return { api, calls, press, release }
}

test("macOS turns off the Tauri drag-region script so it never maximizes on double click", () => {
  expect(harness({ isMac: true }).api.dragRegion).toBe("false")
  // 其他平台继续由 data-tauri-drag-region 注入的脚本处理（等价于原来的裸属性）。
  expect(harness({ isMac: false }).api.dragRegion).toBe("true")
})

test("macOS drags on the first press and leaves the double click to mouseup", async () => {
  const { calls, press, release } = harness({ isMac: true, action: "maximize" })
  press(1)
  await Promise.resolve()
  expect(calls).toEqual(["startDragging"])

  // 第二个 click 的 mousedown 只记录起点，不能再次开始拖拽（否则缩放会被拖拽吞掉）。
  press(2, 100, 10)
  await release(2, 100, 10)
  expect(calls).toEqual(["startDragging", "toggleMaximize"])
})

test("macOS follows the system double-click preference", async () => {
  const minimized = await harness({ isMac: true, action: "minimize" })
  minimized.press(1)
  minimized.press(2, 50, 14)
  await minimized.release(2, 50, 14)
  expect(minimized.calls).toEqual(["startDragging", "minimize"])

  const disabled = await harness({ isMac: true, action: "none" })
  disabled.press(1)
  disabled.press(2, 50, 14)
  await disabled.release(2, 50, 14)
  expect(disabled.calls).toEqual(["startDragging"])
})

test("a double click that moved is treated as a drag, not a zoom", async () => {
  const { calls, press, release } = harness({ isMac: true, action: "maximize" })
  press(1)
  press(2, 100, 10)
  await release(2, 140, 40)
  expect(calls).toEqual(["startDragging"])
})

test("windows and linux keep the previous double-click maximize", async () => {
  const { calls, press, release, api } = harness({ isMac: false })
  press(1)
  press(2)
  await release(2)
  expect(calls).toEqual([])
  api.onDragRegionDoubleClick()
  expect(calls).toEqual(["toggleMaximize"])
})

test("macOS drops the self-drawn window buttons and reserves room for the traffic lights", () => {
  // 红绿灯由 AppKit 画在左上角，自绘的最小化 / 最大化 / 关闭只在非 macOS 上保留。
  expect(titlebar).toContain('v-if="isDesktop && !isMacOS"')
  expect(titlebar).toContain('class="flex h-full items-center pl-[var(--titlebar-lead)]"')
  expect(titlebar).toContain("h-[var(--titlebar-height)]")

  const base = read("../src/styles/base.css")
  const defaults = base.match(/:root \{\n  --titlebar-height: (\d+)px;\n/)![1]
  expect(defaults, "Windows / Linux keep the 36px title bar").toBe("36")
  const macos = base.match(/:root\[data-platform="macos"\] \{\n  --titlebar-height: (\d+)px;\n/)![1]
  expect(Number(macos), "macOS uses the compact ~28pt title bar").toBe(28)

  // 顶部让位与贴着标题栏下沿的覆盖层共用同一个变量，改高度不会漏改。
  expect(read("../src/App.vue")).toContain('style="padding-top: var(--titlebar-height)"')
  expect(read("../src/components/chat/ImagePreviewContent.vue")).toContain("top-[var(--titlebar-height)]")
  expect(read("../src/components/WorkspaceSidebar.vue")).toContain("top-[var(--titlebar-height)]")
})

test("macOS window config switches to native decorations with an overlay title bar", () => {
  const base = JSON.parse(read("../src-tauri/tauri.conf.json"))
  expect(base.app.windows[0].decorations).toBe(false)

  const macos = JSON.parse(read("../src-tauri/tauri.macos.conf.json"))
  const window = macos.app.windows[0]
  // 原生红绿灯需要 decorations；Overlay 让 webview 铺满整窗，标题栏由前端自绘。
  expect(window.decorations).toBe(true)
  expect(window.titleBarStyle).toBe("Overlay")
  expect(window.hiddenTitle).toBe(true)
  // 28px 标题栏的红绿灯中心距顶 14pt：红色按钮下方留出 6pt 的 14pt 按钮 + y。
  expect(window.trafficLightPosition).toEqual({ x: 9, y: 16 })
})

test("the platform probe is wired through the desktop backend, not the user agent", () => {
  const lib = read("../src/lib/platform.ts")
  expect(lib).toContain('invoke<WindowPlatform>("window_platform")')
  expect(lib).not.toContain("navigator.platform")
  expect(lib).not.toContain("@tauri-apps/plugin-")

  const rust = read("../src-tauri/src/platform.rs")
  expect(rust).toContain('cfg!(target_os = "macos")')
  expect(rust).toContain("AppleActionOnDoubleClick")
  expect(rust).toContain("pub fn window_platform")

  const registered = read("../src-tauri/src/lib.rs")
  expect(registered).toContain("platform::window_platform")

  // 启动时先探测平台再渲染，避免先按 Windows 的 36px 画一次再跳变。
  const main = read("../src/main.ts")
  expect(main.indexOf("await initializePlatform()")).toBeLessThan(main.indexOf("createApp(RemoteEntry)"))
})
