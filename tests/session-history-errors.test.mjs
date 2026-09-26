import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { contentModule, loadTsSource } from './lib/load-ts.mjs'

function harness({ messages = [], lastError = null } = {}) {
  const source = readFileSync(new URL('../src/stores/session.ts', import.meta.url), 'utf8')
  const modules = {
    pinia: { defineStore: (_, setup) => setup },
    vue: { ref: value => ({ value }), shallowRef: value => ({ value }), computed: get => ({ get value() { return get() } }) },
    '@/i18n': { i18n: { global: { t: key => key } } },
    '@/api/piClient': {
      pixLog() {},
      rpcRequest: async () => ({ success: true, data: { messages } }),
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
  const context = vm.createContext({ exports: {}, console, setTimeout, localStorage: { getItem: () => null }, require: id => modules[id] })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  const store = context.exports.createSessionStore('test')()
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

test('the final turn stop reason is appended after the conversation', async () => {
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
  const entries = store.entries.value
  assert.equal(entries.length, 4)
  const last = entries.at(-1)
  assert.equal(last.kind, 'assistant')
  assert.match(last.blocks[0].text, /chat\.errorLabel/)
  // Provider JSON payloads unwrap to "status · message".
  assert.match(last.blocks[0].text, /503 · provider overloaded/)
  // Appended at the end, even though its timestamp is older.
  assert.equal(entries[2].blocks[0].text, 'done')
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