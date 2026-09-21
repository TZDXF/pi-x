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
  vm.runInContext(ts.transpile(source + '\nglobalThis.api = { models, modelKey, enabled, save, followMain, defaultKey, defaultFollowMain };', { target: ts.ScriptTarget.ES2022 }), context)
  return { api: context.api, mount: () => mount(), config: () => config, setConfig: value => { config = value } }
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
test('following the main model saves the flag and keeps the custom choice for toggling back', async () => {
  const h = harness([], {}, { provider: 'saved', modelId: 'model' })
  await h.mount()
  h.api.followMain.value = true
  h.api.defaultKey.value = 'openrouter/vendor/model'
  await h.api.save()
  assert.equal(h.config().titleFollowMain, true)
  assert.equal(h.config().defaultModel.provider, 'openrouter')
  assert.equal(h.config().defaultModel.modelId, 'vendor/model')
  assert.equal(h.config().titleModel.provider, 'saved')
})

test('default model alone saves without enabling title generation', async () => {
  const h = harness()
  await h.mount()
  h.api.defaultKey.value = 'anthropic/claude'
  await h.api.save()
  assert.equal(h.config().defaultModel.provider, 'anthropic')
  assert.equal(h.config().defaultModel.modelId, 'claude')
  assert.equal(h.config().titleModel, undefined)
  assert.equal(h.config().titleFollowMain, undefined)
})

test('a saved follow-main configuration reloads as enabled with the default model', async () => {
  const source = readFileSync(new URL('../src/components/TitleModelSettings.vue', import.meta.url), 'utf8')
  assert.ok(source.includes('titleFollowMain'))
  const h = harness([], { one: { models: [{ id: 'm' }] } })
  // Simulate stored config by pre-seeding the harness config object.
  await h.mount()
  h.api.enabled.value = true
  h.api.followMain.value = true
  await h.api.save()
  const h2 = harness([], { one: { models: [{ id: 'm' }] } }, undefined)
  h2.setConfig(h.config())
  await h2.mount()
  assert.equal(h2.api.enabled.value, true)
  assert.equal(h2.api.followMain.value, true)
})


test('default model follows main when no override is configured', async () => {
  const h = harness()
  await h.mount()
  assert.equal(h.api.defaultFollowMain.value, true)
  await h.api.save()
  assert.equal(h.config().defaultModel, undefined)
})

test('following main clears the default override and preserves unrelated settings', async () => {
  const h = harness()
  h.setConfig({ defaultModel: { provider: 'one', modelId: 'model' }, unrelated: 'keep' })
  await h.mount()
  assert.equal(h.api.defaultFollowMain.value, false)
  h.api.defaultFollowMain.value = true
  await h.api.save()
  assert.equal(h.config().defaultModel, undefined)
  assert.equal(h.config().unrelated, 'keep')
  h.api.defaultFollowMain.value = false
  await h.api.save()
  assert.equal(h.config().defaultModel.provider, 'one')
  const reloaded = harness()
  reloaded.setConfig(h.config())
  await reloaded.mount()
  assert.equal(reloaded.api.defaultFollowMain.value, false)
  assert.equal(reloaded.api.defaultKey.value, 'one/model')
})
