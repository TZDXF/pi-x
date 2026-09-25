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
