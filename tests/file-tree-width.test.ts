import { expect, test } from "vitest"
import {
  clampFileTreeWidth,
  fileTreeWidthBounds,
  FILE_TREE_DEFAULT_WIDTH,
  FILE_TREE_MIN_WIDTH,
  FILE_TREE_HANDLE_WIDTH,
  FILE_PREVIEW_MIN_WIDTH,
} from "@/lib/fileTreeWidth"

test("file tree width keeps the preview area usable", () => {
  expect(clampFileTreeWidth(100, 800)).toBe(FILE_TREE_MIN_WIDTH)
  expect(clampFileTreeWidth(240, 800)).toBe(240)
  expect(clampFileTreeWidth(900, 800)).toBe(800 - FILE_PREVIEW_MIN_WIDTH - FILE_TREE_HANDLE_WIDTH)
  expect(fileTreeWidthBounds(800)).toEqual({ min: FILE_TREE_MIN_WIDTH, max: 800 - 280 - 7 })
})

test("widest tree still leaves the preview its full minimum width", () => {
  // 回归 L4：此前边界未扣掉 7px 拖拽条，树拖到最大时内容区只剩 273px。
  const container = 1100
  const tree = clampFileTreeWidth(container, container)
  expect(container - tree - FILE_TREE_HANDLE_WIDTH).toBe(FILE_PREVIEW_MIN_WIDTH)
})

test("file tree width shrinks with narrow panels instead of overflowing", () => {
  expect(fileTreeWidthBounds(400)).toEqual({ min: 113, max: 113 })
  expect(clampFileTreeWidth(300, 400)).toBe(113)
  expect(clampFileTreeWidth(300, 0)).toBe(0)
  expect(clampFileTreeWidth(NaN, 800)).toBe(FILE_TREE_DEFAULT_WIDTH)
})
