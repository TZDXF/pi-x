import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest"
import {
  keyScrollsConversation,
  shouldReleaseBottomLock,
  shouldReleaseBottomLockOnScroll,
  shouldResumeBottomLock,
  targetsConversationViewport,
  touchScrollsConversation,
} from "../src/lib/scrollIntent"

function element(parentElement: Element | null = null, options = {}) {
  const node: any = Object.assign(Object.create((globalThis as any).Element.prototype), {
    parentElement,
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    scrollWidth: 100,
    clientWidth: 100,
    style: { overflowY: "visible", overscrollBehaviorY: "auto" },
    contains: (candidate: unknown) => {
      let current = candidate as { parentElement?: Element | null } | null
      while (current) {
        if (current === (node as unknown)) return true
        current = current.parentElement ?? null
      }
      return false
    },
    ...options,
  })
  return node as unknown as HTMLElement
}

beforeEach(() => {
  vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style)
  // `keyScrollsConversation` checks `instanceof Element`; the node environment has
  // no DOM, so the fixtures stand in for elements.
  vi.stubGlobal("Element", class Element {})
})
afterEach(() => vi.unstubAllGlobals())
afterAll(() => vi.unstubAllGlobals())

test("layout clamping and the library's one-pixel correction keep bottom following", () => {
  expect(shouldReleaseBottomLockOnScroll(1000, 800, 800)).toBe(false)
  expect(shouldReleaseBottomLockOnScroll(1000, 799, 800)).toBe(false)
  expect(shouldReleaseBottomLockOnScroll(800, 799, 800)).toBe(false)
  expect(shouldReleaseBottomLockOnScroll(800, 0, 0)).toBe(false)
  expect(shouldReleaseBottomLockOnScroll(800, 0, -100)).toBe(false)
})

test("upward scrolling away from the bottom releases following", () => {
  expect(shouldReleaseBottomLockOnScroll(1000, 950, 1000)).toBe(true)
  expect(shouldReleaseBottomLockOnScroll(800, 700, 1000)).toBe(true)
  expect(shouldReleaseBottomLockOnScroll(800, 800, 1000)).toBe(false)
  expect(shouldReleaseBottomLockOnScroll(800, 900, 1000)).toBe(false)
})

test("only a downward user scroll to the bottom resumes following", () => {
  // Resizing can leave a reader at the bottom without downward movement;
  // stationary and upward events must not resume following.
  expect(shouldResumeBottomLock(900, 1000, 1000, false)).toBe(false)
  expect(shouldResumeBottomLock(1000, 1000, 1000, true)).toBe(false)
  expect(shouldResumeBottomLock(1000, 900, 1000, true)).toBe(false)
  expect(shouldResumeBottomLock(900, 950, 1000, true)).toBe(false)
  expect(shouldResumeBottomLock(900, 1000, 1000, true)).toBe(true)
  expect(shouldResumeBottomLock(900, 999, 1000, true)).toBe(true)
})

test("upward wheels release a viewport with different overflow values on each axis", () => {
  const viewport = element(null, {
    scrollTop: 900,
    scrollHeight: 1000,
    style: { overflow: "hidden scroll", overflowY: "scroll" },
  })
  expect(shouldReleaseBottomLock(viewport, element(viewport), -10000)).toBe(true)
  expect(shouldReleaseBottomLock(viewport, viewport, -100)).toBe(true)
  expect(shouldReleaseBottomLock(viewport, viewport, 100)).toBe(false)
  expect(shouldReleaseBottomLock(viewport, viewport, 0)).toBe(false)
})

test("nested vertical scrolling keeps the conversation pinned until its top is reached", () => {
  const viewport = element(null, { scrollHeight: 1000 })
  const nested = element(viewport, {
    scrollTop: 50,
    scrollHeight: 300,
    style: { overflowY: "auto", overscrollBehaviorY: "auto" },
  })
  const target = element(nested)
  expect(shouldReleaseBottomLock(viewport, target, -100)).toBe(false)
  nested.scrollTop = 0
  expect(shouldReleaseBottomLock(viewport, target, -100)).toBe(true)
  nested.style.overscrollBehaviorY = "contain"
  expect(shouldReleaseBottomLock(viewport, target, -100)).toBe(false)
  nested.style.overscrollBehaviorY = "none"
  expect(shouldReleaseBottomLock(viewport, target, -100)).toBe(false)
})

test("horizontal and non-overflowing nested containers allow conversation scrolling", () => {
  const viewport = element(null, { scrollHeight: 1000 })
  const nested = element(viewport, {
    style: { overflowX: "auto", overflowY: "auto", overscrollBehaviorY: "auto" },
  })
  expect(shouldReleaseBottomLock(viewport, element(nested), -100)).toBe(true)
})

test("non-scrollable viewports and targets outside the conversation keep their lock", () => {
  const viewport = element()
  expect(shouldReleaseBottomLock(viewport, viewport, -100)).toBe(false)
  viewport.scrollHeight = 1000
  expect(shouldReleaseBottomLock(viewport, element(), -100)).toBe(false)
  expect(shouldReleaseBottomLock(viewport, null, -100)).toBe(false)
})

test("a wheel over the conversation's own scrollbar targets the viewport", () => {
  const viewport = element(null, { scrollHeight: 1000 })
  const root = element(null, {})
  ;(viewport as unknown as { parentElement: Element | null }).parentElement = root
  const scrollbar = element(root, {})
  scrollbar.closest = (selector: string) =>
    selector.includes("scroll-area-scrollbar") ? (scrollbar as unknown as Element) : null
  const thumb = element(scrollbar, {})
  thumb.closest = (selector: string) =>
    selector.includes("scroll-area-scrollbar") ? (scrollbar as unknown as Element) : null
  // Reka's scrollbar is the viewport's sibling, not a descendant: its wheel must
  // still count, while a scrollbar belonging to another ScrollArea must not.
  expect(targetsConversationViewport(viewport, thumb)).toBe(true)
  const otherRoot = element(null, {})
  const otherScrollbar = element(otherRoot, {})
  const otherThumb = element(otherScrollbar, {})
  otherThumb.closest = (selector: string) =>
    selector.includes("scroll-area-scrollbar") ? (otherScrollbar as unknown as Element) : null
  expect(targetsConversationViewport(viewport, otherThumb)).toBe(false)
  // Nested scrollbars inside the viewport are not the conversation's own rail.
  const nestedBar = element(viewport, {})
  expect(shouldReleaseBottomLock(viewport, element(nestedBar), -100)).toBe(true)
})

test("a scrolling key is only the reader's when it scrolls the conversation", () => {
  const viewport = element(null, { scrollHeight: 1000 })
  const key = (target: unknown, name: string) => ({ key: name, target, defaultPrevented: false }) as KeyboardEvent
  // Focus inside the conversation but not on a nested scroller: the key scrolls it.
  expect(keyScrollsConversation(viewport, key(element(viewport), "ArrowDown"))).toBe(true)
  expect(keyScrollsConversation(viewport, key(viewport, "PageUp"))).toBe(true)
  // Space activates the focused control instead of scrolling.
  expect(keyScrollsConversation(viewport, key(viewport, " "))).toBe(false)
  // A nested independently scrollable region consumes the key (TZD-135 review):
  // its own movement must not be read as the reader taking over the conversation.
  const nested = element(viewport, {
    scrollTop: 0,
    scrollHeight: 300,
    style: { overflowY: "auto", overscrollBehaviorY: "auto" },
  })
  expect(keyScrollsConversation(viewport, key(element(nested), "ArrowDown"))).toBe(false)
  expect(keyScrollsConversation(viewport, key(element(nested), "ArrowUp"))).toBe(true)
  nested.scrollTop = 200
  expect(keyScrollsConversation(viewport, key(element(nested), "ArrowDown"))).toBe(true)
  nested.style.overscrollBehaviorY = "contain"
  expect(keyScrollsConversation(viewport, key(element(nested), "ArrowDown"))).toBe(false)
  // A modified or already handled key is never the reader.
  expect(keyScrollsConversation(viewport, { key: "ArrowDown", target: viewport, ctrlKey: true } as KeyboardEvent)).toBe(
    false,
  )
  expect(
    keyScrollsConversation(viewport, { key: "ArrowDown", target: viewport, defaultPrevented: true } as KeyboardEvent),
  ).toBe(false)
})

test("a touch only scrolls the conversation when no nested scroller can move", () => {
  const viewport = element(null, { scrollHeight: 1000, clientHeight: 400 })
  // Directly on the conversation: the gesture belongs to it.
  expect(touchScrollsConversation(viewport, element(viewport))).toBe(true)
  // A nested independently scrollable block pans itself, not the conversation.
  const nested = element(viewport, {
    scrollHeight: 600,
    clientHeight: 200,
    style: { overflowY: "auto", overscrollBehaviorY: "auto" },
  })
  expect(touchScrollsConversation(viewport, element(nested))).toBe(false)
  // A horizontally scrollable strip consumes a diagonal swipe the same way.
  const strip = element(viewport, {
    scrollWidth: 600,
    clientWidth: 200,
    style: { overflowX: "auto", overflowY: "hidden" },
  })
  expect(touchScrollsConversation(viewport, element(strip))).toBe(false)
  // A non-scrolling wrapper in between stays transparent.
  const wrapper = element(viewport, { scrollHeight: 120, clientHeight: 120 })
  expect(touchScrollsConversation(viewport, element(wrapper))).toBe(true)
  // Targets outside the conversation never claim it.
  expect(touchScrollsConversation(viewport, element())).toBe(false)
  expect(touchScrollsConversation(viewport, null)).toBe(false)
})
