import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

function harness(runtimeModels = [], custom = {}, saved) {
  const source = readFileSync(new URL("../src/components/settings/TitleModelSettings.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*$/gm, "")
  let mount,
    config = { titleModel: saved },
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
        "\nglobalThis.api = { models, modelKey, titleMode, save, defaultKey, defaultMode, canSave, load, loadError };",
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

test("title selector uses the conversation model list without appending duplicate custom models", async () => {
  const runtime = [{ provider: "one", id: "model", name: "Model" }]
  const h = harness(runtime, { one: { models: [{ id: "model" }, { id: "other" }] } })
  await h.mount()
  expect(h.api.models.value).toBe(runtime)
})
test("one selection saves both provider and full model ID without switching conversation model", async () => {
  const h = harness()
  await h.mount()
  h.api.titleMode.value = "specific"
  h.api.modelKey.value = "openrouter/vendor/model"
  await h.api.save()
  expect(h.config().titleModel.provider).toBe("openrouter")
  expect(h.config().titleModel.modelId).toBe("vendor/model")
})
test("settings without a running conversation use configured model names", async () => {
  const h = harness([], { custom: { models: [{ id: "small", name: "Small model" }] } })
  await h.mount()
  expect(h.api.models.value[0].name).toBe("Small model")
  expect(h.api.models.value[0].provider).toBe("custom")
})
test("a previously saved model remains visible when absent from the runtime list", async () => {
  const h = harness([], {}, { provider: "saved", modelId: "model" })
  await h.mount()
  expect(h.api.modelKey.value).toBe("saved/model")
  expect(h.api.models.value[0].id).toBe("model")
})
test("following the default model saves the flag and keeps the custom choice for toggling back", async () => {
  const h = harness([], {}, { provider: "saved", modelId: "model" })
  await h.mount()
  h.api.titleMode.value = "default"
  h.api.defaultKey.value = "openrouter/vendor/model"
  await h.api.save()
  expect(h.config().titleFollowMain).toBe(true)
  expect(h.config().defaultModel.provider).toBe("openrouter")
  expect(h.config().defaultModel.modelId).toBe("vendor/model")
  expect(h.config().titleModel.provider).toBe("saved")
})

test("default model alone saves without enabling title generation", async () => {
  const h = harness()
  await h.mount()
  h.api.defaultKey.value = "anthropic/claude"
  await h.api.save()
  expect(h.config().defaultModel.provider).toBe("anthropic")
  expect(h.config().defaultModel.modelId).toBe("claude")
  expect(h.config().titleModel).toBe(undefined)
  expect(h.config().titleFollowMain).toBe(undefined)
})

test("a saved follow-default configuration reloads as enabled with the default model", async () => {
  const source = readFileSync(new URL("../src/components/settings/TitleModelSettings.vue", import.meta.url), "utf8")
  expect(source.includes("titleFollowMain")).toBeTruthy()
  const h = harness([], { one: { models: [{ id: "m" }] } })
  // Simulate stored config by pre-seeding the harness config object.
  await h.mount()
  h.api.defaultKey.value = "one/m"
  h.api.titleMode.value = "default"
  await h.api.save()
  const h2 = harness([], { one: { models: [{ id: "m" }] } }, undefined)
  h2.setConfig(h.config())
  await h2.mount()
  expect(h2.api.titleMode.value).toBe("default")
  expect(h2.api.defaultMode.value).toBe("specific")
  expect(h2.api.defaultKey.value).toBe("one/m")
})

test("the default model stays unset until a specific model is chosen", async () => {
  const h = harness()
  await h.mount()
  expect(h.api.defaultMode.value).toBe("none")
  await h.api.save()
  expect(h.config().defaultModel).toBe(undefined)
})

test("unsetting the default model clears it and preserves unrelated settings", async () => {
  const h = harness()
  h.setConfig({ unrelated: "keep", defaultModel: { provider: "one", modelId: "model" } })
  await h.mount()
  expect(h.api.defaultMode.value).toBe("specific")
  h.api.defaultMode.value = "none"
  await h.api.save()
  expect(h.config().defaultModel).toBe(undefined)
  expect(h.config().unrelated).toBe("keep")
  h.api.defaultMode.value = "specific"
  await h.api.save()
  expect(h.config().defaultModel.provider).toBe("one")
  const reloaded = harness()
  reloaded.setConfig(h.config())
  await reloaded.mount()
  expect(reloaded.api.defaultMode.value).toBe("specific")
  expect(reloaded.api.defaultKey.value).toBe("one/model")
})

test("specific default model requires a selection and never silently clears the override", async () => {
  const h = harness()
  await h.mount()
  h.api.defaultMode.value = "specific"
  expect(h.api.canSave.value).toBe(false)
  await h.api.save()
  expect(h.saves()).toBe(0)
  h.api.defaultKey.value = "openrouter/vendor/model"
  expect(h.api.canSave.value).toBe(true)
  await h.api.save()
  expect(h.config().defaultModel.modelId).toBe("vendor/model")
})

test("specific title model requires a selection; switching modes keeps the pending selection", async () => {
  const h = harness()
  await h.mount()
  h.api.titleMode.value = "specific"
  expect(h.api.canSave.value).toBe(false)
  await h.api.save()
  expect(h.saves()).toBe(0)
  h.api.modelKey.value = "one/model"
  h.api.defaultKey.value = "two/default"
  h.api.titleMode.value = "default"
  await h.api.save()
  expect(h.config().titleModel.modelId).toBe("model")
  h.api.titleMode.value = "specific"
  expect(h.api.modelKey.value).toBe("one/model")
})

test("disabled title generation clears both title settings without changing the default model", async () => {
  const h = harness()
  h.setConfig({
    titleModel: { provider: "one", modelId: "title" },
    defaultModel: { provider: "two", modelId: "default" },
  })
  await h.mount()
  h.api.titleMode.value = "off"
  await h.api.save()
  expect(h.config().titleModel).toBe(undefined)
  expect(h.config().titleFollowMain).toBe(undefined)
  expect(h.config().defaultModel.modelId).toBe("default")
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
  expect(h.api.canSave.value).toBe(true)
})

test("duplicate saved selections are only appended once to the runtime model list", async () => {
  const h = harness([{ provider: "one", id: "other" }])
  h.setConfig({
    titleModel: { provider: "one", modelId: "missing" },
    defaultModel: { provider: "one", modelId: "missing" },
  })
  await h.mount()
  expect(h.api.models.value.length).toBe(2)
})

test("following an unset default model cannot be saved as a title strategy", async () => {
  const h = harness()
  await h.mount()
  h.api.titleMode.value = "default"
  expect(h.api.canSave.value).toBe(false)
  await h.api.save()
  expect(h.saves()).toBe(0)
  h.api.defaultKey.value = "one/model"
  expect(h.api.canSave.value).toBe(true)
})
