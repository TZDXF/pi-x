import { expect, test } from "vitest"
import { isTopmostDialogLayer } from "@/lib/dialogLayers"

function harness() {
  const layers: HTMLElement[] = []
  const document = {
    querySelectorAll: () => layers,
    defaultView: { getComputedStyle: (element: HTMLElement) => element.style },
  }
  function layer(state = "open", visible = true, pointerEvents = "auto") {
    const element = {
      ownerDocument: document,
      dataset: { state },
      style: { pointerEvents },
      matches: () => true,
      getClientRects: () => (visible ? [{}] : []),
    } as unknown as HTMLElement
    layers.push(element)
    return element
  }
  return { layer, layers, document }
}

test("only the topmost dialog can be dismissed by its overlay", () => {
  const h = harness()
  const parent = h.layer()
  expect(isTopmostDialogLayer(parent)).toBe(true)
  const child = h.layer()
  expect(isTopmostDialogLayer(parent)).toBe(false)
  expect(isTopmostDialogLayer(child)).toBe(true)
})

test("a non-modal popup above the dialog consumes the first outside click", () => {
  const h = harness()
  const dialog = h.layer()
  h.layer()
  expect(isTopmostDialogLayer(dialog)).toBe(false)
  h.layers.pop()
  expect(isTopmostDialogLayer(dialog)).toBe(true)
})

test("a modal popup keeps the overlay guarded until pointer events are restored", () => {
  const h = harness()
  const dialog = h.layer("open", true, "none")
  h.layer("closed")
  expect(isTopmostDialogLayer(dialog)).toBe(false)
  dialog.style.pointerEvents = "auto"
  expect(isTopmostDialogLayer(dialog)).toBe(true)
})

test("closed and hidden force-mounted layers do not block an active dialog", () => {
  const h = harness()
  const dialog = h.layer()
  h.layer("closed")
  h.layer("open", false)
  expect(isTopmostDialogLayer(dialog)).toBe(true)
})

test("a content wrapper resolves its own dismissable layer", () => {
  const h = harness()
  const dialog = h.layer()
  const wrapper = {
    ownerDocument: h.document,
    matches: () => false,
    querySelector: () => dialog,
  } as unknown as HTMLElement
  expect(isTopmostDialogLayer(wrapper)).toBe(true)
  h.layer()
  expect(isTopmostDialogLayer(wrapper)).toBe(false)
})

test("missing or inactive dialog content cannot dismiss", () => {
  expect(isTopmostDialogLayer(undefined)).toBe(false)
  const h = harness()
  expect(isTopmostDialogLayer(h.layer("closed"))).toBe(false)
  expect(isTopmostDialogLayer(h.layer("open", false))).toBe(false)
  const missing = {
    matches: () => false,
    querySelector: () => null,
  } as unknown as HTMLElement
  expect(isTopmostDialogLayer(missing)).toBe(false)
})
