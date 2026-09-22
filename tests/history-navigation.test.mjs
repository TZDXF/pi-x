import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const run = (code, context) => vm.runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), vm.createContext(context))

test('navigation stays serialized and the latest pending selection wins', async () => {
  const app = source('../src/App.vue')
  const code = app.slice(app.indexOf('let queuedNavigation:'), app.indexOf('watch([connecting, navigating]'))
  const context = { ref: value => ({ value }), session: {}, workspace: {}, phase: { value: 'chat' }, connecting: { value: false }, navigating: { value: false }, pendingResume: { value: null }, disposed: false }
  run(code + '\nglobalThis.navigate = requestNavigation', context)
  const calls = []
  let finish
  context.navigate(() => { calls.push('first'); return new Promise(resolve => { finish = resolve }) })
  context.navigate(async () => { calls.push('skipped') })
  context.navigate(async () => { calls.push('latest') })
  assert.deepEqual(calls, ['first'])
  finish()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, ['first', 'latest'])
})

test('history prefetches near the top, suppresses duplicates and preserves the reading position', async () => {
  const chat = source('../src/components/ChatView.vue')
  const code = chat.slice(chat.indexOf('let restoringHistory ='), chat.indexOf('const completion ='))
  const viewport = { scrollTop: 601, scrollHeight: 2000, isConnected: true }
  let finish
  let requests = 0
  const context = {
    session: { sessionFile: 'current', hasOlderHistory: true, loadOlderHistory: () => { requests++; return new Promise(resolve => { finish = resolve }) } },
    props: {}, conversation: { value: { stopScroll() {} } }, nextTick: async () => {}, ui: { pushToast() {} },
  }
  run(code + '\nglobalThis.scroll = onHistoryScroll', context)
  await context.scroll({ target: viewport })
  assert.equal(requests, 0)
  viewport.scrollTop = 500
  const pending = context.scroll({ target: viewport })
  await context.scroll({ target: viewport })
  assert.equal(requests, 1)
  viewport.scrollTop = 450 // Reader continues scrolling while the page is loaded.
  viewport.scrollHeight = 3200
  finish()
  await pending
  assert.equal(viewport.scrollTop, 1650)
})

test('history is mounted only after loading and uses instant initial positioning', () => {
  const chat = source('../src/components/ChatView.vue')
  assert.match(chat, /v-if="connecting \|\| session.historyLoading"/)
  assert.match(chat, /<Conversation v-else[^>]+initial="instant"/)
  assert.doesNotMatch(chat, /@click="loadOlderHistory"/)
})
