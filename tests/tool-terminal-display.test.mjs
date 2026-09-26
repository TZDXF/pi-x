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
