import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsSource, contentModule } from './lib/load-ts.mjs'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function harness(overrides = {}) {
  const calls = []
  const state = { sessionId: 'current', sessionFile: 'current.jsonl', messageCount: 2,
    isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
  const api = {
    sessionMtime: async () => 1,
    rpcRequest: async command => {
      calls.push(command)
      if (overrides[command.type]) return overrides[command.type](command)
      return { success: true, data: command.type === 'get_state' ? state : {} }
    },
  }
  const modules = {
    vue: { ref: value => ({ value }), shallowRef: value => ({ value }), computed: get => ({ get value() { return get() } }) },
    pinia: { defineStore: (_, setup) => setup },
    '@/api/piClient': api,
    '@/lib/content': contentModule(),
    '@/stores/sessionRunStatus': { setSessionRunStatus() {} },
    '@/i18n': { i18n: { global: { t: key => key } } },
  }
  const { createSessionStore } = loadTsSource(source('../src/stores/session.ts'), {
    require: name => modules[name], localStorage: { getItem: () => null },
  })
  const store = createSessionStore('editing')()
  store.state.value = state
  store.sessionFile.value = state.sessionFile
  store.entries.value = [{ kind: 'user', id: 1, text: 'original' }]
  return { store, calls, state }
}

test('running prompt: waits for abort, then resends in the same session with images', async () => {
  let finishAbort
  const h = harness({ abort: () => new Promise(resolve => { finishAbort = resolve }) })
  h.store.isStreaming.value = true
  const images = [{ data: 'YWJj', mimeType: 'image/png' }]
  const pending = h.store.resendPrompt('revised', images, 'revised expanded')
  await tick()
  assert.deepEqual(h.calls.map(call => call.type), ['clear_queue', 'abort'])
  assert.equal(h.store.isResending.value, true)
  finishAbort({ success: true })
  await pending
  assert.deepEqual(h.calls.slice(0, 4).map(call => call.type), ['clear_queue', 'abort', 'get_state', 'prompt'])
  const prompt = h.calls.find(call => call.type === 'prompt')
  assert.equal(prompt.message, 'revised expanded')
  assert.equal(prompt.streamingBehavior, undefined)
  assert.equal(prompt.images[0].data, 'YWJj')
  assert.equal(h.store.sessionFile.value, 'current.jsonl')
  assert.equal(h.store.entries.value[0].text, 'original')
  assert.equal(h.store.entries.value[1].text, 'revised')
  assert.equal(h.store.isStreaming.value, true)
  assert.equal(h.store.isResending.value, false)
  assert.ok(h.calls.every(call => !['fork', 'get_fork_messages', 'get_messages', 'new_session', 'switch_session'].includes(call.type)))
})

test('agent-end during abort cannot dispatch queued prompts ahead of the edited question', async () => {
  const h = harness({ clear_queue: async () => ({ success: true, data: { steering: ['remote queued'] } }),
    abort: async () => { h.store.handleEvent({ type: 'agent_end' }); return { success: true } },
  })
  h.store.isStreaming.value = true
  await h.store.send('local queued', undefined, undefined, 'queue')
  await h.store.resendPrompt('revised')
  assert.deepEqual(h.calls.filter(call => call.type === 'prompt').map(call => call.message), ['revised'])
  assert.deepEqual(Array.from(h.store.promptQueue.value, item => item.text), ['remote queued', 'local queued'])
})

for (const [label, overrides] of [
  ['abort rejected', { abort: async () => ({ success: false, error: 'cannot abort' }) }],
  ['process exits', { abort: async () => { throw new Error('pi exited before responding') } }],
  ['queue clear rejected', { clear_queue: async () => ({ success: false, error: 'cannot clear queue' }) }],
  ['still running', { get_state: async () => ({ success: true, data: { isStreaming: true } }) }],
  ['different session', { get_state: async () => ({ success: true, data: { sessionFile: 'other.jsonl' } }) }],
]) {
  test(`${label}: does not resend or erase the current conversation`, async () => {
    const h = harness(overrides)
    h.store.isStreaming.value = true
    await assert.rejects(h.store.resendPrompt('revised'))
    assert.equal(h.calls.some(call => call.type === 'prompt'), false)
    assert.equal(h.store.entries.value.length, 1)
    assert.equal(h.store.sessionFile.value, 'current.jsonl')
    assert.equal(h.store.isResending.value, false)
  })
}

test('idle conversation resends without abort; empty text is ignored unless images are present', async () => {
  const h = harness()
  await h.store.resendPrompt('   ')
  assert.equal(h.calls.length, 0)
  await h.store.resendPrompt('', [{ data: 'YWJj', mimeType: 'image/png' }])
  assert.deepEqual(h.calls.slice(0, 2).map(call => call.type), ['get_state', 'prompt'])
})

test('duplicate clicks and a session switch during abort never submit a second question', async () => {
  let finishAbort
  const h = harness({ abort: () => new Promise(resolve => { finishAbort = resolve }) })
  h.store.isStreaming.value = true
  const pending = h.store.resendPrompt('revised')
  await tick()
  await h.store.resendPrompt('duplicate')
  h.store.clear()
  h.store.sessionFile.value = 'other.jsonl'
  finishAbort({ success: true })
  await assert.rejects(pending, /editSessionChanged/)
  assert.equal(h.calls.some(call => call.type === 'prompt'), false)
  assert.equal(h.store.isResending.value, false)
})

test('late rejection of the interrupted prompt cannot fail the replacement run', async () => {
  let rejectOld
  let promptCount = 0
  const h = harness({ prompt: () => ++promptCount === 1
    ? new Promise((_, reject) => { rejectOld = reject }) : Promise.resolve({ success: true }) })
  await h.store.send('old')
  await h.store.resendPrompt('revised')
  rejectOld(new Error('old run aborted'))
  await tick()
  assert.equal(h.store.isStreaming.value, true)
  assert.equal(h.store.entries.value.at(-1).text, 'revised')
})

test('edit UI allows a running answer and preserves the draft when stopping fails', () => {
  const chat = source('../src/components/ChatView.vue')
  const edit = chat.slice(chat.indexOf('// Resend the edited question'), chat.indexOf('// ---- settings / export / copy ----'))
  assert.doesNotMatch(edit, /session\.isStreaming|session\.isCompacting|pendingCount|type: "fork"|session\.clear\(/)
  assert.match(edit, /await session\.resendPrompt[\s\S]*editedPrompt\.value = null[\s\S]*catch/)
  const app = source('../src/App.vue')
  const reload = app.slice(app.indexOf('async function reloadExternalConversation'), app.indexOf('async function selectProject'))
  assert.equal((reload.match(/owner\.isResending/g) ?? []).length, 2)
})

test('only the latest question offers inline editing, and stale edits cannot be resent', () => {
  const chat = source('../src/components/ChatView.vue')
  assert.match(chat, /const lastUserPromptId = computed\(\(\) => \{[\s\S]*session\.entries\[i\]\?\.kind === "user"/)
  assert.match(chat, /v-if="entry\.id === lastUserPromptId && editedPrompt\?\.id !== entry\.id"[^>]*@click="startEditPrompt\(entry\)"/)
  assert.match(chat, /if \(editBlocked\.value \|\| entry\.id !== lastUserPromptId\.value\) return/)
  assert.match(chat, /if \(!entry \|\| entry\.id !== lastUserPromptId\.value \|\| editBlocked\.value/)
  assert.match(chat, /v-if="editedPrompt\?\.id === entry\.id"[\s\S]*<Textarea[\s\S]*v-model="editedText"/)
  assert.doesNotMatch(chat, /<Dialog :open="editedPrompt !== null"/)
})

test('starting a new session while aborting releases the resend lock without sending', async () => {
  let finishAbort
  const h = harness({ abort: () => new Promise(resolve => { finishAbort = resolve }) })
  h.store.isStreaming.value = true
  const pending = h.store.resendPrompt('revised')
  await tick()
  await h.store.newSession()
  finishAbort({ success: true })
  await assert.rejects(pending, /editSessionChanged/)
  assert.equal(h.store.isResending.value, false)
  assert.equal(h.calls.some(call => call.type === 'prompt'), false)
})
