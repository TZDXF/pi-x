import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'

const source = readFileSync(new URL('../src/stores/composerDrafts.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
  .replace('from "vue"', `from "${import.meta.resolve('vue')}"`)
const storage = new Map()
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
}
let sequence = 0
const load = () => import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}#${sequence++}`)

test('a project new-session draft is restored, then cleared after sending', async () => {
  const drafts = await load()
  drafts.recordComposerDraft('C:/project', null, 'unsent project text')
  assert.equal(drafts.composerDraftText('C:/project', null), 'unsent project text')
  assert.equal(drafts.composerDraftText('C:/other-project', null), '')

  const restored = await load()
  assert.equal(restored.composerDraftText('C:/project', null), 'unsent project text')
  restored.recordComposerDraft('C:/project', null, '')
  restored.recordComposerDraft('C:/project', 'C:/sessions/one.jsonl', '')
  assert.equal(restored.composerDraftText('C:/project', null), '')
  assert.equal(restored.composerDraftText('C:/project', 'C:/sessions/one.jsonl'), '')
})

test('saved session drafts remain independent from the project new-session input', async () => {
  const drafts = await load()
  drafts.recordComposerDraft('C:/project', null, 'next session')
  drafts.recordComposerDraft('C:/project', 'C:/sessions/one.jsonl', 'existing session')
  assert.equal(drafts.composerDraftText('C:/project', null), 'next session')
  assert.equal(drafts.composerDraftText('C:/project', 'C:/sessions/one.jsonl'), 'existing session')
})
