import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"

const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")

test("loading a saved conversation keeps unrelated sidebar actions enabled", () => {
  const sidebar = app.match(/<WorkspaceSidebar\b[\s\S]*?\/>/)?.[0]
  assert.ok(sidebar, "workspace sidebar is mounted")
  const busy = sidebar.match(/:busy="([^"]+)"/)?.[1]
  assert.ok(busy, "sidebar has a busy condition")
  const isBusy = ({ navigating = false, gitBusy = false, connecting = false, phase = "chat" } = {}) =>
    vm.runInNewContext(busy, { navigating, connecting, workspace: { gitBusy }, phase })

  assert.equal(isBusy({ connecting: true }), false, "session history loading must not disable other actions")
  assert.equal(isBusy({ navigating: true }), true)
  assert.equal(isBusy({ gitBusy: true }), true)
  assert.equal(isBusy({ phase: "trust" }), true)
  assert.match(sidebar, /:navigation-busy="workspace\.gitBusy \|\| phase === 'trust'"/)
})
