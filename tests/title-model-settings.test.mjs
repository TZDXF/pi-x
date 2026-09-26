import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness(runtimeModels = [], custom = {}, saved) {
  const source = readFileSync(new URL('../src/components/settings/TitleModelSettings.vue', import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm, '')
  let mount, config = { titleModel: saved }, configSaves = 0, loadFailure = false
  const context = vm.createContext({
    ref: value => ({ value }),
    computed: definition => ({ get value() { return typeof definition === 'function' ? definition() : definition.get() }, set value(v) { definition.set(v) } }),
    onMounted: callback => { mount = callback },
    useI18n: () => ({ t: key => key }), useUiStore: () => ({ pushToast() {} }),
    useSessionStore: () => ({ models: runtimeModels }),
    getConfig: async () => { if (loadFailure) throw new Error("load failed"); return config }, saveConfig: async value => { configSaves++; config = value },
    getModelsConfig: async () => ({ providers: custom }),
  })
  vm.runInContext(ts.transpile(source + '\nglobalThis.api = { models, modelKey, titleMode, save, defaultKey, defaultMode, canSave, load, loadError };', { target: ts.ScriptTarget.ES2022 }), context)
  return { api: context.api, mount: () => mount(), config: () => config, setConfig: value => { config = value }, saves: () => configSaves, failLoad: value => { loadFailure = value } }
}

test('title selector uses the conversation model list without appending duplicate custom models', async () => {
  const runtime = [{ provider: 'one', id: 'model', name: 'Model' }]
  const h = harness(runtime, { one: { models: [{ id: 'model' }, { id: 'other' }] } })
  await h.mount()
  assert.equal(h.api.models.value, runtime)
})
test('one selection saves both provider and full model ID without switching conversation model', async () => {
  const h = harness(); await h.mount()
  h.api.titleMode.value = "specific"; h.api.modelKey.value = 'openrouter/vendor/model'
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
test('following the default model saves the flag and keeps the custom choice for toggling back', async () => {
  const h = harness([], {}, { provider: 'saved', modelId: 'model' })
  await h.mount()
  h.api.titleMode.value = "default"
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

test('a saved follow-default configuration reloads as enabled with the default model', async () => {
  const source = readFileSync(new URL('../src/components/settings/TitleModelSettings.vue', import.meta.url), 'utf8')
  assert.ok(source.includes('titleFollowMain'))
  const h = harness([], { one: { models: [{ id: 'm' }] } })
  // Simulate stored config by pre-seeding the harness config object.
  await h.mount()
  h.api.defaultKey.value = 'one/m'
  h.api.titleMode.value = "default"
  await h.api.save()
  const h2 = harness([], { one: { models: [{ id: 'm' }] } }, undefined)
  h2.setConfig(h.config())
  await h2.mount()
  assert.equal(h2.api.titleMode.value, "default")
  assert.equal(h2.api.defaultMode.value, "specific")
  assert.equal(h2.api.defaultKey.value, 'one/m')
})


test('the default model stays unset until a specific model is chosen', async () => {
  const h = harness()
  await h.mount()
  assert.equal(h.api.defaultMode.value, "none")
  await h.api.save()
  assert.equal(h.config().defaultModel, undefined)
})

test('unsetting the default model clears it and preserves unrelated settings', async () => {
  const h = harness()
  h.setConfig({ unrelated: 'keep', defaultModel: { provider: 'one', modelId: 'model' } })
  await h.mount()
  assert.equal(h.api.defaultMode.value, "specific")
  h.api.defaultMode.value = "none"
  await h.api.save()
  assert.equal(h.config().defaultModel, undefined)
  assert.equal(h.config().unrelated, 'keep')
  h.api.defaultMode.value = "specific"
  await h.api.save()
  assert.equal(h.config().defaultModel.provider, 'one')
  const reloaded = harness()
  reloaded.setConfig(h.config())
  await reloaded.mount()
  assert.equal(reloaded.api.defaultMode.value, "specific")
  assert.equal(reloaded.api.defaultKey.value, 'one/model')
})


test('specific default model requires a selection and never silently clears the override', async () => {
  const h = harness(); await h.mount()
  h.api.defaultMode.value = 'specific'
  assert.equal(h.api.canSave.value, false)
  await h.api.save()
  assert.equal(h.saves(), 0)
  h.api.defaultKey.value = 'openrouter/vendor/model'
  assert.equal(h.api.canSave.value, true)
  await h.api.save()
  assert.equal(h.config().defaultModel.modelId, 'vendor/model')
})

test('specific title model requires a selection; switching modes keeps the pending selection', async () => {
  const h = harness(); await h.mount()
  h.api.titleMode.value = 'specific'
  assert.equal(h.api.canSave.value, false)
  await h.api.save()
  assert.equal(h.saves(), 0)
  h.api.modelKey.value = 'one/model'
  h.api.defaultKey.value = 'two/default'
  h.api.titleMode.value = 'default'
  await h.api.save()
  assert.equal(h.config().titleModel.modelId, 'model')
  h.api.titleMode.value = 'specific'
  assert.equal(h.api.modelKey.value, 'one/model')
})

test('disabled title generation clears both title settings without changing the default model', async () => {
  const h = harness()
  h.setConfig({ titleModel: { provider: 'one', modelId: 'title' }, defaultModel: { provider: 'two', modelId: 'default' } })
  await h.mount()
  h.api.titleMode.value = 'off'
  await h.api.save()
  assert.equal(h.config().titleModel, undefined)
  assert.equal(h.config().titleFollowMain, undefined)
  assert.equal(h.config().defaultModel.modelId, 'default')
})

test('load errors can be retried without saving incomplete settings', async () => {
  const h = harness()
  h.failLoad(true)
  await h.mount()
  assert.match(h.api.loadError.value, /load failed/)
  assert.equal(h.api.canSave.value, false)
  h.failLoad(false)
  await h.api.load()
  assert.equal(h.api.loadError.value, '')
  assert.equal(h.api.canSave.value, true)
})

test('duplicate saved selections are only appended once to the runtime model list', async () => {
  const h = harness([{ provider: 'one', id: 'other' }])
  h.setConfig({ titleModel: { provider: 'one', modelId: 'missing' }, defaultModel: { provider: 'one', modelId: 'missing' } })
  await h.mount()
  assert.equal(h.api.models.value.length, 2)
})


test('following an unset default model cannot be saved as a title strategy', async () => {
  const h = harness(); await h.mount()
  h.api.titleMode.value = 'default'
  assert.equal(h.api.canSave.value, false)
  await h.api.save()
  assert.equal(h.saves(), 0)
  h.api.defaultKey.value = 'one/model'
  assert.equal(h.api.canSave.value, true)
})