import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness() {
  const statuses = new Map()
  const source = readFileSync(new URL('../src/stores/session.ts', import.meta.url), 'utf8')
  const modules = {
    pinia: { defineStore: (_, setup) => setup },
    vue: { ref: value => ({ value }), shallowRef: value => ({ value }), computed: get => ({ get value() { return get() } }) },
    '@/i18n': { i18n: { global: { t: key => key } } },
    '@/api/piClient': { rpcRequest: () => new Promise(() => {}) },
    '@/stores/workspace': { useWorkspaceStore: () => ({ histories: {}, projectName: () => 'project' }) },'@/lib/notifications': { notifyTurnComplete() {} },
    '@/stores/sessionRunStatus': { setSessionRunStatus: (file, status) => {
      if (status) statuses.set(file, status)
      else statuses.delete(file)
    } },
  }
  const context = vm.createContext({ exports: {}, console, localStorage: { getItem: () => null }, require: id => modules[id] })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  function session(id, file) {
    const store = context.exports.createSessionStore(id)()
    store.sessionFile.value = file
    return store
  }
  return { statuses, session }
}

test('concurrent sessions show independent running, completed and error statuses', () => {
  const { statuses, session } = harness()
  const first = session('first', 'first.jsonl')
  const second = session('second', 'second.jsonl')
  first.handleEvent({ type: 'agent_start' })
  second.handleEvent({ type: 'agent_start' })
  assert.equal(statuses.get('first.jsonl'), 'running')
  assert.equal(statuses.get('second.jsonl'), 'running')
  first.handleEvent({ type: 'agent_end' })
  assert.equal(statuses.get('first.jsonl'), 'completed')
  assert.equal(statuses.get('second.jsonl'), 'running')
  second.handleEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [] } })
  second.handleEvent({ type: 'agent_end' })
  assert.equal(statuses.get('second.jsonl'), 'error')
  second.handleEvent({ type: 'agent_start' })
  assert.equal(statuses.get('second.jsonl'), 'running')
  second.handleEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [] } })
  second.handleEvent({ type: 'auto_retry_end', success: true })
  second.handleEvent({ type: 'agent_end' })
  assert.equal(statuses.get('second.jsonl'), 'completed')
})

test('aborted turns clear status; unexpected process exit marks running turn as error', () => {
  const { statuses, session } = harness()
  const store = session('first', 'first.jsonl')
  store.handleEvent({ type: 'agent_start' })
  store.handleEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', content: [] } })
  store.handleEvent({ type: 'agent_end' })
  assert.equal(statuses.has('first.jsonl'), false)
  store.handleEvent({ type: 'agent_start' })
  store.markInterrupted()
  assert.equal(statuses.get('first.jsonl'), 'error')
})

test('viewing a session acknowledges terminal badges without clearing running or other sessions', () => {
  const source = readFileSync(new URL('../src/stores/sessionRunStatus.ts', import.meta.url), 'utf8')
  const context = vm.createContext({ exports: {}, require: () => ({ reactive: value => value }) })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  const { setSessionRunStatus: set, sessionRunStatus: get, acknowledgeSessionRunStatus: acknowledge } = context.exports
  for (const terminal of ['completed', 'error']) {
    set('project/first.jsonl', terminal)
    set('second.jsonl', terminal)
    acknowledge('project\\first.jsonl')
    assert.equal(get('project/first.jsonl'), undefined)
    assert.equal(get('second.jsonl'), terminal)
  }
  set('project/first.jsonl', 'running')
  acknowledge('project/first.jsonl')
  assert.equal(get('project/first.jsonl'), 'running')
  acknowledge(null)
  acknowledge('missing.jsonl')
  set('project/first.jsonl', 'completed')
  assert.equal(get('project/first.jsonl'), 'completed')
})

for (const success of [true, false]) {
  test(`retry backoff stays running until retry finishes (success=${success})`, () => {
    const { statuses, session } = harness()
    const store = session('retry', 'retry.jsonl')
    store.handleEvent({ type: 'agent_start' })
    store.handleEvent({ type: 'agent_end' })
    for (let attempt = 1; attempt <= 3; attempt++) {
      store.handleEvent({ type: 'auto_retry_start', attempt, maxAttempts: 3, errorMessage: '503' })
      assert.equal(store.isStreaming.value, true)
      assert.equal(statuses.get('retry.jsonl'), 'running')
      assert.match(store.retryInfo.value, /503/)
      store.handleEvent({ type: 'agent_start' })
      store.handleEvent({ type: 'agent_end' })
      assert.equal(store.isStreaming.value, true)
      assert.equal(statuses.get('retry.jsonl'), 'running')
    }
    store.handleEvent({ type: 'auto_retry_end', success })
    assert.equal(store.retryInfo.value, null)
    assert.equal(store.isStreaming.value, false)
    assert.equal(statuses.get('retry.jsonl'), success ? 'completed' : 'error')
  })
}

test('settled request clears retry loading even without retry_end', () => {
  const { statuses, session } = harness()
  const store = session('retry', 'retry.jsonl')
  store.handleEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 })
  store.handleEvent({ type: 'agent_settled' })
  assert.equal(store.retryInfo.value, null)
  assert.equal(store.isStreaming.value, false)
  assert.notEqual(statuses.get('retry.jsonl'), 'running')
})

test('sidebar shows session statuses on the left with animated running and semantic result colors', () => {
  const sidebar = readFileSync(new URL('../src/components/WorkspaceSidebar.vue', import.meta.url), 'utf8')
  const light = readFileSync(new URL('../src/styles/theme/light.css', import.meta.url), 'utf8')
  const dark = readFileSync(new URL('../src/styles/theme/dark.css', import.meta.url), 'utf8')
  const row = sidebar.match(/<div v-for="s in rows\(path\)"[\s\S]*?<div class="session-actions/)?.[0]
  assert.ok(row, 'session row is present')
  assert.ok(row.indexOf('class="session-status') < row.indexOf('variant="session-link"'), 'status precedes the title')
  assert.match(row, /class="session-status absolute left-\[7px\] top-1\/2/)
  assert.doesNotMatch(row, /session-status group-hover\/session:invisible/)
  assert.match(sidebar, /animation: session-status-spin 1s linear infinite/)
  assert.match(sidebar, /@keyframes session-status-spin/)
  assert.match(sidebar, /\.session-status-completed \{\s*color: var\(--success\)/)
  assert.match(sidebar, /\.session-status-error \{\s*color: var\(--destructive\)/)
  for (const theme of [light, dark]) assert.match(theme, /--success: #[0-9a-f]{6}/)
})

test('queued prompts show a left-hand clock without a count and hover for the live countdown', () => {
  const sidebar = readFileSync(new URL('../src/components/WorkspaceSidebar.vue', import.meta.url), 'utf8')
  const pending = sidebar.match(/<div v-for="pending in pendingRows\(path\)"[\s\S]*?<\/div>/)?.[0]
  const saved = sidebar.match(/<div v-for="s in rows\(path\)"[\s\S]*?<div class="session-actions/)?.[0]
  assert.ok(pending && saved)
  assert.match(pending, /session-queue-status absolute left-\[7px\]/)
  assert.match(saved, /session-queue-status absolute top-1\/2/)
  assert.match(saved, /sessionRunStatus\(s.file\) \? 'left-\[23px\]' : 'left-\[7px\]'/)
  assert.match(saved, /'pl-11': !!\(sessionRunStatus\(s.file\)/)
  for (const row of [pending, saved]) {
    assert.ok(row.indexOf('session-queue-status') < row.indexOf('variant="session-link"'))
    assert.doesNotMatch(row, /\{\{ (?:pending|findConversation\(s.file\)\?)\.promptQueue.length \}\}/)
    assert.match(row, /:title="queueTitle\(/)
  }
  assert.match(sidebar, /sendCountdown\(nextSendAt, queueNow.value\)/)
  assert.match(sidebar, /setInterval\(\(\) => \{ queueNow.value = Date.now\(\) \}, 1000\)/)
})
