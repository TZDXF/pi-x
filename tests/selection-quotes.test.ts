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
  restoreSelection: vi.fn(),
}))

afterEach(() => vi.unstubAllGlobals())

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
    expect(scrollToMessage).toHaveBeenCalledWith(1)
    expect(badge.scrollIntoView).toHaveBeenCalledTimes(1)
  } finally {
    unmount()
  }
  expect(disconnect).toHaveBeenCalled()
})
