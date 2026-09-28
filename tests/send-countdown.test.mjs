import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const { sendCountdown } = loadTsSource(readFileSync(new URL("../src/lib/sendCountdown.ts", import.meta.url), "utf8"))

test("countdown displays padded minutes and seconds, retaining total minutes for hours", () => {
  assert.equal(sendCountdown(5000, 0), "00:05")
  assert.equal(sendCountdown(65000, 0), "01:05")
  assert.equal(sendCountdown(3600000, 0), "60:00")
  assert.equal(sendCountdown(7201000, 0), "120:01")
})

test("countdown rounds up and clamps due or overdue messages to zero", () => {
  assert.equal(sendCountdown(1001, 1000), "00:01")
  assert.equal(sendCountdown(1000, 1000), "00:00")
  assert.equal(sendCountdown(1000, 9000), "00:00")
})

test("countdown catches up after sleep rather than counting timer ticks", () => {
  assert.equal(sendCountdown(120000, 0), "02:00")
  assert.equal(sendCountdown(120000, 90000), "00:30")
})
