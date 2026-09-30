import { expect, test } from "vitest"
import { nextMcpRowId } from "@/components/settings/mcp/rowIds"

test("mcp row ids are unique and strictly increasing across calls", () => {
  const ids = Array.from({ length: 100 }, () => nextMcpRowId())
  expect(new Set(ids).size).toBe(ids.length)
  for (let i = 1; i < ids.length; i++) {
    expect(ids[i]).toBeGreaterThan(ids[i - 1])
  }
})
