import { expect, test } from "vitest"
import {
  beginAppScroll,
  beginUserInput,
  consumeScrollWrite,
  clearScrollWrites,
  endUserInput,
  finishAppScroll,
  hasAppScroll,
  isAppScrolling,
  isInputDispatch,
  observeScrollWrites,
} from "../src/lib/scrollWrites"

/** Emulates an element whose `scrollTop` accessor lives on the prototype. */
class FakeViewport {
  #scrollTop = 0
  scrollHeight = 1000
  clientHeight = 400
  get scrollTop() {
    return this.#scrollTop
  }
  set scrollTop(value: number) {
    // A real viewport clamps to the scrollable range.
    this.#scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
  }
}

function viewport() {
  return new FakeViewport() as unknown as HTMLElement
}

test("a recorded write is consumed by the scroll event it causes", () => {
  const element = viewport()
  observeScrollWrites(element)
  element.scrollTop = 500
  // Clamps to 600, so the record must hold the settled value.
  element.scrollTop = 5000
  expect(consumeScrollWrite(element, 5000)).toBe(false)
  expect(consumeScrollWrite(element, 600)).toBe(true)
  expect(consumeScrollWrite(element, 500)).toBe(true)
  expect(consumeScrollWrite(element, 500)).toBe(false)
})

test("sub-pixel layout rounding still matches a recorded write", () => {
  const element = viewport()
  observeScrollWrites(element)
  element.scrollTop = 400
  expect(consumeScrollWrite(element, 400.5)).toBe(true)
  expect(consumeScrollWrite(element, 401)).toBe(false)
})

test("records expire so a later reader drag to the same pixel counts as one", () => {
  const element = viewport()
  observeScrollWrites(element)
  element.scrollTop = 400
  expect(consumeScrollWrite(element, 400, Date.now() + 10_000)).toBe(false)
})

test("a fresh gesture clears pending records", () => {
  const element = viewport()
  observeScrollWrites(element)
  element.scrollTop = 400
  clearScrollWrites(element)
  expect(consumeScrollWrite(element, 400)).toBe(false)
})

test("writes performed inside the input dispatch are not recorded", () => {
  const element = viewport()
  observeScrollWrites(element)
  // The capture listener opens, the bubble listener closes: the exemption is
  // exactly one browser dispatch, which is when Reka writes the thumb position.
  beginUserInput(element)
  expect(isInputDispatch(element)).toBe(true)
  element.scrollTop = 120
  element.scrollTop = 600
  expect(consumeScrollWrite(element, 120)).toBe(false)
  expect(consumeScrollWrite(element, 600)).toBe(false)
  endUserInput(element)
  expect(isInputDispatch(element)).toBe(false)
  // After the dispatch the app's writes are recorded again.
  element.scrollTop = 500
  expect(consumeScrollWrite(element, 500)).toBe(true)
})

test("a write outside the dispatch stays the app's even in the same task chain", () => {
  const element = viewport()
  observeScrollWrites(element)
  // No timer closes the exemption: closing it is the bubble listener, so a
  // rendering-step write (ResizeObserver compensation) is recorded as the app's
  // however late the browser schedules that step.
  beginUserInput(element)
  endUserInput(element)
  element.scrollTop = 600
  expect(consumeScrollWrite(element, 600)).toBe(true)
})

test("nested opens and closes are counted", () => {
  const element = viewport()
  beginUserInput(element)
  beginUserInput(element)
  endUserInput(element)
  expect(isInputDispatch(element)).toBe(true)
  endUserInput(element)
  expect(isInputDispatch(element)).toBe(false)
})

test("a reader input closes an app-initiated scroll", () => {
  const element = viewport()
  element.scrollTop = 0
  expect(beginAppScroll(element, 600, 0)).toBe(true)
  expect(hasAppScroll(element)).toBe(true)
  expect(isAppScrolling(element, 300)).toBe(true)
  finishAppScroll(element)
  expect(hasAppScroll(element)).toBe(false)
})

test("a navigation already at its target leaves no mark behind", () => {
  const element = viewport()
  observeScrollWrites(element)
  element.scrollTop = 576
  // The browser fires neither `scroll` nor `scrollend` for a no-op request.
  expect(beginAppScroll(element, 576, 576)).toBe(false)
  expect(hasAppScroll(element)).toBe(false)
  expect(beginAppScroll(element, 577, 576)).toBe(false)
  expect(beginAppScroll(element, 578, 576)).toBe(true)
})

test("an app-initiated scroll owns its events until the requested position arrives", () => {
  const element = viewport()
  expect(beginAppScroll(element, 600, 0)).toBe(true)
  // Intermediate frames of a smooth scroll are the app's, however late they are.
  for (const at of [100, 250, 420, 580]) expect(isAppScrolling(element, at)).toBe(true)
  // The arrival is attributed too, then the viewport is handed back to the reader.
  expect(isAppScrolling(element, 600)).toBe(true)
  expect(hasAppScroll(element)).toBe(false)
  expect(isAppScrolling(element, 600)).toBe(false)
})

test("a busy frame does not expire the app attribution", () => {
  const element = viewport()
  expect(beginAppScroll(element, 600, 0)).toBe(true)
  // No time-based release exists: a frame delayed by hundreds of milliseconds
  // still reports its first scroll as the app's.
  expect(isAppScrolling(element, 197)).toBe(true)
})

test("scrollend or a reader takeover finishes an app scroll without a target", () => {
  const element = viewport()
  // `scrollIntoView` has no known endpoint: it ends on scrollend or takeover.
  expect(beginAppScroll(element, null, 0)).toBe(true)
  expect(isAppScrolling(element, 400)).toBe(true)
  expect(isAppScrolling(element, 400)).toBe(true)
  finishAppScroll(element)
  expect(isAppScrolling(element, 400)).toBe(false)
})

test("observing restores the original accessor", () => {
  const element = viewport()
  const stop = observeScrollWrites(element)
  element.scrollTop = 600
  expect(element.scrollTop).toBe(600)
  stop()
  expect(Object.getOwnPropertyDescriptor(element, "scrollTop")).toBeUndefined()
  expect(consumeScrollWrite(element, 600)).toBe(false)
})
