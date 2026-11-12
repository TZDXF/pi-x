import { expect, test } from "vitest"
import {
  clampFileTreeWidth,
  fileTreeWidthBounds,
  FILE_TREE_DEFAULT_WIDTH,
  FILE_TREE_MIN_WIDTH,
} from "@/lib/fileTreeWidth"

test("file tree width keeps the preview area usable", () => {
  expect(clampFileTreeWidth(100, 800)).toBe(FILE_TREE_MIN_WIDTH)
  expect(clampFileTreeWidth(240, 800)).toBe(240)
  expect(clampFileTreeWidth(900, 800)).toBe(800 - 280)
  expect(fileTreeWidthBounds(800)).toEqual({ min: FILE_TREE_MIN_WIDTH, max: 520 })
})

test("file tree width shrinks with narrow panels instead of overflowing", () => {
  expect(fileTreeWidthBounds(400)).toEqual({ min: 120, max: 120 })
  expect(clampFileTreeWidth(300, 400)).toBe(120)
  expect(clampFileTreeWidth(300, 0)).toBe(0)
  expect(clampFileTreeWidth(NaN, 800)).toBe(FILE_TREE_DEFAULT_WIDTH)
})
