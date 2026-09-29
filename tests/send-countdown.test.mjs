import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const { sendCountdown } = loadTsSource(readFileSync(new URL("../src/lib/sendCountdown.ts", import.meta.url), "utf8"))

test("countdown displays padded minutes and seconds, retaining total minutes for hours", () => {
  expect(sendCountdown(5000, 0)).toBe("00:05")
  expect(sendCountdown(65000, 0)).toBe("01:05")
  expect(sendCountdown(3600000, 0)).toBe("60:00")
  expect(sendCountdown(7201000, 0)).toBe("120:01")
})

test("countdown rounds up and clamps due or overdue messages to zero", () => {
  expect(sendCountdown(1001, 1000)).toBe("00:01")
  expect(sendCountdown(1000, 1000)).toBe("00:00")
  expect(sendCountdown(1000, 9000)).toBe("00:00")
})

test("countdown catches up after sleep rather than counting timer ticks", () => {
  expect(sendCountdown(120000, 0)).toBe("02:00")
  expect(sendCountdown(120000, 90000)).toBe("00:30")
})
