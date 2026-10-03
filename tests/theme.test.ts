import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/lib/theme.ts", import.meta.url), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/if \(import\.meta\.hot\) \{[\s\S]*$/, "")
  .replace(/export /g, "")
const readThemeCss = (file: string) => readFileSync(new URL(`../src/styles/theme/${file}`, import.meta.url), "utf8")

function harness(stored: string | null, storageFails = false) {
  const classes = new Set<string>()
  let value = stored
  const listeners: Record<string, (event: { key: string | null }) => void> = {}
  const context = vm.createContext({
    ref: (initial: unknown) => ({ value: initial }),
    readonly: (subject: unknown) => subject,
    localStorage: {
      getItem: () => {
        if (storageFails) throw Error("blocked")
        return value
      },
      setItem: (_: unknown, next: string) => {
        if (storageFails) throw Error("blocked")
        value = next
      },
    },
    document: {
      documentElement: {
        classList: {
          toggle: (name: string, on: boolean) => {
            if (on) classes.add(name)
            else classes.delete(name)
          },
        },
      },
    },
    window: {
      addEventListener: (_: string, fn: (event: { key: string | null }) => void) => {
        listeners.storage = fn
      },
      removeEventListener: () => {},
    },
  })
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.api = { theme, setTheme };", {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    }),
    context,
  )
  const api = context.api as { theme: { value: string }; setTheme: (value: unknown) => void }
  return {
    ...api,
    classes: () => [...classes].sort(),
    stored: () => value,
    storage: (next: string | null) => {
      value = next
      listeners.storage!({ key: "pix.theme" })
    },
  }
}

test("system preference and unusable storage leave the class to CSS", () => {
  for (const stored of [null, "invalid", "system"]) {
    const h = harness(stored)
    expect(h.theme.value).toBe("system")
    expect(h.classes()).toEqual([])
  }
})
test("an explicit preference writes only its own class and persists", () => {
  const h = harness(null)
  h.setTheme("dark")
  expect(h.classes()).toEqual(["dark"])
  expect(h.stored()).toBe("dark")
  h.setTheme("light")
  expect(h.classes()).toEqual(["light"])
  expect(h.stored()).toBe("light")
  h.setTheme("system")
  expect(h.classes()).toEqual([])
  expect(h.stored()).toBe("system")
})
test("a stored explicit preference is restored on load", () => {
  expect(harness("dark").classes()).toEqual(["dark"])
  expect(harness("light").classes()).toEqual(["light"])
})
test("unavailable storage does not prevent switching", () => {
  const h = harness(null, true)
  h.setTheme("light")
  expect(h.classes()).toEqual(["light"])
})
test("other windows synchronize preferences; invalid input is ignored", () => {
  const h = harness("dark")
  h.storage("light")
  expect(h.theme.value).toBe("light")
  expect(h.classes()).toEqual(["light"])
  h.setTheme("invalid")
  expect(h.theme.value).toBe("light")
  h.storage(null)
  expect(h.classes()).toEqual([])
})

// First paint depends on these rules alone: nothing runs before them to pick a
// theme. The variant needs both sources, and an explicit light choice has to
// beat the system-dark media query.
test("styles cover both theme sources for Tailwind's dark variant", () => {
  const tokens = readThemeCss("tokens.css")
  expect(tokens).toContain("@media (prefers-color-scheme: dark)")
  expect(tokens).toContain("&:not(.light *)")
  expect(tokens).toContain("&:is(.dark *)")
  const dark = readThemeCss("dark.css")
  expect(dark).toContain("@media (prefers-color-scheme: dark)")
  expect(dark).toContain(":root.dark")
  expect(readThemeCss("light.css")).toContain(":root.light")
})
test("dark tokens stay identical across the media query and the class", () => {
  const css = readThemeCss("dark.css")
  const declarations = (block: string) =>
    Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]!.trim()]))
  const media = declarations(css.slice(0, css.lastIndexOf(":root.dark")))
  const explicit = declarations(css.slice(css.lastIndexOf(":root.dark")))
  expect(Object.keys(explicit).length).toBeGreaterThan(20)
  expect(media).toEqual(explicit)
})
