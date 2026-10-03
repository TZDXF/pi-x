import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

function harness(retry = { maxRetries: 3 }) {
  const source = readFileSync(new URL("../src/components/settings/RetrySettings.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*$/gm, "")
  let mount,
    failRead = false,
    failWrite = false
  const patches = [],
    toasts = []
  const context = vm.createContext({
    ref: value => ({ value }),
    onMounted: fn => {
      mount = fn
    },
    useI18n: () => ({ t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
    useUiStore: () => ({ pushToast: (...args) => toasts.push(args) }),
    getPiSettings: async () => {
      if (failRead) throw new Error("read failure")
      return { retry }
    },
    savePiSettings: async patch => {
      if (failWrite) throw new Error("write failure")
      patches.push({ ...patch.retry })
    },
  })
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.api = { attempts, draft, loading, error, saving, load, commit };", {
      target: ts.ScriptTarget.ES2022,
    }),
    context,
  )
  return {
    api: context.api,
    mount: () => mount(),
    patches,
    toasts,
    failRead: value => {
      failRead = value
    },
    failWrite: value => {
      failWrite = value
    },
  }
}

test("load mirrors the retry count Pi resolves into the input", async () => {
  const h = harness({ maxRetries: 5 })
  await h.mount()
  expect(h.api.loading.value).toBe(false)
  expect(h.api.attempts.value).toBe(5)
  expect(h.api.draft.value).toBe("5")
})

test("editing the count saves it and rejects input outside the allowed range", async () => {
  const h = harness()
  await h.mount()

  h.api.draft.value = "5"
  await h.api.commit()
  expect(h.patches).toEqual([{ maxRetries: 5 }])
  expect(h.api.attempts.value).toBe(5)
  expect(h.toasts.at(-1)[1]).toBe("info")

  h.api.draft.value = "5"
  await h.api.commit()
  expect(h.patches.length, "an unchanged value does not write again").toBe(1)

  for (const value of ["-1", "2.5", "21", "abc", "", " "]) {
    h.api.draft.value = value
    await h.api.commit()
    expect(h.patches.length, `${JSON.stringify(value)} is not saved`).toBe(1)
    expect(h.api.draft.value, `${JSON.stringify(value)} falls back to the saved value`).toBe("5")
    expect(h.toasts.at(-1)[1]).toBe("error")
  }
  expect(h.api.attempts.value).toBe(5)
})

test("a failed save reverts the value and the draft", async () => {
  const h = harness({ maxRetries: 5 })
  await h.mount()
  h.failWrite(true)
  h.api.draft.value = "0"
  await h.api.commit()
  expect(h.api.attempts.value).toBe(5)
  expect(h.api.draft.value).toBe("5")
  expect(h.patches).toEqual([])
  expect(h.toasts.at(-1)[1]).toBe("error")
})

test("an older Pi without the retry block is reported instead of rendering the input", async () => {
  const h = harness(null)
  await h.mount()
  expect(h.api.attempts.value).toBe(null)
  expect(h.api.error.value).toBe("")
})

test("load failures support retry", async () => {
  const h = harness()
  h.failRead(true)
  await h.mount()
  expect(h.api.error.value).toMatch(/read failure/)
  h.failRead(false)
  await h.api.load()
  expect(h.api.error.value).toBe("")
  expect(h.api.attempts.value).toBe(3)
})

test("settings embeds retry controls in the run-config page", () => {
  const tabs = readFileSync(new URL("../src/components/settings/tabs.ts", import.meta.url), "utf8")
  const runConfig = readFileSync(new URL("../src/components/settings/RunConfigSettings.vue", import.meta.url), "utf8")
  expect(runConfig).toMatch(/<RetrySettings \/>/)
  expect(tabs).toMatch(/"run-config"/)
  expect(tabs).not.toMatch(/id: "retry",/)
  const router = readFileSync(new URL("../src/lib/router.ts", import.meta.url), "utf8")
  expect(router).not.toMatch(/"retry",/)
})
