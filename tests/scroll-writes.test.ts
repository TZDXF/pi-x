import { expect, test } from "vitest"
import {
  beginScrollDrag,
  clearScrollWrites,
  consumeScrollWrite,
  endScrollDrag,
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
  return new FakeViewport() as unknown as HTMLElement & { scrollHeight: number; clientHeight: number }
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

test("a scrollbar drag belongs to the reader, not the app", () => {
  const element = viewport()
  observeScrollWrites(element)
  beginScrollDrag(element)
  element.scrollTop = 120
  element.scrollTop = 300
  endScrollDrag(element)
  expect(consumeScrollWrite(element, 120)).toBe(false)
  expect(consumeScrollWrite(element, 300)).toBe(false)
  // After the drag the app's writes are recorded again.
  element.scrollTop = 500
  expect(consumeScrollWrite(element, 500)).toBe(true)
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
