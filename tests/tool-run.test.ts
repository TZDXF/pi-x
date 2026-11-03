import { expect, test } from "vitest"
import { toolDuration, toolInput } from "@/lib/toolRun"
import type { ToolRun } from "@/stores/session/types"

const run: ToolRun = { id: "c", name: "read", argsText: "", outputText: "", state: "output-available" }

test("execution snapshots replace partial arguments without client-side validation", () => {
  const block = { type: "toolCall" as const, callId: "c", name: "read", argsText: '{"limit":"3","paths":"a"}' }
  expect(toolInput(block)).toBe(block.argsText)
  expect(toolInput(block, { ...run, argsText: '{"limit":3,"paths":["a"]}' })).toBe('{"limit":3,"paths":["a"]}')
  expect(toolInput(block, run)).toBe(block.argsText)
})

test("durations prefer recorded execution time over wall clock and survive history", () => {
  expect(toolDuration({ ...run, durationMs: 1200 }, 999999)).toBe(1200)
  expect(toolDuration({ ...run, durationMs: 0 }, 999999)).toBe(0)
  expect(toolDuration({ ...run, startedAt: 100, completedAt: 300, durationMs: 50 }, 999999)).toBe(50)
  expect(toolDuration({ ...run, startedAt: 100, completedAt: 300 }, 999999)).toBe(200)
  expect(toolDuration({ ...run, startedAt: 100 }, 500)).toBe(400)
  expect(toolDuration(run, 500)).toBeNull()
  expect(toolDuration(undefined, 500)).toBeNull()
  expect(toolDuration({ ...run, durationMs: NaN }, 500)).toBeNull()
})
