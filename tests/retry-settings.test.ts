import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

function harness(retry = { maxRetries: 3 }, running = []) {
  const source = readFileSync(new URL("../src/components/settings/RetrySettings.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*$/gm, "")
  let mount,
    failRead = false,
    failWrite = false
  const patches = [],
    settingPatches = [],
    toasts = []
  const settings = { retry: retry === null ? null : { ...retry }, compaction: { enabled: true } }
  const context = vm.createContext({
    ref: value => ({ value }),
    onMounted: fn => {
      mount = fn
    },
    useI18n: () => ({ t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
    useUiStore: () => ({ pushToast: (...args) => toasts.push(args) }),
    allConversations: () => running,
    getPiSettings: async () => {
      if (failRead) throw new Error("read failure")
      return settings
    },
    savePiSettings: async patch => {
      if (failWrite) throw new Error("write failure")
      settingPatches.push(JSON.parse(JSON.stringify(patch)))
      if (patch.retry) {
        patches.push({ ...patch.retry })
        settings.retry = { ...settings.retry, ...patch.retry }
      }
      if (patch.compaction) settings.compaction = { ...settings.compaction, ...patch.compaction }
    },
  })
  vm.runInContext(
    ts.transpile(
      source +
        "\nglobalThis.api = { attempts, draft, loading, error, saving, load, commit, autoRetry, autoCompaction, toggling, setAutoRetryEnabled, setAutoCompactionEnabled };",
      {
        target: ts.ScriptTarget.ES2022,
      },
    ),
    context,
  )
  return {
    api: context.api,
    mount: () => mount(),
    patches,
    settingPatches,
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

for (const kind of ["retry", "compaction"] as const) {
  const toggle = (h: ReturnType<typeof harness>, next: boolean) =>
    kind === "retry" ? h.api.setAutoRetryEnabled(next) : h.api.setAutoCompactionEnabled(next)
  const value = (h: ReturnType<typeof harness>) =>
    kind === "retry" ? h.api.autoRetry.value : h.api.autoCompaction.value

  test(`${kind} save failure restores the switch without syncing runtimes`, async () => {
    const calls: boolean[] = []
    const apply = async (next: boolean) => {
      calls.push(next)
    }
    const h = harness(undefined, [{ started: true, setAutoRetry: apply, setAutoCompaction: apply }])
    await h.mount()
    h.failWrite(true)
    await toggle(h, false)
    expect(value(h)).toBe(true)
    expect(h.settings[kind].enabled ?? true).toBe(true)
    expect(h.settingPatches).toEqual([])
    expect(calls).toEqual([])
    expect(h.api.toggling.value).toBeNull()
    expect(h.toasts.at(-1)[1]).toBe("error")
  })

  test(`${kind} keeps the saved value when every runtime fails and can be changed back`, async () => {
    const calls: boolean[] = []
    const apply = async (next: boolean) => {
      calls.push(next)
      throw Error("RPC disconnected")
    }
    const h = harness(undefined, [{ started: true, setAutoRetry: apply, setAutoCompaction: apply }])
    await h.mount()
    await toggle(h, false)
    expect(value(h)).toBe(false)
    expect(h.settings[kind].enabled).toBe(false)
    expect(h.settingPatches).toEqual([{ [kind]: { enabled: false } }])
    expect(h.toasts).toEqual([['retrySettings.partialSync {"count":1}', "warning"]])
    expect(h.api.toggling.value).toBeNull()
    await h.api.load()
    expect(value(h)).toBe(false)
    await toggle(h, true)
    expect(value(h)).toBe(true)
    expect(h.settings[kind].enabled).toBe(true)
    expect(calls).toEqual([false, true])
  })

  test(`${kind} warns on partial synchronization without claiming every runtime updated`, async () => {
    const calls: boolean[] = []
    const success = async (next: boolean) => {
      calls.push(next)
    }
    const failure = async () => {
      throw Error("runtime unavailable")
    }
    const h = harness(undefined, [
      { started: true, setAutoRetry: success, setAutoCompaction: success },
      { started: true, setAutoRetry: failure, setAutoCompaction: failure },
      { started: false, setAutoRetry: success, setAutoCompaction: success },
    ])
    await h.mount()
    await toggle(h, false)
    expect(value(h)).toBe(false)
    expect(h.settings[kind].enabled).toBe(false)
    expect(calls).toEqual([false])
    expect(h.toasts).toEqual([['retrySettings.partialSync {"count":1}', "warning"]])
  })

  test(`${kind} saves for new sessions even without a running conversation`, async () => {
    const h = harness()
    await h.mount()
    await toggle(h, false)
    expect(value(h)).toBe(false)
    expect(h.settings[kind].enabled).toBe(false)
    expect(h.toasts.at(-1)).toEqual(["retrySettings.runtimeSaved", "info"])
  })
}
