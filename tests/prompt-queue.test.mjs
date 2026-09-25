import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { contentModule } from './lib/load-ts.mjs'

function loadStore(name, modules) {
  const source = readFileSync(new URL(`../src/stores/${name}.ts`, import.meta.url), 'utf8')
  const context = vm.createContext({ exports: {}, console: { warn() {}, error() {} },
    require: id => modules[id], localStorage: { getItem: () => null } })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  const exports = context.exports
  // session.ts: factory (runtimeId => store); workspace.ts: plain store fn.
  const factory = exports.createSessionStore ?? exports.createUiStore
  const store = factory ? factory('default')() : Object.values(exports)[0]()
  return store
}
const framework = {
  pinia: { defineStore: (_, setup) => setup },
  vue: { ref: value => ({ value }), shallowRef: value => ({ value }), computed: get => ({ get value() { return get() } }) },
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
  const store = loadStore('session', { ...framework,
    '@/stores/sessionRunStatus': { setSessionRunStatus() {} }, '@/i18n': { i18n: { global: { t: key => key } } }, '@/lib/content': contentModule(), '@/api/piClient': api, '@/lib/notifications': { notifyTurnComplete() {} }, '@/stores/workspace': { useWorkspaceStore: () => ({ histories: {}, projectName: () => 'project',
    preview: row => previews.push(row), generatedTitle: (...args) => titles.push(args), refresh: async path => refreshed.push(path),
  }) } })
  store.state.value = { sessionId: 'one', messageCount: 0 }
  store.sessionFile.value = 'one.jsonl'; store.cwd.value = 'project-one'
  return { store, calls, previews, titles, refreshed, finish: value => finish(value), fail: () => fail(new Error('offline')) }
}

test('queue waits until settled, preserving images and expanded text', async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  const images = [{ data: 'YWJj', mimeType: 'image/png' }]
  await h.store.send('next', images, 'expanded next', 'queue')
  assert.equal(h.calls.length, 0)
  assert.equal(h.store.entries.value.length, 0)
  assert.equal(h.store.pendingCount.value, 1)
  h.store.handleEvent({ type: 'agent_end' })
  const prompts = h.calls.filter(c => c.type === 'prompt')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].message, 'expanded next')
  assert.equal(prompts[0].images[0].data, 'YWJj')
  assert.equal(prompts[0].streamingBehavior, undefined)
  assert.equal(h.store.promptQueue.value.length, 0)
})

test('reorder and remove use stable IDs, including identical prompts', async () => {
  const h = sessionHarness(); h.store.isStreaming.value = true
  for (const text of ['same', 'same', 'third']) await h.store.send(text, undefined, undefined, 'queue')
  const [a, b, c] = h.store.promptQueue.value.map(item => item.id)
  h.store.moveQueuedPrompt(c, a)
  assert.equal(h.store.promptQueue.value[0].id, c)
  assert.equal(h.store.removeQueuedPrompt(b).text, 'same')
  h.store.moveQueuedPrompt(b, a) // stale drag must not remove another item
  assert.equal(h.store.promptQueue.value.length, 2)
  h.store.handleEvent({ type: 'agent_end' })
  assert.equal(h.calls.find(c => c.type === 'prompt').message, 'third')
  assert.equal(h.store.promptQueue.value[0].id, a)
  h.store.dispatchQueuedPrompt() // must not send while the new run is starting
  assert.equal(h.calls.filter(c => c.type === 'prompt').length, 1)
})

test('steering goes to the running agent without draining the queue', async () => {
  const h = sessionHarness(); h.store.isStreaming.value = true
  await h.store.send('later', undefined, undefined, 'queue')
  await h.store.send('change direction', undefined, undefined, 'steer')
  assert.equal(h.calls[0].streamingBehavior, 'steer')
  assert.equal(h.calls[0].message, 'change direction')
  assert.equal(h.store.promptQueue.value.length, 1)
})

test('clear removes pending prompts', async () => {
  const h = sessionHarness(); h.store.isStreaming.value = true
  await h.store.send('later', undefined, undefined, 'queue')
  h.store.clear()
  assert.equal(h.store.pendingCount.value, 0)
})

test('run now sends the selected item with attachments and leaves other items in order', async () => {
  const h = sessionHarness(); h.store.isStreaming.value = true
  const images = [{ data: 'YWJj', mimeType: 'image/png' }]
  await h.store.send('first', undefined, undefined, 'queue')
  await h.store.send('selected', images, 'expanded selected', 'queue')
  await h.store.send('last', undefined, undefined, 'queue')
  const id = h.store.promptQueue.value[1].id
  h.store.executeQueuedPrompt(id)
  h.store.executeQueuedPrompt(id) // repeated clicks must not send twice
  const prompts = h.calls.filter(c => c.type === 'prompt')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].message, 'expanded selected')
  assert.equal(prompts[0].images[0].data, 'YWJj')
  assert.equal(prompts[0].streamingBehavior, 'steer')
  assert.equal(h.store.promptQueue.value.map(item => item.text).join(','), 'first,last')
})

test('run now starts an idle agent and is blocked during resend or compaction', async () => {
  const h = sessionHarness(); h.store.isStreaming.value = true
  await h.store.send('selected', undefined, undefined, 'queue')
  const id = h.store.promptQueue.value[0].id
  h.store.isStreaming.value = false
  h.store.isResending.value = true
  h.store.executeQueuedPrompt(id)
  h.store.isResending.value = false
  h.store.isCompacting.value = true
  h.store.executeQueuedPrompt(id)
  assert.equal(h.store.promptQueue.value.length, 1)
  assert.equal(h.calls.length, 0)
  h.store.isCompacting.value = false
  h.store.executeQueuedPrompt(id)
  assert.equal(h.store.promptQueue.value.length, 0)
  assert.equal(h.calls.find(c => c.type === 'prompt').streamingBehavior, undefined)
})

test('queue sends only one message per run despite duplicate completion events', async () => {
  const h = sessionHarness(); h.store.isStreaming.value = true
  for (const text of ['first', 'second', 'third']) {
    await h.store.send(text, undefined, undefined, 'queue')
  }
  const sent = () => h.calls.filter(c => c.type === 'prompt').map(c => c.message)
  h.store.handleEvent({ type: 'agent_end' })
  h.store.handleEvent({ type: 'agent_settled' })
  h.store.handleEvent({ type: 'agent_end' })
  h.store.dispatchQueuedPrompt()
  assert.deepEqual(sent(), ['first'])
  assert.equal(h.store.isStreaming.value, true)
  assert.equal(h.store.promptQueue.value.length, 2)

  h.store.handleEvent({ type: 'agent_start' })
  assert.deepEqual(sent(), ['first'])
  h.store.handleEvent({ type: 'agent_end' })
  h.store.handleEvent({ type: 'agent_settled' })
  assert.deepEqual(sent(), ['first', 'second'])
  assert.equal(h.store.promptQueue.value.length, 1)

  h.store.handleEvent({ type: 'agent_start' })
  h.store.handleEvent({ type: 'agent_settled' })
  assert.deepEqual(sent(), ['first', 'second', 'third'])
  assert.equal(h.store.promptQueue.value.length, 0)
  assert.ok(h.calls.filter(c => c.type === 'prompt').every(c => !c.streamingBehavior))
})
