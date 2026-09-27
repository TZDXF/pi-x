import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { contentModule, loadTsModule, loadTsSource } from './lib/load-ts.mjs'

function harness({ messages = [], lastError = null } = {}) {
  const modules = {
    pinia: { defineStore: (_, setup) => setup },
    vue: { ref: value => ({ value }), shallowRef: value => ({ value }), computed: get => ({ get value() { return get() } }), watch: (source, cb, options) => { if (options?.immediate) cb(typeof source === 'function' ? source() : source); return () => {} } },
    '@/lib/checkpoints': { createCheckpoint: async () => ({ refName: 'r', commitOid: 'oid' }), diffCheckpoints: async () => [], loadCheckpointManifest: async () => null, saveCheckpointManifest: async () => {} },
    '@/i18n': { i18n: { global: { t: key => key } } },
    '@/api/piClient': {
      pixLog() {},
      rpcRequest: async cmd => {
        if (cmd.type === 'get_messages') return { success: true, data: { messages } }
        if (cmd.type === 'get_state') return { success: true, data: { sessionFile: 'test.jsonl' } }
        return { success: true, data: {} }
      },
      sessionHistory: async () => null, // fall back to the RPC projection
      sessionLastError: async () => lastError,
      sessionMtime: async () => 0,
    },
    '@/stores/workspace': { useWorkspaceStore: () => ({ histories: {}, projectName: () => 'project' }) },
    '@/lib/notifications': { notifyTurnComplete() {} },
    '@/stores/sessionRunStatus': { setSessionRunStatus() {} },
    '@/lib/content': contentModule(),
    '@/lib/sessionChanges': loadTsSource(readFileSync(new URL('../src/lib/sessionChanges.ts', import.meta.url), 'utf8')),
    '@/lib/contextBreakdown': loadTsSource(readFileSync(new URL('../src/lib/contextBreakdown.ts', import.meta.url), 'utf8')),
  }
  const { createSessionStore } = loadTsModule(
    new URL('../src/stores/session.ts', import.meta.url), id => modules[id],
    { setTimeout, localStorage: { getItem: () => null } })
  const store = createSessionStore('test')()
  store.sessionFile.value = 'test.jsonl'
  return store
}

const user = (text, timestamp) => ({ role: 'user', content: [{ type: 'text', text }], timestamp })
const assistant = (text, timestamp) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp })
const failed = (errorMessage, timestamp) => ({ role: 'assistant', content: [], stopReason: 'error', errorMessage, timestamp })
const errorEntries = store => store.entries.value.filter(e =>
  e.kind === 'assistant' && e.blocks.some(b => b.type === 'text' && b.text.includes('chat.errorLabel')))

test('history does not render mid-conversation error messages', async () => {
  const store = harness({
    messages: [
      user('hi', 1000),
      failed('503: {"type":"http_error","message":"provider overloaded"}', 2000),
      assistant('recovered', 3000),
    ],
    lastError: null,
  })
  await store.loadHistory()
  const entries = store.entries.value
  // The failed attempt stays hidden; only real content renders.
  assert.equal(entries.map(e => e.kind).join(','), 'user,assistant')
  assert.equal(errorEntries(store).length, 0)
  assert.equal(entries[1].blocks[0].text, 'recovered')
})

test('a final failure is appended after the conversation', async () => {
  const store = harness({
    messages: [
      user('hi', 1000),
      assistant('working', 2000),
    ],
    lastError: { timestamp: 2500, errorMessage: '503: {"type":"http_error","message":"provider overloaded"}' },
  })
  await store.loadHistory()
  const entries = store.entries.value
  assert.equal(entries.length, 3)
  const last = entries.at(-1)
  assert.equal(last.kind, 'assistant')
  assert.match(last.blocks[0].text, /chat\.errorLabel/)
  // Provider JSON payloads unwrap to "status · message".
  assert.match(last.blocks[0].text, /503 · provider overloaded/)
  assert.equal(entries[1].blocks[0].text, 'working')
})

test('a recovered retry is not a stop reason', async () => {
  const store = harness({
    messages: [
      user('hi', 1000),
      assistant('working', 2000),
      // The retry recovered and the turn continued past the failure.
      assistant('done', 4000),
    ],
    lastError: { timestamp: 3500, errorMessage: '503: {"type":"http_error","message":"provider overloaded"}' },
  })
  await store.loadHistory()
  assert.equal(store.entries.value.length, 3)
  assert.equal(errorEntries(store).length, 0)
  assert.equal(store.entries.value.at(-1).blocks[0].text, 'done')
})

test('a failure followed by a newer user prompt is not a stop reason', async () => {
  const store = harness({
    messages: [
      user('hi', 1000),
      assistant('recovered', 2000),
      user('next question', 3000),
      assistant('answer', 4000),
    ],
    lastError: { timestamp: 1500, errorMessage: '503 boom' },
  })
  await store.loadHistory()
  assert.equal(store.entries.value.length, 4)
  assert.equal(errorEntries(store).length, 0)
})

test('an in-progress turn never gets a mid-conversation stop reason', async () => {
  const store = harness({
    messages: [user('hi', 1000), assistant('working', 2000)],
    lastError: { timestamp: 2500, errorMessage: '503 boom' },
  })
  // Viewing a session while its turn is still running: retry may recover, and
  // later live events append after whatever loadHistory added.
  store.handleEvent({ type: 'agent_start' })
  await store.loadHistory()
  assert.equal(errorEntries(store).length, 0)
  // Once the turn is over, the same history surfaces the stop reason again.
  store.handleEvent({ type: 'agent_settled' })
  await store.loadHistory()
  assert.equal(errorEntries(store).length, 1)
})

test('history without errors loads unchanged', async () => {
  const store = harness({
    messages: [user('hi', 1000), assistant('ok', 2000)],
    lastError: null,
  })
  await store.loadHistory()
  const entries = store.entries.value
  assert.equal(entries.length, 2)
  assert.equal(entries[1].blocks[0].text, 'ok')
})