import { expect, test } from "vitest"
import {
  beginAppScroll,
  beginUserInput,
  consumeScrollWrite,
  clearScrollWrites,
  endAppScroll,
  endUserInput,
  isAppScrolling,
  isUserInputActive,
  observeScrollWrites,
  recordScrollWrite,
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

test("a real gesture clears pending records", () => {
  const element = viewport()
  observeScrollWrites(element)
  element.scrollTop = 400
  clearScrollWrites(element)
  expect(consumeScrollWrite(element, 400)).toBe(false)
})

test("writes dispatched by the reader's own input are not recorded", () => {
  const element = viewport()
  observeScrollWrites(element)
  beginUserInput(element)
  expect(isUserInputActive(element)).toBe(true)
  // Reka's scrollbar positions the thumb by assigning scrollTop on pointer move.
  element.scrollTop = 120
  element.scrollTop = 600
  endUserInput(element)
  expect(isUserInputActive(element)).toBe(false)
  expect(consumeScrollWrite(element, 120)).toBe(false)
  expect(consumeScrollWrite(element, 600)).toBe(false)
  // After the window closes the app's writes are recorded again.
  element.scrollTop = 500
  expect(consumeScrollWrite(element, 500)).toBe(true)
})

test("the reader's window expires, so a compensation write while the thumb is still is the app's", () => {
  const element = viewport()
  observeScrollWrites(element)
  beginUserInput(element)
  // The window only covers the input dispatch; a later layout-driven write
  // (the thumb being held still) must be attributed to the app.
  const later = Date.now() + 5_000
  element.scrollTop = 600
  const settled = (element as unknown as { scrollTop: number }).scrollTop
  recordScrollWrite(element, settled, later)
  expect(consumeScrollWrite(element, settled, later)).toBe(true)
})

test("an app-initiated scroll owns its events until the movement settles", () => {
  const element = viewport()
  beginAppScroll(element)
  expect(isAppScrolling(element)).toBe(true)
  // Every event refreshes the quiet period; the last one may clamp onto the
  // bottom, which must still belong to the app.
  expect(isAppScrolling(element, Date.now() + 100)).toBe(true)
  expect(isAppScrolling(element, Date.now() + 5_000)).toBe(false)
  endAppScroll(element)
  expect(isAppScrolling(element)).toBe(false)
})

test("a reader input outranks a pending app-initiated scroll", () => {
  const element = viewport()
  beginAppScroll(element)
  beginUserInput(element)
  expect(isAppScrolling(element)).toBe(false)
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
