import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"
const { clampReviewWidth } = loadTsSource(readFileSync(new URL("../src/lib/reviewWidth.ts", import.meta.url), "utf8"))
test("review resize keeps chat space and clamps both bounds", () => {
  assert.equal(clampReviewWidth(100, 1200, false), 280)
  assert.equal(clampReviewWidth(1000, 1200, false), 840)
  assert.equal(clampReviewWidth(500, 1200, false), 500)
  assert.equal(clampReviewWidth(2000, 2000, false), 900)
})
test("review resize fits small containers and overlay mode", () => {
  assert.equal(clampReviewWidth(420, 600, false), 240)
  assert.equal(clampReviewWidth(420, 320, true), 320)
  assert.equal(clampReviewWidth(100, 200, true), 200)
  assert.equal(clampReviewWidth(420, 0, false), 0)
  assert.equal(clampReviewWidth(NaN, 1200, false), 420)
})
