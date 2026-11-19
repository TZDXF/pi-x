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

/** Wait for the browser task that opened the input exemption to finish. */
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0))

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

test("writes performed by the reader's own dispatch are not recorded", async () => {
  const element = viewport()
  observeScrollWrites(element)
  beginUserInput(element)
  expect(isInputDispatch(element)).toBe(true)
  // Reka's scrollbar positions the thumb by assigning scrollTop inside the
  // document-level wheel/pointermove dispatch.
  element.scrollTop = 120
  element.scrollTop = 600
  expect(consumeScrollWrite(element, 120)).toBe(false)
  expect(consumeScrollWrite(element, 600)).toBe(false)
  await nextTask()
  expect(isInputDispatch(element)).toBe(false)
  // The exemption ends with the dispatch: a later layout write is the app's.
  element.scrollTop = 500
  expect(consumeScrollWrite(element, 500)).toBe(true)
})

test("a same-frame write that merely follows the input stays the app's", async () => {
  const element = viewport()
  observeScrollWrites(element)
  beginUserInput(element)
  await nextTask()
  // The keystroke itself did not scroll; the virtual-row compensation that
  // followed in the next task must still be attributed to the app.
  expect(isInputDispatch(element)).toBe(false)
  element.scrollTop = 600
  expect(consumeScrollWrite(element, 600)).toBe(true)
})

test("a reader input closes an app-initiated scroll", () => {
  const element = viewport()
  beginAppScroll(element, 600)
  expect(hasAppScroll(element)).toBe(true)
  expect(isAppScrolling(element, 300)).toBe(true)
  beginUserInput(element)
  finishAppScroll(element)
  expect(hasAppScroll(element)).toBe(false)
  endUserInput(element)
})

test("an app-initiated scroll owns its events until the requested position arrives", () => {
  const element = viewport()
  beginAppScroll(element, 600)
  // Intermediate frames of a smooth scroll are the app's, however late they are.
  for (const at of [100, 250, 420, 580]) expect(isAppScrolling(element, at)).toBe(true)
  // The arrival is attributed too, then the viewport is handed back to the reader.
  expect(isAppScrolling(element, 600)).toBe(true)
  expect(hasAppScroll(element)).toBe(false)
  expect(isAppScrolling(element, 600)).toBe(false)
})

test("a busy frame does not expire the app attribution", () => {
  const element = viewport()
  beginAppScroll(element, 600)
  // No time-based release exists: a frame delayed by hundreds of milliseconds
  // still reports its first scroll as the app's.
  expect(isAppScrolling(element, 197)).toBe(true)
})

test("scrollend or a reader takeover finishes an app scroll without a target", () => {
  const element = viewport()
  // `scrollIntoView` has no known endpoint: it ends on scrollend or takeover.
  beginAppScroll(element, null)
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
