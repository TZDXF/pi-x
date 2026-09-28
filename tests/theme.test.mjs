import test from "node:test"
import assert from "node:assert/strict"
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
      assert.equal(h.initialDark, expected)
      assert.equal(h.dark(), expected)
    }
  }
})
test("selection applies immediately, persists and restores", () => {
  const h = harness("dark")
  h.setTheme("light")
  assert.equal(h.dark(), false)
  assert.equal(h.stored(), "light")
  assert.equal(harness(h.stored()).dark(), false)
  h.setTheme("dark")
  assert.equal(h.dark(), true)
})
test("system changes only affect system preference", () => {
  const h = harness("system")
  h.system(true)
  assert.equal(h.dark(), true)
  h.system(false)
  assert.equal(h.dark(), false)
  h.setTheme("light")
  h.system(true)
  assert.equal(h.dark(), false)
})
test("unavailable storage does not prevent switching", () => {
  const h = harness(null, false, true)
  h.setTheme("light")
  assert.equal(h.dark(), false)
})
test("other windows synchronize preferences; invalid input is ignored", () => {
  const h = harness("dark")
  h.storage("light")
  assert.equal(h.theme.value, "light")
  assert.equal(h.dark(), false)
  h.setTheme("invalid")
  assert.equal(h.theme.value, "light")
  h.storage(null)
  assert.equal(h.dark(), true)
})
