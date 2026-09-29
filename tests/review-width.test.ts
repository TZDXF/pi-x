import { test, expect } from "vitest"
import { clampReviewWidth } from "@/lib/reviewWidth"
test("review resize keeps chat space and clamps both bounds", () => {
  expect(clampReviewWidth(100, 1200, false)).toBe(280)
  expect(clampReviewWidth(1000, 1200, false)).toBe(840)
  expect(clampReviewWidth(500, 1200, false)).toBe(500)
  expect(clampReviewWidth(2000, 2000, false)).toBe(900)
})
test("review resize fits small containers and overlay mode", () => {
  expect(clampReviewWidth(420, 600, false)).toBe(240)
  expect(clampReviewWidth(420, 320, true)).toBe(320)
  expect(clampReviewWidth(100, 200, true)).toBe(200)
  expect(clampReviewWidth(420, 0, false)).toBe(0)
  expect(clampReviewWidth(NaN, 1200, false)).toBe(420)
})
