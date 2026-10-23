import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { shouldReleaseBottomLock } from "../src/lib/scrollIntent"

function element(parentElement: Element | null = null, options = {}) {
  return {
    parentElement,
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    style: { overflowY: "visible", overscrollBehaviorY: "auto" },
    ...options,
  } as unknown as HTMLElement
}

beforeEach(() => {
  vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style)
})
afterEach(() => vi.unstubAllGlobals())

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
