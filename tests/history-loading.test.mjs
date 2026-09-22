import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness() {
  const requests = []
  const modules = {
    pinia: { defineStore: (_, setup) => setup },
    vue: { ref: value => ({ value }), computed: get => ({ get value() { return get() } }) },
    '@/api/piClient': { rpcRequest: () => new Promise(resolve => requests.push(resolve)) },
    '@/stores/workspace': {},
  }
  const context = vm.createContext({ exports: {}, setTimeout, require: id => modules[id] })
  const source = readFileSync(new URL('../src/stores/session.ts', import.meta.url), 'utf8')
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  return { store: context.exports.useSessionStore(), requests }
}
const messages = count => Array.from({ length: count }, (_, i) => ({ role: 'user', content: `message ${i}` }))

test('first page is asynchronous and limited to 30 entries; pages preserve ordering and ids', async () => {
  const { store } = harness()
  const loading = store.loadMessages(messages(75))
  assert.equal(store.entries.value.length, 0)
  await loading
  assert.equal(store.entries.value.length, 30)
  assert.equal(store.entries.value[0].text, 'message 45')
  const id = store.entries.value[0].id
  await Promise.all([store.loadOlderHistory(), store.loadOlderHistory()])
  assert.equal(store.entries.value.length, 60)
  assert.equal(store.entries.value[30].id, id)
  await store.loadOlderHistory()
  assert.equal(store.entries.value.length, 75)
  assert.equal(store.entries.value[0].text, 'message 0')
  assert.equal(store.hasOlderHistory.value, false)
})

test('tool results survive page boundaries and image-only user messages are retained', async () => {
  const { store } = harness()
  await store.loadMessages([
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'call', content: 'result' },
    ...messages(29),
    { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }] },
  ])
  assert.equal(store.entries.value.length, 30)
  assert.equal(store.entries.value[29].images[0].url, 'data:image/png;base64,abc')
  await store.loadOlderHistory()
  assert.equal(store.runs.value.call.outputText, 'result')
  assert.equal(store.entries.value[0].blocks[0].callId, 'call')
})

test('clear cancels pending page processing', async () => {
  const { store } = harness()
  const pending = store.loadMessages(messages(100))
  store.clear()
  await pending
  assert.equal(store.entries.value.length, 0)
  assert.equal(store.olderHistoryLoading.value, false)
  assert.equal(store.hasOlderHistory.value, false)
})

test('out-of-order history requests cannot overwrite a newer session', async () => {
  const { store, requests } = harness()
  const old = store.loadHistory()
  store.clear()
  const current = store.loadHistory()
  requests[1]({ success: true, data: { messages: messages(1) } })
  await current
  requests[0]({ success: true, data: { messages: messages(99) } })
  await old
  assert.equal(store.entries.value.length, 1)
  assert.equal(store.historyLoading.value, false)
})

test('failed history request resets loading and can be retried', async () => {
  const { store, requests } = harness()
  const failed = store.loadHistory()
  requests[0]({ success: false, error: 'offline' })
  await assert.rejects(failed, /offline/)
  assert.equal(store.historyLoading.value, false)
  const retry = store.loadHistory()
  requests[1]({ success: true, data: { messages: [] } })
  await retry
  assert.equal(store.hasOlderHistory.value, false)
})
