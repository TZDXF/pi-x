import { expect, test, vi } from "vitest"
import { ignoreInvalidKeyboardEvent } from "@/lib/keyboardEvents"

test.each(["keydown", "keyup"])("invalid %s events never reach downstream listeners", type => {
  const target = new EventTarget()
  const downstream = vi.fn()
  target.addEventListener(type, ignoreInvalidKeyboardEvent, true)
  target.addEventListener(type, downstream)

  for (const key of [undefined, null, "", 42, {}]) {
    const event = new Event(type, { cancelable: true })
    if (key !== undefined) Object.defineProperty(event, "key", { value: key })
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  }
  expect(downstream).not.toHaveBeenCalled()

  for (const key of ["k", "Shift", " ", "Process", "Unidentified"]) {
    const event = new Event(type, { cancelable: true })
    Object.defineProperty(event, "key", { value: key })
    target.dispatchEvent(event)
    expect(downstream).toHaveBeenLastCalledWith(event)
  }
  expect(downstream).toHaveBeenCalledTimes(5)
})
