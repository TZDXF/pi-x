import { test, expect } from "vitest"
import { resolveDropZone } from "@/lib/splitDropZone"

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
