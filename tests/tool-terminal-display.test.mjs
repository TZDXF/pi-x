import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const blocks = readFileSync(new URL("../src/components/AssistantBlocks.vue", import.meta.url), "utf8")

test("shell tool output has no nested terminal chrome and reveals a copy action on hover", () => {
  assert.match(
    blocks,
    /<Terminal[\s\S]*?class="group\/terminal-output relative rounded-none border-0 bg-transparent text-xs"[\s\S]*?<TerminalContent[\s\S]*?<TerminalCopyButton/,
  )
  assert.match(blocks, /group-hover\/terminal-output:opacity-100 focus-visible:opacity-100/)
  assert.match(blocks, /:aria-label="t\('blocks\.copyTerminal'\)"/)
  assert.match(blocks, /:output="terminalText\(block\)"/)
})

test("tool runs surface elapsed time, highlighted for long-running commands", () => {
  // pi's bash tool has no default timeout; a stuck command must be visible.
  assert.match(blocks, /startedAt/)
  assert.match(blocks, /elapsedText\(block\)/)
  assert.match(blocks, /text-amber-600 dark:text-amber-400/)
  assert.match(blocks, /ms > 120_000\?[\s\S]*?text-destructive|text-destructive/)
  // The timer lives in the reserved header slot so appearing/disappearing
  // cannot change the height of a short-running bash tool.
  const bashHeader = blocks.match(
    /<Tool v-else-if="block\.type === 'toolCall' && isBash\(block\)"[\s\S]*?<ToolContent>/,
  )
  assert.ok(bashHeader)
  assert.match(bashHeader[0], /<template #meta>/)
  assert.match(bashHeader[0], /w-12 text-right text-xs tabular-nums/)
  assert.doesNotMatch(bashHeader[0], /flex items-center justify-end gap-1 px-3 pb-1\.5/)
  assert.match(blocks, /ms == null \|\| ms < 1_000 \? "" : formatElapsed\(ms\)/)
  // tool-run lifecycle lives in the store's event-ingestion submodule.
  const store = readFileSync(new URL("../src/stores/session/events.ts", import.meta.url), "utf8")
  assert.match(store, /tool_execution_start[\s\S]*?startedAt: Date\.now\(\)/)
  assert.match(store, /tool_execution_end[\s\S]*?completedAt = Date\.now\(\)/)
})
