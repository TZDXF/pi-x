import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

test("duplicate launches are intercepted before plugins and background services initialize", () => {
  const source = read("../src-tauri/src/lib.rs")
  const builder = source.slice(source.indexOf("tauri::Builder::default()"))
  const firstPlugin = builder.indexOf(".plugin(")

  expect(firstPlugin).toBeGreaterThan(-1)
  expect(builder.slice(firstPlugin)).toMatch(
    /^\.plugin\(tauri_plugin_single_instance::init\([\s\S]*?desktop::restore\(app\);[\s\S]*?\}\)\)/,
  )
  expect(firstPlugin).toBeLessThan(builder.indexOf(".manage("))
  expect(firstPlugin).toBeLessThan(builder.indexOf(".setup("))
})
