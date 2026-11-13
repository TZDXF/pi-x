import { test, expect } from "vitest"
import { clampReviewWidth, reviewWidthBounds } from "@/lib/reviewWidth"

test("review resize keeps chat space and clamps both bounds", () => {
  expect(clampReviewWidth(100, 1200, false)).toBe(280)
  expect(clampReviewWidth(1000, 1200, false)).toBe(960)
  expect(clampReviewWidth(500, 1200, false)).toBe(500)
})

test("review width may cover most of the window and only stops at the chat minimum", () => {
  // 此前固定 900px 上限导致面板拖不到一半以上；现在边界只由可用窗口空间决定。
  expect(clampReviewWidth(2000, 2000, false)).toBe(1760)
  expect(clampReviewWidth(1500, 1600, false)).toBe(1360)
  expect(reviewWidthBounds(1600, false)).toEqual({ min: 280, max: 1360 })
  expect(reviewWidthBounds(4000, false).max).toBe(3760)
})

test("review resize fits small containers and overlay mode", () => {
  expect(clampReviewWidth(420, 600, false)).toBe(360)
  expect(clampReviewWidth(420, 320, true)).toBe(320)
  expect(clampReviewWidth(100, 200, true)).toBe(200)
  expect(clampReviewWidth(420, 0, false)).toBe(0)
  expect(clampReviewWidth(NaN, 1200, false)).toBe(420)
})
