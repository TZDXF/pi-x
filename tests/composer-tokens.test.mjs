import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/composerTokens.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { composerParts } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('composer chips hide paths and slash prefixes without changing raw text', () => {
  const text = '/review @"C:/project/src/my file.ts" @session("C:/sessions/old.jsonl") with @src/App.vue '
  const parts = composerParts(text)
  assert.deepEqual(parts.filter(p => p.kind !== 'text').map(p => [p.kind, p.label]), [
    ['command', 'review'], ['file', 'my file.ts'], ['session', 'old.jsonl'], ['file', 'App.vue'],
  ])
  assert.equal(parts.map(p => p.raw).join(''), text)
})

test('unfinished completion tokens remain editable plain text', () => {
  for (const text of ['/rev', '@src/in', '@"src/unclosed', 'mail@example.com'])
    assert.equal(composerParts(text).map(p => p.raw).join(''), text)
  assert.equal(composerParts('/rev').some(p => p.kind !== 'text'), false)
  assert.equal(composerParts('@src/in').some(p => p.kind !== 'text'), false)
  assert.equal(composerParts('mail@example.com ').some(p => p.kind !== 'text'), false)
})
