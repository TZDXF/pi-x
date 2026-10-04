import { test, expect } from "vitest"
import { computeBottomNotch, resolveDropZone } from "@/lib/splitDropZone"

const rect: DOMRect = {
  x: 100,
  y: 50,
  width: 200,
  height: 100,
  top: 50,
  right: 300,
  bottom: 150,
  left: 100,
  toJSON: () => ({}),
}

test("drop zones resolve to the nearest qualifying edge", () => {
  expect(resolveDropZone(110, 100, rect)).toBe("left")
  expect(resolveDropZone(290, 100, rect)).toBe("right")
  expect(resolveDropZone(200, 60, rect)).toBe("top")
  expect(resolveDropZone(200, 140, rect)).toBe("bottom")
})

test("drop zones retain center behavior and honour the threshold boundary", () => {
  expect(resolveDropZone(200, 100, rect)).toBe("center")
  expect(resolveDropZone(115, 100, rect)).toBe("left")
  expect(resolveDropZone(136, 100, rect)).toBe("left")
  expect(resolveDropZone(200, 68, rect, 0.18)).toBe("top")
  expect(resolveDropZone(200, 69, rect, 0.1)).toBe("center")
})

const composer: DOMRect = {
  x: 150,
  y: 110,
  width: 100,
  height: 40,
  top: 110,
  right: 250,
  bottom: 150,
  left: 150,
  toJSON: () => ({}),
}

test("excluded rect always resolves to center even inside an edge band", () => {
  // Composer sits inside the bottom band; the pointer over it must stay center.
  expect(resolveDropZone(200, 140, rect, 0.18, composer)).toBe("center")
  expect(resolveDropZone(160, 120, rect, 0.18, composer)).toBe("center")
  // Outside the exclusion the bottom band still splits.
  expect(resolveDropZone(130, 140, rect, 0.18, composer)).toBe("bottom")
  expect(resolveDropZone(200, 140, rect, 0.18, null)).toBe("bottom")
})

test("empty excluded rect is ignored", () => {
  const empty: DOMRect = { ...composer, width: 0, height: 0 }
  expect(resolveDropZone(130, 140, rect, 0.18, empty)).toBe("bottom")
})

const pane: DOMRect = {
  x: 0,
  y: 0,
  width: 800,
  height: 1000,
  top: 0,
  right: 800,
  bottom: 1000,
  left: 0,
  toJSON: () => ({}),
}

test("bottom notch cuts a closed hole around the input area", () => {
  // Input text area occupies the upper part of the bottom band.
  const input: DOMRect = {
    x: 100,
    y: 800,
    width: 600,
    height: 120,
    top: 800,
    right: 700,
    bottom: 920,
    left: 100,
    toJSON: () => ({}),
  }
  expect(computeBottomNotch(pane, input)).toEqual({
    bandTop: 750,
    holeLeft: 92,
    holeRight: 708,
    holeTop: 792,
    holeBottom: 928,
  })
})

test("bottom notch clamps to the pane and the band", () => {
  const input: DOMRect = {
    x: 100,
    y: 800,
    width: 600,
    height: 120,
    top: 800,
    right: 700,
    bottom: 920,
    left: 100,
    toJSON: () => ({}),
  }
  // Input reaching the pane bottom keeps the hole inside the pane.
  const touching: DOMRect = { ...input, bottom: 1000, height: 200 }
  expect(computeBottomNotch(pane, touching)?.holeBottom).toBe(1000)
  // Input whose top is above the band clamps the hole to the band top.
  const tall: DOMRect = { ...input, top: 700, bottom: 820, height: 120 }
  expect(computeBottomNotch(pane, tall)?.holeTop).toBe(750)
  // Custom gap widens the hole.
  expect(computeBottomNotch(pane, input, 0)).toEqual({
    bandTop: 750,
    holeLeft: 100,
    holeRight: 700,
    holeTop: 800,
    holeBottom: 920,
  })
})

test("bottom notch returns null without a usable input rect", () => {
  expect(computeBottomNotch(pane, null)).toBeNull()
  const empty: DOMRect = { ...pane, width: 0, height: 0 }
  expect(computeBottomNotch(pane, empty)).toBeNull()
  // Rect entirely above the band cuts nothing.
  const above: DOMRect = {
    x: 100,
    y: 600,
    width: 600,
    height: 100,
    top: 600,
    right: 700,
    bottom: 700,
    left: 100,
    toJSON: () => ({}),
  }
  expect(computeBottomNotch(pane, above)).toBeNull()
})
