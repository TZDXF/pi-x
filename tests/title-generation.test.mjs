import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function loadStore(name, modules) {
  const source = readFileSync(new URL(`../src/stores/${name}.ts`, import.meta.url), 'utf8')
  const context = vm.createContext({ exports: {}, console: { warn() {}, error() {} },
    require: id => modules[id], localStorage: { getItem: () => null } })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  return Object.values(context.exports)[0]()
}
const framework = {
  pinia: { defineStore: (_, setup) => setup },
  vue: { ref: value => ({ value }), computed: get => ({ get value() { return get() } }) },
}
function sessionHarness() {
  const calls = [], previews = [], titles = [], refreshed = []
  let finish, fail
  const api = {
    rpcRequest: command => { calls.push(command); return new Promise(() => {}) },
    generateSessionTitle: (...args) => {
      calls.push({ type: 'title', args })
      return new Promise((resolve, reject) => { finish = resolve; fail = reject })
    },
  }
  const store = loadStore('session', { ...framework, '@/api/piClient': api, '@/stores/workspace': { useWorkspaceStore: () => ({
    preview: row => previews.push(row), generatedTitle: (...args) => titles.push(args), refresh: async path => refreshed.push(path),
  }) } })
  store.state.value = { sessionId: 'one', messageCount: 0 }
  store.sessionFile.value = 'one.jsonl'; store.cwd.value = 'project-one'
  return { store, calls, previews, titles, refreshed, finish: value => finish(value), fail: () => fail(new Error('offline')) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('first message is visible immediately; title is independent of unfinished conversation', async () => {
  const h = sessionHarness()
  await h.store.send('Fix login\nplease')
  assert.equal(h.previews[0].preview, 'Fix login please')
  assert.equal(h.calls[0].type, 'prompt')
  assert.equal(h.calls[1].type, 'title')
  assert.equal(h.titles.length, 0)
  h.finish('Login fix'); await tick()
  assert.deepEqual(h.titles, [['one.jsonl', 'Login fix']])
})
test('subsequent messages never trigger a second title request', async () => {
  const h = sessionHarness(); await h.store.send('first'); await h.store.send('second')
  assert.equal(h.calls.filter(c => c.type === 'title').length, 1)
})
test('switching sessions while generating keeps the result attached to the original file', async () => {
  const h = sessionHarness(); await h.store.send('first')
  h.store.sessionFile.value = 'two.jsonl'; h.store.cwd.value = 'project-two'
  h.finish('First title'); await tick()
  assert.deepEqual(h.titles, [['one.jsonl', 'First title']])
  assert.deepEqual(h.refreshed, ['project-one'])
})
test('failure leaves preview intact and does not add an error to the conversation', async () => {
  const h = sessionHarness(); await h.store.send('first'); h.fail(); await tick()
  assert.equal(h.titles.length, 0); assert.equal(h.previews[0].preview, 'first')
  assert.equal(h.store.entries.value.length, 1)
})
test('resumed nonempty sessions do not generate new titles', async () => {
  const h = sessionHarness(); h.store.state.value.messageCount = 5
  await h.store.send('continue'); assert.equal(h.calls.filter(c => c.type === 'title').length, 0)
})
test('workspace preserves previews before pi persists and does not overwrite manual titles', async () => {
  let disk = []
  const store = loadStore('workspace', { ...framework, '@/api/piClient': {
    listSessions: async () => disk, updateSession: async () => {},
  } })
  store.preview({ file: 'one', cwd: 'project', preview: 'first', mtimeMs: 1 })
  await store.refresh('project')
  assert.equal(store.histories.value.project[0].preview, 'first')
  store.generatedTitle('one', 'Generated')
  assert.equal(store.histories.value.project[0].title, 'Generated')
  await store.update(store.histories.value.project[0], 'Manual', true)
  store.generatedTitle('one', 'Late generated title')
  assert.equal(store.histories.value.project[0].title, 'Manual')
  disk = [{ file: 'one', cwd: 'project', title: 'Manual', archived: true, mtimeMs: 2 }]
  await store.refresh('project')
  assert.equal(store.histories.value.project.length, 1)
  assert.equal(store.histories.value.project[0].archived, true)
})
