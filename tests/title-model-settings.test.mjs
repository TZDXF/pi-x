import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness(runtimeModels = [], custom = {}, saved) {
  const source = readFileSync(new URL('../src/components/TitleModelSettings.vue', import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm, '')
  let mount, config = { titleModel: saved }
  const context = vm.createContext({
    ref: value => ({ value }),
    computed: definition => ({ get value() { return typeof definition === 'function' ? definition() : definition.get() }, set value(v) { definition.set(v) } }),
    onMounted: callback => { mount = callback },
    useI18n: () => ({ t: key => key }), useUiStore: () => ({ pushToast() {} }),
    useSessionStore: () => ({ models: runtimeModels }),
    getConfig: async () => config, saveConfig: async value => { config = value },
    getModelsConfig: async () => ({ providers: custom }),
  })
  vm.runInContext(ts.transpile(source + '\nglobalThis.api = { models, modelKey, enabled, save };', { target: ts.ScriptTarget.ES2022 }), context)
  return { api: context.api, mount: () => mount(), config: () => config }
}

test('title selector uses the conversation model list without appending duplicate custom models', async () => {
  const runtime = [{ provider: 'one', id: 'model', name: 'Model' }]
  const h = harness(runtime, { one: { models: [{ id: 'model' }, { id: 'other' }] } })
  await h.mount()
  assert.equal(h.api.models.value, runtime)
})
test('one selection saves both provider and full model ID without switching conversation model', async () => {
  const h = harness(); await h.mount()
  h.api.enabled.value = true; h.api.modelKey.value = 'openrouter/vendor/model'
  await h.api.save()
  assert.equal(h.config().titleModel.provider, 'openrouter')
  assert.equal(h.config().titleModel.modelId, 'vendor/model')
})
test('settings without a running conversation use configured model names', async () => {
  const h = harness([], { custom: { models: [{ id: 'small', name: 'Small model' }] } })
  await h.mount()
  assert.equal(h.api.models.value[0].name, 'Small model')
  assert.equal(h.api.models.value[0].provider, 'custom')
})
test('a previously saved model remains visible when absent from the runtime list', async () => {
  const h = harness([], {}, { provider: 'saved', modelId: 'model' }); await h.mount()
  assert.equal(h.api.modelKey.value, 'saved/model')
  assert.equal(h.api.models.value[0].id, 'model')
})
