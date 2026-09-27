import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contentModule, loadTsModule } from './lib/load-ts.mjs'

function loadStore(name, modules) {
  const exports = loadTsModule(new URL(`../src/stores/${name}.ts`, import.meta.url), id => modules[id],
    { setTimeout, clearTimeout, console: { warn() {}, error() {} }, localStorage: { getItem: () => null } })
  // session.ts: factory (runtimeId => store); workspace.ts: plain store fn.
  const factory = exports.createSessionStore ?? exports.createUiStore
  const store = factory ? factory('default')() : Object.values(exports)[0]()
  return store
}
const framework = {
  pinia: { defineStore: (_, setup) => setup },
  vue: { ref: value => ({ value }), shallowRef: value => ({ value }), computed: get => ({ get value() { return get() } }), watch: (source, cb, options) => { if (options?.immediate) cb(typeof source === 'function' ? source() : source); return () => {} } },
}
function sessionHarness() {
  const calls = [], previews = [], titles = [], refreshed = []
  let finish, fail
  const api = {
    pixLog() {},
    rpcRequest: command => { calls.push(command); return new Promise(() => {}) },
    sessionMtime: async () => 12345,
    generateSessionTitle: (...args) => {
      calls.push({ type: 'title', args })
      return new Promise((resolve, reject) => { finish = resolve; fail = reject })
    },
  }
  const store = loadStore('session', { ...framework,
    '@/lib/checkpoints': { createCheckpoint: async () => ({ refName: 'r', commitOid: 'oid' }), diffCheckpoints: async () => [], loadCheckpointManifest: async () => null, saveCheckpointManifest: async () => {} }, '@/stores/sessionRunStatus': { setSessionRunStatus() {} }, '@/i18n': { i18n: { global: { t: key => key } } }, '@/lib/content': contentModule(), '@/api/piClient': { sessionHistory: async () => [], ...api }, '@/lib/notifications': { notifyTurnComplete() {} }, '@/stores/workspace': { useWorkspaceStore: () => ({ histories: {}, projectName: () => 'project',
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
  h.store.handleEvent({ type: 'agent_settled' })
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
  h.store.handleEvent({ type: 'agent_settled' })
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


test('delayed prompts wait until due and do not block ready prompts', async () => {
  const h = sessionHarness()
  h.store.schedulePrompt('later', 60_000)
  assert.equal(h.calls.length, 0)
  h.store.dispatchQueuedPrompt()
  assert.equal(h.calls.length, 0)
  h.store.isStreaming.value = true
  await h.store.send('ready', undefined, undefined, 'queue')
  h.store.isStreaming.value = false
  h.store.dispatchQueuedPrompt()
  assert.equal(h.calls.find(c => c.type === 'prompt').message, 'ready')
  assert.equal(h.store.promptQueue.value[0].text, 'later')
  h.store.clear()
})

test('delayed prompts automatically dispatch with images and expanded text', async () => {
  const h = sessionHarness()
  h.store.schedulePrompt('later', 10, [{ data: 'image', mimeType: 'image/png' }], 'expanded')
  await new Promise(resolve => setTimeout(resolve, 180))
  const prompt = h.calls.find(c => c.type === 'prompt')
  assert.equal(prompt.message, 'expanded')
  assert.equal(prompt.images[0].data, 'image')
  assert.equal(h.store.promptQueue.value.length, 0)
})

test('delayed prompts reject invalid delays and can be cancelled or executed early', () => {
  const h = sessionHarness()
  for (const delay of [0, -1, NaN, Infinity, 366 * 86400000]) {
    assert.throws(() => h.store.schedulePrompt('later', delay))
  }
  h.store.schedulePrompt('cancel', 60_000)
  h.store.removeQueuedPrompt(h.store.promptQueue.value[0].id)
  h.store.schedulePrompt('now', 60_000)
  h.store.executeQueuedPrompt(h.store.promptQueue.value[0].id)
  assert.equal(h.calls.find(c => c.type === 'prompt').message, 'now')
  assert.equal(h.store.promptQueue.value.length, 0)
})


test('a delayed prompt stays queued while busy and clear cancels its timer', async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  h.store.schedulePrompt('later', 10)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(h.calls.filter(c => c.type === 'prompt').length, 0)
  assert.equal(h.store.promptQueue.value.length, 1)
  h.store.clear()
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(h.calls.filter(c => c.type === 'prompt').length, 0)
})

test('a compact command queues behind the active run and executes on settle', async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  await h.store.send('/compact keep decisions', undefined, undefined, 'queue')
  assert.equal(h.calls.length, 0)
  assert.equal(h.store.promptQueue.value.length, 1)
  h.store.handleEvent({ type: 'agent_end' })
  h.store.handleEvent({ type: 'agent_settled' })
  const compact = h.calls.find(c => c.type === 'compact')
  assert.equal(compact.customInstructions, 'keep decisions')
  assert.equal(h.calls.filter(c => c.type === 'prompt').length, 0)
  assert.equal(h.store.promptQueue.value.length, 0)
  assert.equal(h.store.isCompacting.value, true)
})

test('a compact command never steers into the running agent', async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  await h.store.send('/compact', undefined, undefined, 'steer')
  assert.equal(h.calls.length, 0)
  assert.equal(h.store.promptQueue.value.map(item => item.text).join(','), '/compact')
})

test('queued prompts continue after a queued compact finishes', async () => {
  const h = sessionHarness()
  h.store.isStreaming.value = true
  await h.store.send('/compact', undefined, undefined, 'queue')
  await h.store.send('next question', undefined, undefined, 'queue')
  h.store.handleEvent({ type: 'agent_settled' })
  assert.equal(h.calls.filter(c => c.type === 'compact').length, 1)
  assert.equal(h.calls.filter(c => c.type === 'prompt').length, 0)
  assert.equal(h.store.promptQueue.value.length, 1)
  h.store.handleEvent({ type: 'compaction_end', result: null, aborted: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.calls.find(c => c.type === 'prompt').message, 'next question')
  assert.equal(h.store.promptQueue.value.length, 0)
})

test('compaction_end syncs the session file mtime so the watcher stays quiet', async () => {
  const h = sessionHarness()
  assert.equal(h.store.syncedSessionMtime.value, null)
  h.store.handleEvent({ type: 'compaction_end', result: null, aborted: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.store.syncedSessionMtime.value, 12345)
})

test('compaction_end appends a visible marker with token stats; aborted runs add none', async () => {
  const h = sessionHarness()
  h.store.handleEvent({ type: 'compaction_end', result: { summary: 'collapsed', tokensBefore: 100000, estimatedTokensAfter: 30000 } })
  const marker = h.store.entries.value.at(-1)
  assert.equal(marker.kind, 'compaction')
  assert.equal(marker.summary, 'collapsed')
  assert.equal(marker.tokensBefore, 100000)
  assert.equal(marker.tokensAfter, 30000)
  h.store.handleEvent({ type: 'compaction_end', result: null, aborted: true })
  assert.equal(h.store.entries.value.filter(e => e.kind === 'compaction').length, 1)
})


test('scheduled conversations render the submitted prompt and live output without sending it again', () => {
  const h = sessionHarness()
  h.store.handleEvent({ type: 'scheduled_session_created', prompt: 'Inspect the project' })
  assert.equal(h.store.entries.value[0].text, 'Inspect the project')
  assert.equal(h.store.isStreaming.value, true)
  assert.equal(h.calls.filter(c => c.type === 'prompt').length, 0)
  h.store.handleEvent({ type: 'agent_start' })
  h.store.handleEvent({ type: 'message_start', message: { role: 'assistant' } })
  h.store.handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
  h.store.handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Working' } })
  assert.equal(h.store.partialBlocks.value[0].text, 'Working')
  h.store.handleEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } })
  h.store.handleEvent({ type: 'agent_settled' })
  assert.equal(h.store.isStreaming.value, false)
  assert.equal(h.store.entries.value[1].blocks[0].text, 'Done')
})

test('scheduled preflight rejection releases the conversation for user continuation', () => {
  const h = sessionHarness()
  h.store.handleEvent({ type: 'scheduled_session_created', prompt: 'Inspect' })
  h.store.handleEvent({ type: 'scheduled_session_failed', error: 'Model unavailable' })
  assert.equal(h.store.isStreaming.value, false)
  assert.match(h.store.entries.value[1].blocks[0].text, /Model unavailable/)
})
