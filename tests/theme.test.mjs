import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const bootstrap = readFileSync(new URL("../public/theme-init.js", import.meta.url), "utf8")
const source = readFileSync(new URL("../src/lib/theme.ts", import.meta.url), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/if \(import\.meta\.hot\) \{[\s\S]*$/, "")
  .replace(/export /g, "")
function harness(stored, matches = false, storageFails = false) {
  let dark = true
  let value = stored
  const listeners = {}
  const media = {
    matches,
    addEventListener: (_, fn) => {
      listeners.system = fn
    },
  }
  const context = vm.createContext({
    ref: value => ({ value }),
    readonly: value => value,
    localStorage: {
      getItem: () => {
        if (storageFails) throw Error("blocked")
        return value
      },
      setItem: (_, next) => {
        if (storageFails) throw Error("blocked")
        value = next
      },
    },
    document: {
      documentElement: {
        classList: {
          toggle: (_, next) => {
            dark = next
          },
        },
      },
    },
    window: {
      matchMedia: () => media,
      addEventListener: (_, fn) => {
        listeners.storage = fn
      },
    },
  })
  vm.runInContext(bootstrap, context)
  const initialDark = dark
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.api = { theme, setTheme };", {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    }),
    context,
  )
  return {
    ...context.api,
    initialDark,
    dark: () => dark,
    stored: () => value,
    system: next => {
      media.matches = next
      listeners.system()
    },
    storage: next => {
      value = next
      listeners.storage({ key: "pix.theme" })
    },
  }
}

test("first paint and runtime agree for every preference and invalid storage", () => {
  for (const stored of [null, "invalid", "light", "dark", "system"]) {
    for (const system of [false, true]) {
      const h = harness(stored, system)
      const expected = stored === "system" ? system : stored !== "light"
      expect(h.initialDark).toBe(expected)
      expect(h.dark()).toBe(expected)
    }
  }
})
test("selection applies immediately, persists and restores", () => {
  const h = harness("dark")
  h.setTheme("light")
  expect(h.dark()).toBe(false)
  expect(h.stored()).toBe("light")
  expect(harness(h.stored()).dark()).toBe(false)
  h.setTheme("dark")
  expect(h.dark()).toBe(true)
})
test("system changes only affect system preference", () => {
  const h = harness("system")
  h.system(true)
  expect(h.dark()).toBe(true)
  h.system(false)
  expect(h.dark()).toBe(false)
  h.setTheme("light")
  h.system(true)
  expect(h.dark()).toBe(false)
})
test("unavailable storage does not prevent switching", () => {
  const h = harness(null, false, true)
  h.setTheme("light")
  expect(h.dark()).toBe(false)
})
test("other windows synchronize preferences; invalid input is ignored", () => {
  const h = harness("dark")
  h.storage("light")
  expect(h.theme.value).toBe("light")
  expect(h.dark()).toBe(false)
  h.setTheme("invalid")
  expect(h.theme.value).toBe("light")
  h.storage(null)
  expect(h.dark()).toBe(true)
})
