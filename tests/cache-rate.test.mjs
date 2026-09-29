import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const { averageCacheRate } = loadTsSource(readFileSync(new URL("../src/lib/cacheRate.ts", import.meta.url), "utf8"))

test("average cache rate is weighted by session input tokens, including cache writes", () => {
  expect(averageCacheRate({ input: 20, cacheRead: 70, cacheWrite: 10, output: 900 })).toBe(0.7)
  expect(averageCacheRate({ input: 0, cacheRead: 100, cacheWrite: 0 })).toBe(1)
  expect(averageCacheRate({ input: 100, cacheRead: 0, cacheWrite: 0 })).toBe(0)
})

test("average cache rate is unavailable without input usage", () => {
  expect(averageCacheRate(null)).toBe(null)
  expect(averageCacheRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBe(null)
})
