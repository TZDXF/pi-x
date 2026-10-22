import { afterEach, expect, test, vi } from "vitest"
import { boundaryRect } from "@/lib/selectionAnchors"

afterEach(() => vi.unstubAllGlobals())

function setup(texts: string[], characterRects: DOMRect[], caretRects: DOMRect[]) {
  const nodes = texts.map(data => ({ data }))
  const range = {
    setStart: vi.fn(),
    setEnd: vi.fn(),
    collapse: vi.fn(),
    getClientRects: () => (range.collapse.mock.calls.length ? caretRects : characterRects),
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
  }
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 })
  vi.stubGlobal("document", {
    createRange: () => range,
    createTreeWalker: () => {
      let index = 0
      return { nextNode: () => nodes[index++] ?? null }
    },
  })
  return { root: {} as Element, range, nodes }
}

const lineEnd = { left: 190, right: 200, top: 20, bottom: 40, width: 10, height: 20 } as DOMRect
const nextLine = { left: 0, right: 0, top: 40, bottom: 60, width: 0, height: 20 } as DOMRect

test("line-end annotation stays on the selected character instead of the next-line caret", () => {
  const { root, range, nodes } = setup(["abcd"], [lineEnd, nextLine], [nextLine])
  expect(boundaryRect(root, 3)).toBe(lineEnd)
  expect(range.setStart).toHaveBeenCalledWith(nodes[0], 2)
  expect(range.setEnd).toHaveBeenCalledWith(nodes[0], 3)
  expect(range.collapse).not.toHaveBeenCalled()
})

test("annotation at an inline text-node boundary uses the preceding character", () => {
  const { root, range, nodes } = setup(["ab", "cd"], [lineEnd], [nextLine])
  expect(boundaryRect(root, 2)).toBe(lineEnd)
  expect(range.setStart).toHaveBeenCalledWith(nodes[0], 1)
  expect(range.setEnd).toHaveBeenCalledWith(nodes[0], 2)
})

test("offset zero falls back to the caret without a negative character offset", () => {
  const { root, range, nodes } = setup(["ab"], [], [nextLine])
  expect(boundaryRect(root, 0)).toBe(nextLine)
  expect(range.setStart).toHaveBeenCalledWith(nodes[0], 0)
  expect(range.setEnd).not.toHaveBeenCalled()
})

test("characters without geometry fall back to the caret", () => {
  const { root, range } = setup(["ab"], [], [nextLine])
  expect(boundaryRect(root, 2)).toBe(nextLine)
  expect(range.collapse).toHaveBeenCalledWith(true)
})

test("empty content without geometry has no annotation anchor", () => {
  const { root } = setup([], [], [])
  expect(boundaryRect(root, 0)).toBeNull()
})
