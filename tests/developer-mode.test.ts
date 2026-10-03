import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"

const source = readFileSync(new URL("../src/lib/developerMode.ts", import.meta.url), "utf8")
const js = ts
  .transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
  .replace('from "vue"', `from "${import.meta.resolve("vue")}"`)
const storage = new Map()
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
}
let sequence = 0
const load = () => import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}#${sequence++}`)

test("developer mode defaults to off and persists across reloads", async () => {
  const first = await load()
  expect(first.developerModeEnabled.value).toBe(false)
  expect(first.isDeveloperModeEnabled()).toBe(false)

  first.setDeveloperMode(true)
  expect(first.developerModeEnabled.value).toBe(true)
  expect(storage.get("pix.developerMode")).toBe("1")

  const reloaded = await load()
  expect(reloaded.developerModeEnabled.value).toBe(true)
  expect(reloaded.isDeveloperModeEnabled()).toBe(true)

  reloaded.setDeveloperMode(false)
  expect(storage.get("pix.developerMode")).toBe("0")
  const again = await load()
  expect(again.developerModeEnabled.value).toBe(false)
})

test("corrupted storage falls back to off", async () => {
  storage.set("pix.developerMode", "yes")
  const mod = await load()
  expect(mod.developerModeEnabled.value).toBe(false)
})
