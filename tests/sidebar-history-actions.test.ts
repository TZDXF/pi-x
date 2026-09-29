import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"

const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")

test("loading a saved conversation keeps unrelated sidebar actions enabled", () => {
  const sidebar = app.match(/<WorkspaceSidebar\b[\s\S]*?\/>/)?.[0]
  expect(sidebar, "workspace sidebar is mounted").toBeTruthy()
  const busy = sidebar.match(/:busy="([^"]+)"/)?.[1]
  expect(busy, "sidebar has a busy condition").toBeTruthy()
  const isBusy = ({ navigating = false, gitBusy = false, connecting = false, phase = "chat" } = {}) =>
    vm.runInNewContext(busy, { navigating, connecting, workspace: { gitBusy }, phase })

  expect(isBusy({ connecting: true }), "session history loading must not disable other actions").toBe(false)
  expect(isBusy({ navigating: true })).toBe(true)
  expect(isBusy({ gitBusy: true })).toBe(true)
  expect(isBusy({ phase: "trust" })).toBe(true)
  expect(sidebar).toMatch(/:navigation-busy="workspace\.gitBusy \|\| phase === 'trust'"/)
})
