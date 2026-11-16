import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/lib/developerMode.ts", import.meta.url), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/export /g, "")

function harness(preferences: Record<string, string> = {}) {
  const context = vm.createContext({
    ref: (value: unknown) => ({ value }),
    readonly: (value: unknown) => value,
    localStorage: { getItem: () => null, removeItem() {} },
    createConfigPreference: (options: {
      key: string
      read: (raw: string | null) => boolean
      serialize: (value: boolean) => string
    }) => {
      const state = { value: options.read(preferences[options.key] ?? null) }
      return {
        value: state,
        read: () => options.read(preferences[options.key] ?? null),
        set: (value: boolean) => {
          preferences[options.key] = options.serialize(value)
          state.value = options.read(preferences[options.key]!)
        },
      }
    },
  })
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.api = { developerModeEnabled, isDeveloperModeEnabled, setDeveloperMode };", {
      target: ts.ScriptTarget.ES2022,
    }),
    context,
  )
  return { api: context.api, preferences }
}

test("developer mode defaults to off and persists through the config preference", () => {
  const first = harness()
  expect(first.api.developerModeEnabled.value).toBe(false)
  expect(first.api.isDeveloperModeEnabled()).toBe(false)

  first.api.setDeveloperMode(true)
  expect(first.api.developerModeEnabled.value).toBe(true)
  expect(first.preferences.developerMode).toBe("1")

  const reloaded = harness(first.preferences)
  expect(reloaded.api.developerModeEnabled.value).toBe(true)
  expect(reloaded.api.isDeveloperModeEnabled()).toBe(true)

  reloaded.api.setDeveloperMode(false)
  expect(reloaded.preferences.developerMode).toBe("0")
})

test("corrupted stored values fall back to off", () => {
  const mod = harness({ developerMode: "yes" })
  expect(mod.api.developerModeEnabled.value).toBe(false)
})
