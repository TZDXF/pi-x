import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsSource } from './lib/load-ts.mjs'
const { sessionChanges, changedLines } = loadTsSource(readFileSync(new URL('../src/lib/sessionChanges.ts', import.meta.url), 'utf8'))
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })
const history = (block, isError = false) => [{ role: 'assistant', content: [block] }, { role: 'toolResult', toolCallId: block.id, isError }]
const collect = h => sessionChanges(h, [], [], {})
test('counts only successful edits and ignores reads', () => {
  const c = call('a', 'edit', { path: 'a.ts', oldText: 'a\nb\n', newText: 'a\nc\nd\n' })
  const result = collect(history(c))
  assert.equal(result[0].added, 2)
  assert.equal(result[0].removed, 1)
  assert.equal(collect(history(c, true)).length, 0)
  assert.equal(collect([history(c)[0]]).length, 0)
  assert.equal(collect(history(call('r', 'read', { path: 'a' }))).length, 0)
})
test('write without a baseline counts all lines as additions', () => {
  const [change] = collect(history(call('w', 'write', { path: 'a', content: 'hello\nworld' })))
  assert.equal(change.unknownBefore, true)
  // 未知原内容按"全部为新增"统计（与 ZCode 的 before ?? "" 口径一致）。
  assert.equal(change.added, 2)
  assert.equal(change.lines.length, 2)
})
test('history and materialized live calls deduplicate by call id', () => {
  const c = call('a', 'edit', { path: 'a', oldText: 'x', newText: 'y' })
  const block = { type: 'toolCall', callId: 'a', name: 'edit', argsText: JSON.stringify(c.arguments) }
  assert.equal(sessionChanges(history(c), [{ kind: 'assistant', blocks: [block] }], [block], { a: { id: 'a', state: 'output-available' } }).length, 1)
})
test('multi edits, aliases, empty files and malformed input', () => {
  const result = collect(history(call('a', 'MultiEdit', { file_path: 'a', edits: [{ old_string: 'a', new_string: '' }, { old_string: '', new_string: 'b' }] })))
  assert.equal(result.length, 2)
  assert.equal(result[0].removed, 1)
  assert.equal(result[1].added, 1)
  assert.equal(collect(history(call('b', 'edit', null))).length, 0)
  assert.equal(collect(history(call('c', 'edit', '{'))).length, 0)
})
test('diff preserves unchanged interior lines and normalizes CRLF', () => {
  const result = changedLines('a\r\nkeep\r\nb\r\n', 'x\nkeep\ny\n')
  assert.equal(result.filter(l => l.kind === 'add').length, 2)
  assert.equal(result.filter(l => l.kind === 'remove').length, 2)
  assert.equal(changedLines('', '').length, 0)
})


test('null streaming blocks are valid for idle and completed sessions', () => {
  assert.equal(sessionChanges([], [], null, {}).length, 0)
  const c = call('done', 'edit', { path: 'a.ts', oldText: 'old', newText: 'new' })
  const changes = sessionChanges(history(c), [], null, {})
  assert.equal(changes.length, 1)
  assert.equal(changes[0].added, 1)
  assert.equal(changes[0].removed, 1)
})
