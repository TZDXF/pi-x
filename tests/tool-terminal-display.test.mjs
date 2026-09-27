import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const blocks = readFileSync(new URL('../src/components/AssistantBlocks.vue', import.meta.url), 'utf8')

test('shell tool output has no nested terminal chrome and reveals a copy action on hover', () => {
  assert.match(blocks, /<Terminal[\s\S]*?class="group\/terminal-output relative rounded-none border-0 bg-transparent text-xs"[\s\S]*?<TerminalContent[\s\S]*?<TerminalCopyButton/)
  assert.match(blocks, /group-hover\/terminal-output:opacity-100 focus-visible:opacity-100/)
  assert.match(blocks, /:aria-label="t\('blocks\.copyTerminal'\)"/)
  assert.match(blocks, /:output="terminalText\(block\)"/)
})

test('tool runs surface elapsed time, highlighted for long-running commands', () => {
  // pi's bash tool has no default timeout; a stuck command must be visible.
  assert.match(blocks, /startedAt/)
  assert.match(blocks, /elapsedText\(block\)/)
  assert.match(blocks, /text-amber-600 dark:text-amber-400/)
  assert.match(blocks, /ms > 120_000\?[\s\S]*?text-destructive|text-destructive/)
  // tool-run lifecycle lives in the store's event-ingestion submodule.
  const store = readFileSync(new URL('../src/stores/session/events.ts', import.meta.url), 'utf8')
  assert.match(store, /tool_execution_start[\s\S]*?startedAt: Date\.now\(\)/)
  assert.match(store, /tool_execution_end[\s\S]*?completedAt = Date\.now\(\)/)
})