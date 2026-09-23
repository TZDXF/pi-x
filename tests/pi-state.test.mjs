import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness(storage = new Map()) {
  const calls = []
  const state = { model: { provider: 'restored', id: 'session-model', reasoning: true }, thinkingLevel: 'low' }
  const modules = {
    pinia: { defineStore: (_, setup) => setup },
    vue: { ref: value => ({ value }), shallowRef: value => ({ value }), computed: get => ({ get value() { return get() } }) },
    '@/stores/sessionRunStatus': { setSessionRunStatus() {} },
    '@/i18n': { i18n: { global: { t: key => key } } },
    '@/stores/workspace': { useWorkspaceStore: () => ({}) },
    '@/api/piClient': {
      getModelsConfig: async () => ({ providers: { pi: { models: [{ id: 'default', reasoning: true }] } } }),
      getPiSettings: async () => ({ defaultProvider: 'pi', defaultModel: 'default', defaultThinkingLevel: 'high', skills: [] }),
      rpcRequest: async command => {
        calls.push(command)
        if (command.type === 'set_model') state.model = { provider: command.provider, id: command.modelId }
        if (command.type === 'set_thinking_level') state.thinkingLevel = command.level
        const data = command.type === 'get_state' ? state
          : command.type === 'get_available_models' ? { models: [] }
          : command.type === 'get_available_thinking_levels' ? { levels: ['off', 'low', 'high'] }
          : command.type === 'get_commands' ? { commands: [] } : {}
        return { success: true, data }
      },
    },
  }
  const context = vm.createContext({ exports: {}, require: id => modules[id], console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  })
  const source = readFileSync(new URL('../src/stores/session.ts', import.meta.url), 'utf8')
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  return { store: context.exports.createSessionStore('default')(), calls, state, storage }
}

test('Pi defaults are displayed offline but never overwrite a restored session', async () => {
  const { store, calls, state } = harness()
  await store.loadOfflineModels()
  assert.equal(store.offlineDefaultModelKey.value, 'pi/default')
  assert.equal(store.desiredModelKey.value, null)
  assert.equal(store.desiredThinkingLevel.value, null)
  await store.init('project')
  assert.equal(state.model.provider, 'restored')
  assert.equal(state.thinkingLevel, 'low')
  assert.equal(calls.some(c => c.type === 'set_model' || c.type === 'set_thinking_level'), false)
})

test('explicit choices persist for fresh conversations but never overwrite restored sessions', async () => {
  const { store, calls } = harness()
  store.setDesiredModel('chosen/vendor/model')
  store.setDesiredThinkingLevel('high')
  await store.init('project', true)
  assert.equal(calls.filter(c => c.type === 'set_model').length, 1)
  assert.equal(calls.find(c => c.type === 'set_model').modelId, 'vendor/model')
  assert.equal(calls.filter(c => c.type === 'set_thinking_level').length, 1)
  assert.equal(store.desiredModelKey.value, null)
  assert.equal(store.desiredThinkingLevel.value, null)
  await store.init('other-project')
  assert.equal(calls.filter(c => c.type === 'set_model').length, 1)
  assert.equal(calls.filter(c => c.type === 'set_thinking_level').length, 1)
})


test('model and thinking selection survive restarting the UI and are visible before Pi starts', async () => {
  const storage = new Map()
  const first = harness(storage)
  await first.store.setModel('chosen', 'vendor/model')
  await first.store.setThinkingLevel('high')
  const next = harness(storage)
  assert.equal(next.store.offlineDefaultModelKey.value, 'chosen/vendor/model')
  assert.equal(next.store.thinkingLevel.value, 'high')
  assert.equal(next.store.models.value[0].id, 'vendor/model')
  await next.store.loadOfflineModels()
  assert.ok(next.store.models.value.some(m => m.id === 'vendor/model'))
  await next.store.init('new-project', true)
  assert.equal(next.state.model.provider, 'chosen')
  assert.equal(next.state.thinkingLevel, 'high')
})

test('new_session reapplies remembered choices without changing a resumed session first', async () => {
  const storage = new Map()
  const first = harness(storage)
  await first.store.setModel('chosen', 'vendor/model')
  await first.store.setThinkingLevel('high')
  const next = harness(storage)
  await next.store.init('resumed-project')
  assert.equal(next.state.model.provider, 'restored')
  assert.equal(next.state.thinkingLevel, 'low')
  await next.store.newSession()
  assert.equal(next.state.model.provider, 'chosen')
  assert.equal(next.state.thinkingLevel, 'high')
})

test('corrupt browser preference does not block loading Pi defaults', async () => {
  const h = harness(new Map([['pix.conversationSelection', '{bad']]))
  await h.store.loadOfflineModels()
  assert.equal(h.store.offlineDefaultModelKey.value, 'pi/default')
})
