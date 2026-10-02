import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

const blocks = readFileSync(new URL("../src/components/AssistantBlocks.vue", import.meta.url), "utf8")

test("shell tool output has no nested terminal chrome and reveals a copy action on hover", () => {
  expect(blocks).toMatch(
    /<Terminal[\s\S]*?class="group\/terminal-output relative rounded-none border-0 bg-transparent text-xs"[\s\S]*?<TerminalContent[\s\S]*?<TerminalCopyButton/,
  )
  expect(blocks).toMatch(/group-hover\/terminal-output:opacity-100 focus-visible:opacity-100/)
  expect(blocks).toMatch(/:aria-label="t\('blocks\.copyTerminal'\)"/)
  expect(blocks).toMatch(/:output="terminalText\(block\)"/)
})

test("tool runs surface elapsed time, highlighted for long-running commands", () => {
  // pi's bash tool has no default timeout; a stuck command must be visible.
  expect(blocks).toMatch(/startedAt/)
  expect(blocks).toMatch(/elapsedText\(block\)/)
  expect(blocks).toMatch(/text-amber-600 dark:text-amber-400/)
  expect(blocks).toMatch(/ms > 120_000\?[\s\S]*?text-destructive|text-destructive/)
  // The timer lives in the reserved header slot so appearing/disappearing
  // cannot change the height of a short-running bash tool.
  const bashHeader = blocks.match(
    /<Tool v-else-if="block\.type === 'toolCall' && isBash\(block\)"[\s\S]*?<ToolContent>/,
  )
  expect(bashHeader).toBeTruthy()
  expect(bashHeader[0]).toMatch(/<template #meta>/)
  expect(bashHeader[0]).toMatch(/w-12 text-right text-xs tabular-nums/)
  expect(bashHeader[0]).not.toMatch(/flex items-center justify-end gap-1 px-3 pb-1\.5/)
  expect(blocks).toMatch(/ms == null \|\| ms < 1_000 \? "" : formatToolElapsed\(ms\)/)
  // tool-run lifecycle lives in the store's event-ingestion submodule.
  const store = readFileSync(new URL("../src/stores/session/events.ts", import.meta.url), "utf8")
  expect(store).toMatch(/tool_execution_start[\s\S]*?startedAt: Date\.now\(\)/)
  expect(store).toMatch(/tool_execution_end[\s\S]*?completedAt = Date\.now\(\)/)
})
