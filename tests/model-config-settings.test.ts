import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

function harness(runtimeModels = [], custom = {}, saved = {}) {
  const source = readFileSync(new URL("../src/components/settings/ModelConfigSettings.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?from ".*"$/gm, "")
  let mount,
    config = saved,
    configSaves = 0,
    loadFailure = false
  const context = vm.createContext({
    ref: value => ({ value }),
    computed: definition => ({
      get value() {
        return typeof definition === "function" ? definition() : definition.get()
      },
      set value(v) {
        definition.set(v)
      },
    }),
    onMounted: callback => {
      mount = callback
    },
    useI18n: () => ({ t: key => key }),
    useUiStore: () => ({ pushToast() {} }),
    useSessionStore: () => ({ models: runtimeModels }),
    getConfig: async () => {
      if (loadFailure) throw new Error("load failed")
      return config
    },
    saveConfig: async value => {
      configSaves++
      config = value
    },
    getModelsConfig: async () => ({ providers: custom }),
  })
  vm.runInContext(
    ts.transpile(
      source +
        "\nglobalThis.api = { models, effectiveDefaultKey, defaultKey, titleChoice, translationChoice, canSave, save, load, loadError };",
      { target: ts.ScriptTarget.ES2022 },
    ),
    context,
  )
  return {
    api: context.api,
    mount: () => mount(),
    config: () => config,
    setConfig: value => {
      config = value
    },
    saves: () => configSaves,
    failLoad: value => {
      loadFailure = value
    },
  }
}

test("the model list uses the conversation models without appending duplicate custom models", async () => {
  const runtime = [{ provider: "one", id: "model", name: "Model" }]
  const h = harness(runtime, { one: { models: [{ id: "model" }, { id: "other" }] } })
  await h.mount()
  expect(h.api.models.value).toBe(runtime)
})

test("settings without a running conversation use configured model names", async () => {
  const h = harness([], { custom: { models: [{ id: "small", name: "Small model" }] } })
  await h.mount()
  expect(h.api.models.value[0].name).toBe("Small model")
  expect(h.api.models.value[0].provider).toBe("custom")
})

test("the default model falls back to the first available model and is saved on submit", async () => {
  const h = harness([{ provider: "one", id: "model" }])
  await h.mount()
  expect(h.api.effectiveDefaultKey.value).toBe("one/model")
  await h.api.save()
  expect(h.config().defaultModel).toEqual({ provider: "one", modelId: "model" })
  expect(h.config().titleModel).toBe(undefined)
  expect(h.config().titleFollowMain).toBe(undefined)
  expect(h.config().translationModel).toBe(undefined)
})

test("an explicit default selection overrides the first-model fallback and preserves unrelated settings", async () => {
  const h = harness([], { one: { models: [{ id: "a" }, { id: "b" }] } }, { unrelated: "keep" })
  await h.mount()
  expect(h.api.effectiveDefaultKey.value).toBe("one/a")
  h.api.defaultKey.value = "one/b"
  expect(h.api.effectiveDefaultKey.value).toBe("one/b")
  await h.api.save()
  expect(h.config().defaultModel.modelId).toBe("b")
  expect(h.config().unrelated).toBe("keep")
})

test("a previously saved default model stays visible when absent from the runtime list", async () => {
  const h = harness([], {}, { defaultModel: { provider: "saved", modelId: "model" } })
  await h.mount()
  expect(h.api.defaultKey.value).toBe("saved/model")
  expect(h.api.effectiveDefaultKey.value).toBe("saved/model")
  expect(h.api.models.value[0].id).toBe("model")
})

test("disabling title generation clears both title settings without changing the default model", async () => {
  const h = harness(
    [],
    {},
    {
      titleModel: { provider: "one", modelId: "title" },
      titleFollowMain: true,
      defaultModel: { provider: "two", modelId: "default" },
    },
  )
  await h.mount()
  expect(h.api.titleChoice.value).toBe("default")
  h.api.titleChoice.value = "off"
  await h.api.save()
  expect(h.config().titleModel).toBe(undefined)
  expect(h.config().titleFollowMain).toBe(undefined)
  expect(h.config().defaultModel.modelId).toBe("default")
})

test("following the default model saves the flag and the default model", async () => {
  const h = harness()
  await h.mount()
  h.api.defaultKey.value = "openrouter/vendor/model"
  h.api.titleChoice.value = "default"
  await h.api.save()
  expect(h.config().titleFollowMain).toBe(true)
  expect(h.config().titleModel).toBe(undefined)
  expect(h.config().defaultModel.provider).toBe("openrouter")
  expect(h.config().defaultModel.modelId).toBe("vendor/model")
})

test("a specific title model splits the provider from the full model id", async () => {
  const h = harness([], { openrouter: { models: [{ id: "vendor/model" }] } })
  await h.mount()
  h.api.titleChoice.value = "openrouter/vendor/model"
  await h.api.save()
  expect(h.config().titleModel.provider).toBe("openrouter")
  expect(h.config().titleModel.modelId).toBe("vendor/model")
  expect(h.config().titleFollowMain).toBe(undefined)
})

test("the translation model defaults to the default model unless a specific model is chosen", async () => {
  const h = harness([], { one: { models: [{ id: "m" }] } })
  await h.mount()
  expect(h.api.translationChoice.value).toBe("default")
  await h.api.save()
  expect(h.config().translationModel).toBe(undefined)
  h.api.translationChoice.value = "one/m"
  await h.api.save()
  expect(h.config().translationModel).toEqual({ provider: "one", modelId: "m" })
})

test("a saved configuration reloads with the same choices", async () => {
  const h = harness([], { one: { models: [{ id: "m" }] } })
  await h.mount()
  h.api.defaultKey.value = "one/m"
  h.api.titleChoice.value = "default"
  h.api.translationChoice.value = "one/m"
  await h.api.save()
  const h2 = harness([], { one: { models: [{ id: "m" }] } }, h.config())
  await h2.mount()
  expect(h2.api.defaultKey.value).toBe("one/m")
  expect(h2.api.titleChoice.value).toBe("default")
  expect(h2.api.translationChoice.value).toBe("one/m")
})

test("without any model the page cannot be saved", async () => {
  const h = harness()
  await h.mount()
  expect(h.api.effectiveDefaultKey.value).toBe("")
  expect(h.api.canSave.value).toBe(false)
  await h.api.save()
  expect(h.saves()).toBe(0)
})

test("duplicate saved selections are only appended once to the runtime model list", async () => {
  const h = harness([{ provider: "one", id: "other" }])
  h.setConfig({
    titleModel: { provider: "one", modelId: "missing" },
    defaultModel: { provider: "one", modelId: "missing" },
    translationModel: { provider: "one", modelId: "missing" },
  })
  await h.mount()
  expect(h.api.models.value.length).toBe(2)
})

test("load errors can be retried without saving incomplete settings", async () => {
  const h = harness()
  h.failLoad(true)
  await h.mount()
  expect(h.api.loadError.value).toMatch(/load failed/)
  expect(h.api.canSave.value).toBe(false)
  h.failLoad(false)
  await h.api.load()
  expect(h.api.loadError.value).toBe("")
  expect(h.api.canSave.value).toBe(false)
})
