import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import * as vue from "vue"
import { menuPlacement } from "@/lib/selectionMenuPlacement"

/**
 * 划词浮层的两个挂载点（TZD-103）：
 *
 * 1. 会话正文（`mode="chat"`）：两个动作，`auxAsk` 的 payload 与 `quote` 同源；
 * 2. 代码/预览（`mode="code"`）：只有"在辅助对话中提问"，payload 带 `path` +
 *    行区间；渲染态 Markdown 没有 `[data-line]` 时只带 `path`。
 *
 * 另外钉住"只加动作、不动锚点/翻转/钳制算法"这条约束（源码断言）。
 *
 * 用真实 `script setup` 执行（剥掉 import，注入 DOM 工具替身），因此定位与 emit
 * 的逻辑是被真正跑过的，而不是只匹配源码文本。
 */
const source = readFileSync(new URL("../src/components/chat/ConversationSelectionMenu.vue", import.meta.url), "utf8")

interface SelectionStub {
  /** 选区文本（含首尾空白，由组件自己 trim）。 */
  text: string
  /** 选区两端是否落在被测容器内。 */
  inRoot: boolean
  /** 消息来源（`data-selection-source` 的值）；`null` 表示不在消息正文里。 */
  source?: string | null
  messageId?: string
  /** 代码模式下的行区间；`null` 表示没有 `[data-line]`（渲染态 Markdown）。 */
  lineRange?: { start: number; end: number } | null
  /** 划词结束处的矩形（`selectionEndRect` 替身）；缺省为视口中部。 */
  anchor?: { right: number; top: number; bottom: number }
}

function setup(props: Record<string, unknown>, selection: SelectionStub) {
  const script = source
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
    .replace(/^import\s+["'][^"']+["']\n/gm, "")
  const emits = vi.fn()
  const listeners = new Map<string, () => void>()
  // 消息正文根（`[data-selection-source]`）本身也能 `closest("[data-message-id]")`，
  // 与真实 DOM 一致（`inspectChatSelection` 会二次向上查消息 id）。
  const messageElement = { getAttribute: () => selection.messageId ?? "7", closest: () => null }
  const sourceElement = {
    getAttribute: () => selection.source,
    closest: (selector: string) => (selector === "[data-message-id]" ? messageElement : null),
  }
  const lineElement = { dataset: { line: String(selection.lineRange?.start ?? 1) }, closest: () => null }
  const textNode = {
    nodeType: 3,
    parentElement: {
      closest: (selector: string) => {
        if (selector === "[data-selection-source]") return selection.source == null ? null : sourceElement
        if (selector === "[data-line]") return selection.lineRange ? lineElement : null
        return null
      },
    },
  }
  const range = { startContainer: textNode, endContainer: textNode }
  const context = vm.createContext({
    ...vue,
    defineProps: () => props,
    withDefaults: (value: unknown) => value,
    defineEmits: () => emits,
    useI18n: () => ({ t: (key: string) => key }),
    captureOffsets: () => ({ start: 3, end: 12 }),
    // 纯函数按真实实现注入（像素级断言在 `aux-selection-placement.test.ts`）。
    menuPlacement,
    MenuPlacement: undefined,
    selectionEndRect: () => selection.anchor ?? { right: 120, top: 40, bottom: 60 },
    selectionLineRange: () => (selection.lineRange ? { ...selection.lineRange } : null),
    onBeforeUnmount: (callback: () => void) => vue.onScopeDispose(callback),
    document: {
      addEventListener: (type: string, handler: () => void) => listeners.set(type, handler),
      removeEventListener: (type: string) => listeners.delete(type),
    },
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      getSelection: () => ({
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => range,
        toString: () => selection.text,
        removeAllRanges: () => {},
      }),
    },
  })
  const scope = vue.effectScope()
  scope.run(() =>
    vm.runInContext(
      ts.transpile(
        script +
          `\nglobalThis.api = { state, placement, tooLong, menuBox, measuredWidth, choosingAux, onMouseUp, askInAux, chooseAuxTarget, quoteSelection };`,
        { target: ts.ScriptTarget.ES2022 },
      ),
      context,
    ),
  )
  // 被测容器：`contains` 由用例决定选区是否落在里面（代码区与会话容器都是这种形状）。
  const root = { contains: (node: unknown) => selection.inRoot && node === textNode, querySelector: () => null }
  return { api: context.api, emits, listeners, scope, root }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test("chat mode keeps both actions and emits the same payload for quote and auxAsk", () => {
  const props: Record<string, unknown> = { maxTextLength: 8000, mode: "chat", root: null }
  const h = setup(props, { text: "  选中的正文  ", inRoot: true, source: "assistant" })
  props.root = h.root
  try {
    // 点"引用到输入框"：payload 与既有实现一字不差。
    h.api.onMouseUp()
    expect(h.api.state.value.text).toBe("选中的正文")
    h.api.quoteSelection()
    expect(h.emits).toHaveBeenCalledWith("quote", {
      text: "选中的正文",
      source: "assistant",
      messageId: 7,
      startOffset: 3,
      endOffset: 12,
    })
    // 菜单点一次就收起；用户再划一次词才看到菜单 —— 此时点"在辅助对话中提问"。
    h.api.onMouseUp()
    h.api.askInAux()
    expect(h.emits).toHaveBeenLastCalledWith("auxAsk", {
      text: "选中的正文",
      source: "assistant",
      messageId: 7,
      startOffset: 3,
      endOffset: 12,
    })
    // 收起之后不再 emit（DOM 可能已被流式更新改写）。
    expect(h.api.state.value).toBeNull()
    h.api.askInAux()
    expect(h.emits).toHaveBeenCalledTimes(2)
  } finally {
    h.scope.stop()
  }
})

test("multiple aux targets require an explicit existing conversation or new-chat choice", () => {
  const props: Record<string, unknown> = {
    maxTextLength: 8000,
    mode: "chat",
    root: null,
    auxCanCreate: true,
    auxTargets: [
      { runtimeId: "aux:a", title: "辅助对话 1" },
      { runtimeId: "aux:b", title: "辅助对话 2" },
    ],
  }
  const h = setup(props, { text: "选中的正文", inRoot: true, source: "assistant" })
  props.root = h.root
  try {
    h.api.onMouseUp()
    h.api.askInAux()
    // 多实例时不能沿用“激活优先/最近一个”的隐式投递。
    expect(h.api.choosingAux.value).toBe(true)
    expect(h.api.state.value).not.toBeNull()
    expect(h.emits).not.toHaveBeenCalled()
    h.api.chooseAuxTarget("aux:b")
    expect(h.emits).toHaveBeenCalledWith(
      "auxAsk",
      { text: "选中的正文", source: "assistant", messageId: 7, startOffset: 3, endOffset: 12 },
      "aux:b",
    )
    expect(h.api.choosingAux.value).toBe(false)
    expect(h.api.state.value).toBeNull()

    // 同一路径也能明确新建；null 与“未传 target”的自动路由区分开。
    h.api.onMouseUp()
    h.api.askInAux()
    h.api.chooseAuxTarget(null)
    expect(h.emits).toHaveBeenLastCalledWith(
      "auxAsk",
      { text: "选中的正文", source: "assistant", messageId: 7, startOffset: 3, endOffset: 12 },
      null,
    )
  } finally {
    h.scope.stop()
  }
})

test("code mode carries path and line range and never emits a prompt quote", () => {
  const props: Record<string, unknown> = { maxTextLength: 8000, mode: "code", path: "src/a.ts", root: null }
  const h = setup(props, { text: "选中的代码", inRoot: true, lineRange: { start: 4, end: 6 } })
  props.root = h.root
  try {
    h.api.onMouseUp()
    h.api.askInAux()
    expect(h.emits).toHaveBeenCalledTimes(1)
    expect(h.emits).toHaveBeenCalledWith("auxAsk", {
      text: "选中的代码",
      path: "src/a.ts",
      lineRange: { start: 4, end: 6 },
    })
    expect(h.emits.mock.calls[0]![0]).toBe("auxAsk")
  } finally {
    h.scope.stop()
  }
})

test("code mode without line numbers (rendered Markdown) sends the path only", () => {
  const props: Record<string, unknown> = { maxTextLength: 8000, mode: "code", path: "docs/a.md", root: null }
  const h = setup(props, { text: "选中的段落", inRoot: true, lineRange: null })
  props.root = h.root
  try {
    h.api.onMouseUp()
    h.api.askInAux()
    expect(h.emits).toHaveBeenCalledWith("auxAsk", { text: "选中的段落", path: "docs/a.md" })
  } finally {
    h.scope.stop()
  }
})

test("selections outside the given root never open the menu", () => {
  const props: Record<string, unknown> = { maxTextLength: 8000, mode: "code", path: "src/a.ts", root: null }
  const h = setup(props, { text: "选中的代码", inRoot: false, lineRange: { start: 4, end: 6 } })
  props.root = h.root
  try {
    h.api.onMouseUp()
    expect(h.api.state.value).toBeNull()
    expect(h.emits).not.toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test("oversized selections grey out both actions and emit nothing", () => {
  const props: Record<string, unknown> = { maxTextLength: 3, mode: "chat", root: null }
  const h = setup(props, { text: "选中的正文", inRoot: true, source: "user" })
  props.root = h.root
  try {
    h.api.onMouseUp()
    // 超长时两个动作都是 disabled（模板层），点不动也不 emit。
    expect(h.api.tooLong.value).toBe(true)
    h.api.quoteSelection()
    h.api.askInAux()
    expect(h.emits).not.toHaveBeenCalled()
  } finally {
    h.scope.stop()
  }
})

test("the menu sits below the selection and flips above when space runs out", () => {
  const props: Record<string, unknown> = { maxTextLength: 8000, mode: "chat", root: null }
  // 视口中部：下方空间充足 → 贴在选区下方 4px。
  const below = setup(props, { text: "选中的正文", inRoot: true, source: "user" })
  props.root = below.root
  try {
    below.api.onMouseUp()
    expect(below.api.placement.value).toEqual({ left: "120px", top: "64px" })
  } finally {
    below.scope.stop()
  }
  // 贴到视口底部（视口 800，bottom=780）→ 翻到选区上方。
  const flipProps: Record<string, unknown> = { maxTextLength: 8000, mode: "code", path: "src/a.ts", root: null }
  const flip = setup(flipProps, {
    text: "选中的代码",
    inRoot: true,
    lineRange: { start: 4, end: 4 },
    anchor: { right: 124, top: 770, bottom: 780 },
  })
  flipProps.root = flip.root
  try {
    flip.api.onMouseUp()
    expect(flip.api.placement.value).toEqual({ left: "124px", bottom: "34px" })
  } finally {
    flip.scope.stop()
  }
})

test("code mode renders only the aux action and chat mode renders both", () => {
  // 模板层：`mode === "chat"` 是"引用到输入框"的唯一开关（代码模式下批注走行号栏）。
  // 只断言 emit 不够 —— 代码模式的 payload 本来就没有消息区间，误渲染按钮也不会 emit。
  const template = source.split("</script>")[1]!
  expect(template).toContain("v-if=\"mode === 'chat'\"")
  const chatButtons = template.split("selectionAdd").length - 1
  expect(chatButtons).toBe(1)
  expect(template.split("selectionAskAux").length - 1).toBe(2)
  // 多实例选择态列出全部已有实例，并提供独立的新建入口。
  expect(template).toContain('v-for="target in auxTargets"')
  expect(template).toContain('@click="chooseAuxTarget(target.runtimeId)"')
  expect(template).toContain('@click="chooseAuxTarget(null)"')
})

test("the anchor / flip / clamp rules are unchanged and only the width source moved", () => {
  // 定位规则委派给纯函数（像素级用例见 `aux-selection-placement.test.ts`）：
  // 锚点仍是 selectionEndRect（多行取最后一行），翻转阈值 48、间距 4、左边距 8 全部保留。
  expect(source).toContain('import { menuPlacement, type MenuPlacement } from "@/lib/selectionMenuPlacement"')
  expect(source).toContain("return menuPlacement(")
  expect(source).toContain("state.value.anchor")
  expect(source).toContain("{ width: window.innerWidth, height: window.innerHeight }")
  // 横向钳制改为**实测宽度**：不再有写死的 168。
  expect(source).not.toContain("window.innerWidth - 168")
  expect(source).toContain("measuredWidth.value || estimatedWidth.value")
  expect(source).toContain("menuBox.value?.offsetWidth")
  // 锚点来源仍是 selectionEndRect（不自造矩形）。
  expect(source).toContain("const endRect = selectionEndRect(range)")
  // 四个 document 级监听（含捕获阶段的 scroll）与卸载清理。
  for (const type of ["selectionchange", "mouseup", "keyup"]) {
    expect(source).toContain(`document.addEventListener("${type}"`)
    expect(source).toContain(`document.removeEventListener("${type}"`)
  }
  expect(source).toContain('document.addEventListener("scroll", onScroll, true)')
  expect(source).toContain('document.removeEventListener("scroll", onScroll, true)')
  // 控件内选区排除不变。
  expect(source).toContain(
    '"button, a, textarea, input, select, sup[data-selection-anchor], [contenteditable], [data-no-selection]"',
  )
})
