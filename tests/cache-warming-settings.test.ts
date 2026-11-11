import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

function harness(initial = { cacheWarming: "idle", cacheWarmingModes: ["off", "streaming", "idle"] }) {
  const source = readFileSync(new URL("../src/components/settings/CacheWarmingSettings.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*$/gm, "")
  let mount
  let failRead = false
  let failWrite = false
  const settings = { ...initial }
  const patches = []
  const toasts = []
  const context = vm.createContext({
    ref: value => ({ value }),
    onMounted: fn => {
      mount = fn
    },
    useI18n: () => ({ t: key => key }),
    useUiStore: () => ({ pushToast: (...args) => toasts.push(args) }),
    getPiSettings: async () => {
      if (failRead) throw new Error("read failure")
      return settings
    },
    savePiSettings: async patch => {
      if (failWrite) throw new Error("write failure")
      patches.push(patch)
      Object.assign(settings, patch)
    },
  })
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.api = { mode, modes, loading, error, saving, load, commit };", {
      target: ts.ScriptTarget.ES2022,
    }),
    context,
  )
  return {
    api: context.api,
    mount: () => mount(),
    patches,
    settings,
    toasts,
    failRead: value => {
      failRead = value
    },
    failWrite: value => {
      failWrite = value
    },
  }
}

test("cache warming loads the modes supported by the installed Pi", async () => {
  const h = harness()
  await h.mount()
  expect(h.api.loading.value).toBe(false)
  expect(h.api.mode.value).toBe("idle")
  expect(h.api.modes.value).toEqual(["off", "streaming", "idle"])
})

test("cache warming saves a selected mode once and rejects values Pi does not support", async () => {
  const h = harness()
  await h.mount()
  await h.api.commit("streaming")
  expect(h.patches).toEqual([{ cacheWarming: "streaming" }])
  expect(h.settings.cacheWarming).toBe("streaming")
  expect(h.toasts.at(-1)).toEqual(["cacheWarming.saved", "info"])
  await h.api.commit("streaming")
  await h.api.commit("sometimes")
  expect(h.patches).toHaveLength(1)
})

test("cache warming restores the previous selection after a failed save", async () => {
  const h = harness()
  await h.mount()
  h.failWrite(true)
  await h.api.commit("off")
  expect(h.api.mode.value).toBe("idle")
  expect(h.settings.cacheWarming).toBe("idle")
  expect(h.patches).toEqual([])
  expect(h.api.saving.value).toBe(false)
  expect(h.toasts.at(-1)[1]).toBe("error")
})

test("older Pi versions expose only their supported cache warming controls", async () => {
  const h = harness({ cacheWarming: "streaming", cacheWarmingModes: ["off", "streaming"] })
  await h.mount()
  expect(h.api.mode.value).toBe("streaming")
  await h.api.commit("idle")
  expect(h.patches).toEqual([])

  const unsupported = harness({ cacheWarming: null, cacheWarmingModes: [] })
  await unsupported.mount()
  expect(unsupported.api.modes.value).toEqual([])
})

test("cache warming load failures support retry", async () => {
  const h = harness()
  h.failRead(true)
  await h.mount()
  expect(h.api.error.value).toMatch(/read failure/)
  h.failRead(false)
  await h.api.load()
  expect(h.api.error.value).toBe("")
  expect(h.api.mode.value).toBe("idle")
})

test("run configuration embeds cache warming and makes it searchable", () => {
  const page = readFileSync(new URL("../src/components/settings/RunConfigSettings.vue", import.meta.url), "utf8")
  const settings = readFileSync(new URL("../src/components/SettingsPage.vue", import.meta.url), "utf8")
  expect(page).toMatch(/<CacheWarmingSettings \/>/)
  expect(settings).toMatch(/"cacheWarming",/)
})
