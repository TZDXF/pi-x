import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

test("Windows toast disables system sound while keeping click activation", () => {
  const source = readFileSync("src-tauri/src/notifications.rs", "utf8")
  const toast = source.slice(source.indexOf("if let Err(e) = Toast::new"))
  expect(toast).toMatch(/\.sound\(None\)[\s\S]*\.show\(\)/)
  expect(toast).toContain(".on_activated(")
})
