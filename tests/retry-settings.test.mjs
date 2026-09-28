import { test } from "node:test"
import assert from "node:assert/strict"
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
  assert.equal(h.api.loading.value, false)
  assert.equal(h.api.attempts.value, 5)
  assert.equal(h.api.draft.value, "5")
})

test("editing the count saves it and rejects input outside the allowed range", async () => {
  const h = harness()
  await h.mount()

  h.api.draft.value = "5"
  await h.api.commit()
  assert.deepEqual(h.patches, [{ maxRetries: 5 }])
  assert.equal(h.api.attempts.value, 5)
  assert.equal(h.toasts.at(-1)[1], "info")

  h.api.draft.value = "5"
  await h.api.commit()
  assert.equal(h.patches.length, 1, "an unchanged value does not write again")

  for (const value of ["-1", "2.5", "21", "abc", "", " "]) {
    h.api.draft.value = value
    await h.api.commit()
    assert.equal(h.patches.length, 1, `${JSON.stringify(value)} is not saved`)
    assert.equal(h.api.draft.value, "5", `${JSON.stringify(value)} falls back to the saved value`)
    assert.equal(h.toasts.at(-1)[1], "error")
  }
  assert.equal(h.api.attempts.value, 5)
})

test("a failed save reverts the value and the draft", async () => {
  const h = harness({ maxRetries: 5 })
  await h.mount()
  h.failWrite(true)
  h.api.draft.value = "0"
  await h.api.commit()
  assert.equal(h.api.attempts.value, 5)
  assert.equal(h.api.draft.value, "5")
  assert.deepEqual(h.patches, [])
  assert.equal(h.toasts.at(-1)[1], "error")
})

test("an older Pi without the retry block is reported instead of rendering the input", async () => {
  const h = harness(null)
  await h.mount()
  assert.equal(h.api.attempts.value, null)
  assert.equal(h.api.error.value, "")
})

test("load failures support retry", async () => {
  const h = harness()
  h.failRead(true)
  await h.mount()
  assert.match(h.api.error.value, /read failure/)
  h.failRead(false)
  await h.api.load()
  assert.equal(h.api.error.value, "")
  assert.equal(h.api.attempts.value, 3)
})

test("settings embeds retry controls in the general page", () => {
  const tabs = readFileSync(new URL("../src/components/settings/tabs.ts", import.meta.url), "utf8")
  const general = readFileSync(new URL("../src/components/settings/GeneralSettings.vue", import.meta.url), "utf8")
  assert.match(general, /<RetrySettings v-if="isDesktop" \/>/)
  assert.doesNotMatch(tabs, /id: "retry",/)
  const router = readFileSync(new URL("../src/lib/router.ts", import.meta.url), "utf8")
  assert.doesNotMatch(router, /"retry",/)
})
