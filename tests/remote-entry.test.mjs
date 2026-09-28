import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

test("remote password gate applies only outside desktop and Vite development previews", () => {
  const source = readFileSync(new URL("../src/components/RemoteEntry.vue", import.meta.url), "utf8")
  assert.match(source, /const bypassAuth = isDesktop \|\| import\.meta\.env\.DEV/)
  assert.match(source, /const authenticated = ref\(bypassAuth\)/)
})
