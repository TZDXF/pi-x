import { afterEach, expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import ts from "typescript"
import { readFileSync } from "node:fs"

/**
 * `ChatComposer` 的**默认路径**真渲染用例（TZD-101 加入 `hideWorkspaceContext` 之后）。
 *
 * 为什么必须挂载而不是读源码文本：`hideWorkspaceContext?: boolean` 是**可选 prop**，
 * 默认路径的可见性是**运行时**行为。任何"模板断言"都对下面这种回退完全无感——
 * 把 prop 用 `withDefaults(... { hideWorkspaceContext: true })` 给一个 `true` 默认，
 * 模板一字不改、源码断言照样命中，但主会话的项目/分支选择器已经**默认被隐藏**。
 * 本用例就钉这条：不传 ⇒ 渲染；传 `true` ⇒ 不渲染。
 */
const source = readFileSync(new URL("../src/components/chat/ChatComposer.vue", import.meta.url), "utf8")
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: "composer-default-test", inlineTemplate: true })
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

/* ---- 最小 renderer：只有"渲染了什么标签"这一个可观测量 ---- */
interface HostNode {
  tag: string
  props: Record<string, unknown>
  parent: HostNode | null
  children: HostNode[]
}
const node = (tag = "root"): HostNode => ({ tag, props: {}, parent: null, children: [] })
const renderer = vue.createRenderer<HostNode, HostNode>({
  createElement: tag => node(tag),
  createText: tag => node(`text:${tag}`),
  createComment: tag => node(`comment:${tag}`),
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
    child.parent = parent
  },
  remove(child) {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = null
  },
  parentNode: child => child.parent,
  nextSibling: child => {
    const siblings = child.parent?.children ?? []
    return siblings[siblings.indexOf(child) + 1] ?? null
  },
  setText() {},
  setElementText() {},
  patchProp(el, key, _previous, value) {
    el.props[key] = value
  },
})

/** 记录"`WorkspaceContext` 是否被渲染、拿到的 props 是什么"。 */
type WorkspaceRender = { props: Record<string, unknown> } | null
let workspaceRender: WorkspaceRender = null
const WorkspaceContextStub = {
  name: "WorkspaceContext",
  props: ["project", "initialSelection", "disabled", "projectPicker", "projectPlaceholder"],
  emits: ["selectProject", "openProject"],
  setup(props: Record<string, unknown>) {
    // 记录本次渲染；卸载时（v-if 变 false）由宿主在 unmount 后清空。
    workspaceRender = { props: { ...props } }
    return () => vue.h("workspace-context-stub", { ...props })
  },
  unmounted() {
    // v-if 切换会卸载本组件：可见性判据随之归零。
    workspaceRender = null
  },
}
/** 其余子组件用空壳替身：本用例只看 `WorkspaceContext` 的可见性。 */
const Stub = { setup: () => () => vue.h("stub") }

function harness(extraProps: Record<string, unknown> = {}) {
  workspaceRender = null
  const session = vue.reactive({
    promptQueue: [],
    entries: [],
    isStreaming: false,
    historyLoading: false,
    commands: [],
    cwd: "C:/repo",
    sessionFile: null,
  })
  const bridge = vue.ref(null)
  const workspaceSelection = vue.ref(null)
  const controls = {
    pendingComments: vue.ref([]),
    pendingSelections: vue.ref([]),
    delayedSend: vue.ref(false),
    delayedSendEnabled: vue.ref(false),
    sendDelayMinutes: vue.ref(10),
    sendDelaySeconds: vue.ref(0),
    showStopButton: vue.computed(() => false),
    codeComments: { remove: vi.fn() },
    conversationSelections: { remove: vi.fn() },
    onSendDelayWheel: vi.fn(),
    onSubmit: vi.fn(),
    abort: vi.fn(),
    onInputError: vi.fn(),
  }
  const emptySlots = { model: () => vue.h("stub"), context: () => vue.h("stub") }
  const app = renderer.createApp({
    setup: () => () =>
      vue.h(
        ComposerProxy,
        {
          session,
          runtimeId: "main",
          project: "C:/repo",
          gitBusy: false,
          connecting: false,
          connected: true,
          editBusy: false,
          sessionDragOver: false,
          initialDraft: "",
          ensureStarted: async () => true,
          controls,
          bridge: bridge.value,
          "onUpdate:bridge": (value: unknown) => {
            bridge.value = value as never
          },
          workspaceSelection: workspaceSelection.value,
          "onUpdate:workspaceSelection": (value: unknown) => {
            workspaceSelection.value = value as never
          },
          ...extraProps,
        },
        emptySlots,
      ),
  })
  app.mount(node())
  apps.push(app)
  return app
}

/* ---- 编译 `ChatComposer.vue` 到最小组件图 ---- */
const imports: Record<string, unknown> = {
  vue,
  "vue-i18n": { useI18n: () => ({ t: (key: string) => key, te: () => true }) },
  "reka-ui": { NumberFieldRoot: Stub, NumberFieldInput: Stub },
  "@lucide/vue": { Clock3: Stub, MessageSquareQuote: Stub },
  "@/components/ui/button": { Button: Stub },
  "@/components/ai-elements/prompt-input": { PromptInputHeader: Stub, PromptInputSubmit: Stub },
  "@/components/PromptInputBridge.vue": Stub,
  "@/components/chat/ConversationSelectionSummary.vue": Stub,
  "@/components/WorkspaceContext.vue": WorkspaceContextStub,
  "./ChatQueuePanel.vue": Stub,
  "./ChatPromptInput.vue": Stub,
  "@/components/StatusBar.vue": Stub,
  "@/lib/paths": { baseName: (path: string) => path },
}
const moduleExports = {} as { default?: unknown }
new Function("exports", "require", code)(moduleExports, (id: string) => imports[id])
const ComposerProxy = moduleExports.default as unknown as vue.Component

const apps: Array<{ unmount: () => void }> = []
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  vi.unstubAllGlobals()
})

test("主会话默认路径：不传 hideWorkspaceContext 时项目/分支选择器可见", () => {
  harness()
  // 不传 ⇒ 必须渲染（这正是 `withDefaults(true)` 这类回退会破坏的东西）。
  expect(workspaceRender).not.toBe(null)
  // 可见且可用：`disabled` 跟随 gitBusy/connecting（这里都是 false）。
  expect(workspaceRender!.props.disabled).toBe(false)
  expect(workspaceRender!.props.project).toBe("C:/repo")
})

test("aux 面板：传 hideWorkspaceContext=true 时不渲染项目/分支选择器", () => {
  harness({ hideWorkspaceContext: true })
  expect(workspaceRender).toBe(null)
})

test("传 hideWorkspaceContext=false 与不传等价（显式 false 不应隐藏）", () => {
  harness({ hideWorkspaceContext: false })
  expect(workspaceRender).not.toBe(null)
})
