import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

test("remote password gate applies only outside desktop and Vite development previews", () => {
  const source = readFileSync(new URL("../src/components/RemoteEntry.vue", import.meta.url), "utf8")
  expect(source).toMatch(/const bypassAuth = isDesktop \|\| import\.meta\.env\.DEV/)
  expect(source).toMatch(/const authenticated = ref\(bypassAuth\)/)
})
