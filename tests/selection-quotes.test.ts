import { afterEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { nextTick, ref } from "vue"
import { boundaryRect } from "@/lib/selectionAnchors"
import { useSelectionQuotes } from "@/composables/useSelectionQuotes"
import { useConversationSelectionsStore } from "@/stores/conversationSelections"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import { mountBrowserComposable } from "./browserTestHarness"

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@/lib/selectionAnchors", () => ({
  selectionEndRect: () => ({ right: 120, top: 40, bottom: 60 }),
  boundaryRect: vi.fn(),
  flashSelection: vi.fn(() => vi.fn()),
  restoreSelection: vi.fn(),
}))

afterEach(() => vi.unstubAllGlobals())

test("quoting immediately opens the comment editor and saves to the new reference", () => {
  setActivePinia(createPinia())
  vi.stubGlobal("window", {
    getSelection: () => ({ rangeCount: 1, getRangeAt: vi.fn(), removeAllRanges: vi.fn() }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  const { result, unmount } = mountBrowserComposable(() =>
    useSelectionQuotes({
      session: { sessionFile: "session" } as SessionStore,
      ui: { pushToast: vi.fn() } as unknown as UiStore,
      project: () => "project",
      renderedEntries: () => [],
      conversation: ref(null),
    }),
  )
  try {
    const payload = { text: "quoted text", source: "assistant" as const, messageId: 1, startOffset: 0, endOffset: 11 }
    result.onSelectionQuote(payload)
    const store = useConversationSelectionsStore()
    expect(result.selectionPopup.value).toEqual({
      id: store.items[0]!.id,
      comment: "",
      anchor: { left: 120, top: 40, bottom: 60 },
    })
    result.onSelectionCancel()
    expect(store.items).toHaveLength(1)
    result.onSelectionQuote(payload)
    expect(store.items).toHaveLength(1)
    expect(result.selectionPopup.value).toBeNull()
    result.onSelectionQuote({ ...payload, text: "another quote" })
    result.onSelectionSave("my comment")
    expect(store.items[1]!.comment).toBe("my comment")
    expect(result.selectionPopup.value).toBeNull()
    result.onSelectionQuote({ ...payload, text: "x".repeat(100_000) })
    expect(result.selectionPopup.value).toBeNull()
    expect(store.items).toHaveLength(2)
  } finally {
    unmount()
  }
})

test("restores anchors after virtual content mounts and locates a missing badge in one click", async () => {
  setActivePinia(createPinia())
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  let mutation!: () => void
  const disconnect = vi.fn()
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutation = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    },
  )
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0))
  vi.stubGlobal("cancelAnimationFrame", clearTimeout)
  vi.mocked(boundaryRect).mockReturnValue({ right: 120, top: 40 } as DOMRect)
  const store = useConversationSelectionsStore()
  store.add("session", { text: "quote", source: "assistant", messageId: 1, startOffset: 0, endOffset: 5 })
  let mounted = false
  let badgeVisible = false
  const badge = { scrollIntoView: vi.fn() }
  const wrapper = { getBoundingClientRect: () => ({ left: 10, top: 20 }) }
  const root = {
    querySelector: (selector: string) =>
      selector.includes("data-selection-anchor") ? (badgeVisible ? badge : null) : mounted ? wrapper : null,
  }
  const scrollToMessage = vi.fn(async () => {
    mounted = true
    badgeVisible = true
  })
  const conversation = ref({ $el: root, scrollToMessage })
  const { result, unmount } = mountBrowserComposable(() =>
    useSelectionQuotes({
      session: { sessionFile: "session" } as SessionStore,
      ui: {} as UiStore,
      project: () => "project",
      renderedEntries: () => [],
      conversation: conversation as unknown as Parameters<typeof useSelectionQuotes>[0]["conversation"],
    }),
  )
  try {
    await nextTick()
    expect(result.anchorOverlays.value.size).toBe(0)
    mounted = true
    mutation()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(result.anchorOverlays.value.get(1)).toEqual([{ id: store.items[0]!.id, index: 1, left: 112, top: 4 }])
    const previous = result.anchorOverlays.value
    await result.recomputeAnchors()
    expect(result.anchorOverlays.value).toBe(previous)
    mounted = false
    await result.locateSelection(store.items[0]!.id)
    // 现在会把"发起定位时取得的视口请求身份"一并传下去（测试替身没有该入口时为 undefined）。
    expect(scrollToMessage).toHaveBeenCalledWith(1, undefined)
    expect(badge.scrollIntoView).toHaveBeenCalledTimes(1)
  } finally {
    unmount()
  }
  expect(disconnect).toHaveBeenCalled()
})

test("a reference clipped by the collapsed prompt is revealed before locating (TZD-138 P2)", async () => {
  // 折叠态正文只露出 6 行：落在裁剪区的引用在气泡里没有可见锚点。收起时不该画徽标
  // （否则徽标落在气泡下方空白处），点摘要定位时应先展开正文、再重算锚点。
  setActivePinia(createPinia())
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0))
  vi.stubGlobal("cancelAnimationFrame", clearTimeout)
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  // 第 11 行的末端矩形（视口坐标）：远在 6 行高（120px）之下。
  vi.mocked(boundaryRect).mockReturnValue({ right: 120, top: 400 } as DOMRect)
  const store = useConversationSelectionsStore()
  store.add("session", { text: "quote", source: "user", messageId: 1, startOffset: 0, endOffset: 5 })
  const item = store.items[0]!
  let expanded = false
  let badgeVisible = false
  const badge = { scrollIntoView: vi.fn() }
  const clippedBody = {
    getBoundingClientRect: () => ({ top: 20, bottom: expanded ? 600 : 140, height: expanded ? 580 : 120 }),
  }
  const wrapper = {
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    querySelector: (selector: string) => (selector.includes("data-prompt-collapsed") ? clippedBody : null),
  }
  const root = {
    querySelector: (selector: string) =>
      selector.includes("data-selection-anchor") ? (badgeVisible ? badge : null) : wrapper,
  }
  const scrollToMessage = vi.fn(async () => {})
  const conversation = ref({ $el: root, scrollToMessage })
  const revealClippedPrompt = vi.fn((messageId: number) => {
    if (messageId !== 1 || expanded) return false
    expanded = true
    badgeVisible = true
    return true
  })
  const { result, unmount } = mountBrowserComposable(() =>
    useSelectionQuotes({
      session: { sessionFile: "session" } as SessionStore,
      ui: {} as UiStore,
      project: () => "project",
      renderedEntries: () => [],
      conversation: conversation as unknown as Parameters<typeof useSelectionQuotes>[0]["conversation"],
      revealClippedPrompt,
    }),
  )
  try {
    // 收起态：引用在裁剪区 → 不画徽标。
    await result.recomputeAnchors()
    expect(result.anchorOverlays.value.get(1)).toBeUndefined()
    // 点摘要条目：先展开（真值），再重算锚点并滚到徽标。
    await result.locateSelection(item.id)
    expect(revealClippedPrompt).toHaveBeenCalledWith(1)
    expect(expanded).toBe(true)
    expect(result.anchorOverlays.value.get(1)).toHaveLength(1)
    expect(badge.scrollIntoView).toHaveBeenCalledTimes(1)
    // 已展开时不再重复展开（幂等），定位走常规路径。
    await result.locateSelection(item.id)
    expect(revealClippedPrompt).toHaveBeenCalledTimes(1)
    expect(scrollToMessage).not.toHaveBeenCalled()
  } finally {
    unmount()
  }
})

test("without a reveal hook a clipped reference is simply not badged", async () => {
  // aux 面板等没有折叠态的场景：没有 hook 时 isClippedOut 仍生效（不画徽标），
  // 也不会因为缺 hook 而抛错。
  setActivePinia(createPinia())
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0))
  vi.stubGlobal("cancelAnimationFrame", clearTimeout)
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.mocked(boundaryRect).mockReturnValue({ right: 120, top: 400 } as DOMRect)
  const store = useConversationSelectionsStore()
  store.add("session", { text: "quote", source: "user", messageId: 1, startOffset: 0, endOffset: 5 })
  const clippedBody = { getBoundingClientRect: () => ({ top: 20, bottom: 140, height: 120 }) }
  const wrapper = {
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    querySelector: (selector: string) => (selector.includes("data-prompt-collapsed") ? clippedBody : null),
  }
  const root = {
    querySelector: (selector: string) => (selector.includes("data-selection-anchor") ? null : wrapper),
  }
  const conversation = ref({ $el: root, scrollToMessage: vi.fn(async () => {}) })
  const { result, unmount } = mountBrowserComposable(() =>
    useSelectionQuotes({
      session: { sessionFile: "session" } as SessionStore,
      ui: {} as UiStore,
      project: () => "project",
      renderedEntries: () => [],
      conversation: conversation as unknown as Parameters<typeof useSelectionQuotes>[0]["conversation"],
    }),
  )
  try {
    await result.recomputeAnchors()
    expect(result.anchorOverlays.value.size).toBe(0)
    await result.locateSelection(store.items[0]!.id)
  } finally {
    unmount()
  }
})

test("a virtualized (unmounted) target is revealed on the first click, after remount (TZD-138 P2)", async () => {
  // 虚拟化会把滚出视口的行**整行卸载**：第一次点击时 `[data-selection-source]` 根本不存在，
  // 旧的定位链路只在滚动前查一次正文、判断裁剪，卸载时查不到；`scrollToMessage` 重挂后
  // 又只重算锚点没再查一次，于是第一次点击只把正文重挂出来（仍是收起态、无徽标），
  // 要再点一次才生效。这里钉住"重挂后重新查询 + 判断裁剪 + 展开 + 重算锚点"。
  setActivePinia(createPinia())
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0))
  vi.stubGlobal("cancelAnimationFrame", clearTimeout)
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.mocked(boundaryRect).mockReturnValue({ right: 120, top: 260 } as DOMRect)
  const store = useConversationSelectionsStore()
  store.add("session", { text: "quote", source: "user", messageId: 1, startOffset: 0, endOffset: 5 })
  const item = store.items[0]!
  let mounted = false
  let expanded = false
  const badge = { scrollIntoView: vi.fn() }
  // 收起态正文只露出 6 行：引用在第 11 行（rect.top 260）—— 落在裁剪区外。
  const clippedBody = {
    getBoundingClientRect: () => ({ top: 20, bottom: expanded ? 700 : 140, height: expanded ? 680 : 120 }),
  }
  const wrapper = {
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    querySelector: (selector: string) => (selector.includes("data-prompt-collapsed") ? clippedBody : null),
  }
  const root = {
    querySelector: (selector: string) => {
      if (selector.includes("data-selection-anchor")) return expanded ? badge : null
      return mounted ? wrapper : null
    },
  }
  const scrollToMessage = vi.fn(async () => {
    mounted = true
  })
  const conversation = ref({ $el: root, scrollToMessage })
  const revealClippedPrompt = vi.fn((messageId: number) => {
    if (messageId !== 1 || expanded) return false
    expanded = true
    return true
  })
  const { result, unmount } = mountBrowserComposable(() =>
    useSelectionQuotes({
      session: { sessionFile: "session" } as SessionStore,
      ui: {} as UiStore,
      project: () => "project",
      renderedEntries: () => [],
      conversation: conversation as unknown as Parameters<typeof useSelectionQuotes>[0]["conversation"],
      revealClippedPrompt,
    }),
  )
  try {
    await result.recomputeAnchors()
    expect(result.anchorOverlays.value.size, "unmounted row contributes no badge").toBe(0)
    // 首次点击：一次调用就要完成"重挂 → 判断裁剪 → 展开 → 重算 → 滚到徽标"。
    await result.locateSelection(item.id)
    // 现在会把"发起定位时取得的视口请求身份"一并传下去（测试替身没有该入口时为 undefined）。
    expect(scrollToMessage).toHaveBeenCalledWith(1, undefined)
    expect(revealClippedPrompt, "revealed exactly once, after the remount").toHaveBeenCalledTimes(1)
    expect(expanded).toBe(true)
    expect(result.anchorOverlays.value.get(1), "badge recomputed for the remounted row").toHaveLength(1)
    expect(badge.scrollIntoView).toHaveBeenCalledTimes(1)
    // 再点一次：已展开且徽标在，直接定位，不重复展开、不重复滚动。
    await result.locateSelection(item.id)
    expect(revealClippedPrompt).toHaveBeenCalledTimes(1)
    expect(scrollToMessage).toHaveBeenCalledTimes(1)
  } finally {
    unmount()
  }
})
