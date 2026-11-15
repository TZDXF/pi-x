import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { nextTick, ref } from "vue"
import { useSelectionQuotes } from "@/composables/useSelectionQuotes"
import { addAuxSelection, auxSelectionItems, resetAuxSelectionsForTest } from "@/stores/auxSelections"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import { mountBrowserComposable } from "./browserTestHarness"

/**
 * aux 面板内引用的**本地锚点**与**编辑锚点**（TZD-103 P2-4 / P2-5）。
 *
 * 两条契约：
 * 1. 消息 id 只在产生它的那个 runtime 里有意义 —— 跨 runtime（含来源未标注）一律不
 *    恢复选区、不打徽标，避免"主会话的消息 1"落到 aux 正文里无关的内容上；
 * 2. 文件来源引用（`{path}`，无 `messageId`）没有可定位正文，但摘要里的"编辑"必须
 *    给到可用的锚点（不能直接 return）。
 */
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@/lib/selectionAnchors", () => ({
  selectionEndRect: () => ({ right: 120, top: 40, bottom: 60, left: 120 }),
  boundaryRect: () => ({ right: 120, top: 40, width: 10, height: 10 }),
  flashSelection: vi.fn(() => vi.fn()),
  restoreSelection: vi.fn(() => true),
}))

beforeEach(() => {
  // `useSelectionQuotes` 在有引用时会挂 MutationObserver + rAF（锚点重算）。
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0))
  vi.stubGlobal("cancelAnimationFrame", clearTimeout)
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetAuxSelectionsForTest()
})

const AUX_RUNTIME = "aux:one"

function mountAux() {
  const wrapper = { getBoundingClientRect: () => ({ left: 10, top: 20, right: 640, bottom: 700 }) }
  const root = {
    // 只对"消息正文 wrapper"返回节点：徽标查询返回 null（测试环境没有真实覆盖层）。
    querySelector: (selector: string) => (selector.includes("data-selection-source") ? wrapper : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 700 }),
    contains: () => true,
  }
  const conversation = ref({ $el: root, scrollToMessage: vi.fn(async () => {}) })
  const { result, unmount } = mountBrowserComposable(() =>
    useSelectionQuotes({
      session: { runtimeId: AUX_RUNTIME, sessionFile: null } as unknown as SessionStore,
      ui: { pushToast: vi.fn() } as unknown as UiStore,
      project: () => "project",
      renderedEntries: () => [],
      conversation: conversation as unknown as Parameters<typeof useSelectionQuotes>[0]["conversation"],
      auxRuntimeId: AUX_RUNTIME,
    }),
  )
  return { result, unmount }
}

test("a reference produced in another runtime never restores or badging in this panel", async () => {
  setActivePinia(createPinia())
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
    getSelection: () => ({ rangeCount: 0, removeAllRanges: vi.fn() }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  // 主会话划词进来的引用：消息 1，但来源是主会话 runtime。
  addAuxSelection(AUX_RUNTIME, {
    text: "MAIN",
    source: "user",
    messageId: 1,
    startOffset: 0,
    endOffset: 4,
    sourceRuntimeId: "runtime:main",
  })
  const { result, unmount } = mountAux()
  try {
    await nextTick()
    // 跨 runtime：不渲染消息内徽标（那会把引用钉到 aux 自己的消息 1 上）。
    expect(result.anchorOverlays.value.size).toBe(0)
    // 定位也不滚动到本面板的消息 1（只可能是"无本地正文"的直返）。
    await result.locateSelection(auxSelectionItems(AUX_RUNTIME)[0]!.id)
    expect(result.anchorOverlays.value.size).toBe(0)
  } finally {
    unmount()
  }
})

test("a reference quoted inside this aux panel does restore locally", async () => {
  setActivePinia(createPinia())
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
    getSelection: () => ({ rangeCount: 0, removeAllRanges: vi.fn() }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  const item = auxSelectionItems(AUX_RUNTIME).length
  // 面板内的 "引用到输入框" 会带上本 aux 的 runtimeId（见 `useSelectionQuotes.addSelection`）。
  const { result, unmount } = mountAux()
  try {
    result.onSelectionQuote({ text: "AUX 正文", source: "assistant", messageId: 1, startOffset: 0, endOffset: 5 })
    expect(item).toBe(0)
    expect(auxSelectionItems(AUX_RUNTIME)[0]!.sourceRuntimeId).toBe(AUX_RUNTIME)
    await nextTick()
    await result.recomputeAnchors()
    // 同 runtime：徽标落在消息 1（本面板确实是它的出处）。
    expect(result.anchorOverlays.value.get(1)?.length).toBe(1)
  } finally {
    unmount()
  }
})

test("a file-source reference still gets a usable edit anchor", async () => {
  setActivePinia(createPinia())
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
    getSelection: () => ({ rangeCount: 0, removeAllRanges: vi.fn() }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  // 代码预览区划词进 aux：只有 {path, lineRange}，没有消息 id。
  addAuxSelection(AUX_RUNTIME, { text: "code", path: "src/a.ts", lineRange: { start: 3, end: 4 } })
  const { result, unmount } = mountAux()
  try {
    const id = auxSelectionItems(AUX_RUNTIME)[0]!.id
    await result.editSelection(id)
    // 编辑流程里有 nextTick + rAF（锚点回显）；等它跑完再卸载替身，否则收尾时 window 已还原。
    await new Promise(resolve => setTimeout(resolve, 10))
    // 不能是 null（否则摘要里的"编辑"点了没反应）。
    expect(result.selectionPopup.value).toEqual({
      id,
      comment: "",
      anchor: expect.objectContaining({ left: expect.any(Number), top: expect.any(Number) }),
    })
  } finally {
    unmount()
  }
})
