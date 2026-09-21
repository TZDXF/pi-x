import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
function harness() {
  const source = readFileSync(new URL('../src/stores/workspace.ts', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/export /g, '') + '\nglobalThis.store = useWorkspaceStore();'
  const requests = [], writes = [], storage = new Map()
  const context = vm.createContext({
    defineStore: (_, setup) => setup, ref: value => ({ value }),
    listSessions: path => new Promise(resolve => requests.push({ path, resolve })),
    updateSession: async (...args) => writes.push(args),
    localStorage: { getItem: key => storage.get(key), setItem: (k, v) => storage.set(k, v) },
  })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context)
  return { store: context.store, requests, writes, storage, context }
}
test('projects are persisted without duplicates', () => {
  const h = harness(); h.store.remember('C:/one'); h.store.remember('C:/one'); h.store.remember('C:/two')
  assert.deepEqual(JSON.parse(h.storage.get('pix.recentProjects')), ['C:/two', 'C:/one'])
})
test('refresh sorts by time and ignores stale responses', async () => {
  const h = harness(); const a = h.store.refresh('project'), b = h.store.refresh('project')
  h.requests[1].resolve([{ file: 'new', mtimeMs: 20 }, { file: 'old', mtimeMs: 10 }]); await b
  h.requests[0].resolve([{ file: 'stale', mtimeMs: 30 }]); await a
  assert.equal(h.store.histories.value.project[0].file, 'new')
})
test('rename and archive persist and update shared state; restore keeps title', async () => {
  const h = harness(); const row = { file: 'one.jsonl', preview: 'first message' }
  h.store.histories.value.project = [row]
  await h.store.update(row, 'new title', true)
  assert.equal(row.title, 'new title'); assert.equal(row.archived, true)
  await h.store.update(row, row.title, false)
  assert.equal(row.archived, false); assert.equal(row.title, 'new title')
  assert.deepEqual(h.writes[0], ['one.jsonl', 'new title', true])
})
test('failed metadata write does not change visible title', async () => {
  const h = harness(); const row = { file: 'one', title: 'original', archived: false }
  h.store.histories.value.project = [row]
  h.context.updateSession = async () => { throw new Error('disk full') }
  await assert.rejects(h.store.update(row, 'changed', true), /disk full/)
  assert.equal(row.title, 'original'); assert.equal(row.archived, false)
})
test('a stale list request cannot undo a successful rename', async () => {
  const h = harness(); const row = { file: 'one', title: 'original' }
  h.store.histories.value.project = [row]
  const refresh = h.store.refresh('project')
  await h.store.update(row, 'updated', false)
  h.requests[0].resolve([{ file: 'one', title: 'original' }]); await refresh
  assert.equal(h.store.histories.value.project[0].title, 'updated')
})
