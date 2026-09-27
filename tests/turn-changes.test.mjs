import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsModule, loadTsSource } from './lib/load-ts.mjs'

const sessionChanges = loadTsSource(readFileSync(new URL('../src/lib/sessionChanges.ts', import.meta.url), 'utf8'))
const { turnFileChanges } = loadTsModule(
  new URL('../src/lib/turnChanges.ts', import.meta.url),
  id => (id === '@/lib/sessionChanges' ? sessionChanges : undefined),
)

// VM 内创建的对象原型与测试环境不同，deepStrictEqual 会因原型差异而失败。
const plain = value => JSON.parse(JSON.stringify(value))

const block = (callId, name, args) => ({ type: 'toolCall', callId, name, argsText: JSON.stringify(args) })
const ok = callId => ({ [callId]: { id: callId, name: 'tool', argsText: '', outputText: '', state: 'output-available' } })

test('collects successful edits grouped by file with line totals', () => {
  const blocks = [
    block('a', 'edit', { path: 'src/a.ts', oldText: 'a\nb\n', newText: 'a\nc\nd\n' }),
    block('b', 'edit', { path: 'src/a.ts', oldText: 'c', newText: 'e' }),
  ]
  const files = turnFileChanges(blocks, { ...ok('a'), ...ok('b') })
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'src/a.ts')
  assert.equal(files[0].added, 3)
  assert.equal(files[0].removed, 2)
  assert.equal(files[0].revertible, true)
  assert.deepEqual(plain(files[0].ops), [
    { kind: 'replace', before: 'a\nb\n', after: 'a\nc\nd\n' },
    { kind: 'replace', before: 'c', after: 'e' },
  ])
})

test('ignores failed, running and malformed calls', () => {
  const edit = block('a', 'edit', { path: 'a', oldText: 'x', newText: 'y' })
  assert.deepEqual(plain(turnFileChanges([edit], { a: { id: 'a', name: 'tool', argsText: '', outputText: '', state: 'output-error' } })), [])
  assert.deepEqual(plain(turnFileChanges([edit], { a: { id: 'a', name: 'tool', argsText: '', outputText: '', state: 'input-available' } })), [])
  assert.deepEqual(plain(turnFileChanges([edit], {})), [])
  assert.deepEqual(plain(turnFileChanges([{ type: 'toolCall', callId: 'a', name: 'edit', argsText: '{' }], ok('a'))), [])
  assert.deepEqual(plain(turnFileChanges([block('r', 'read', { path: 'a' })], ok('r'))), [])
  assert.deepEqual(plain(turnFileChanges([block('s', 'bash', { command: 'sed -i s/a/b/' })], ok('s'))), [])
})

test('created files revert by deletion; plain writes are not revertible', () => {
  const [created] = turnFileChanges([block('c', 'create_file', { path: 'new.ts', content: 'hello\n' })], ok('c'))
  assert.equal(created.revertible, true)
  assert.deepEqual(plain(created.ops), [{ kind: 'delete', content: 'hello\n' }])

  const [written] = turnFileChanges([block('w', 'write', { path: 'a.ts', content: 'hello\nworld' })], ok('w'))
  assert.equal(written.unknown, true)
  assert.equal(written.revertible, false)
  // 未知原内容按"全部为新增"统计。
  assert.equal(written.added, 2)
})

test('a single non-revertible call marks the whole file as such', () => {
  const blocks = [
    block('a', 'edit', { path: 'a.ts', oldText: 'x', newText: 'y' }),
    block('w', 'write', { path: 'a.ts', content: 'overwritten' }),
  ]
  const [file] = turnFileChanges(blocks, { ...ok('a'), ...ok('w') })
  assert.equal(file.revertible, false)
  // 可还原的编辑操作仍被记录，供失败提示与调试。
  assert.deepEqual(plain(file.ops), [{ kind: 'replace', before: 'x', after: 'y' }])
})

test('multi-edit aliases produce ordered replace ops', () => {
  const [file] = turnFileChanges([block('m', 'MultiEdit', { file_path: 'a.ts', edits: [
    { old_string: 'a', new_string: 'b' },
    { old_string: 'b', new_string: 'c' },
  ] })], ok('m'))
  assert.equal(file.path, 'a.ts')
  assert.deepEqual(plain(file.ops), [
    { kind: 'replace', before: 'a', after: 'b' },
    { kind: 'replace', before: 'b', after: 'c' },
  ])
})

test('path separators are normalized for grouping', () => {
  const files = turnFileChanges([block('a', 'edit', { path: 'src\\lib\\a.ts', oldText: 'x', newText: 'y' })], ok('a'))
  assert.equal(files[0].path, 'src/lib/a.ts')
})
