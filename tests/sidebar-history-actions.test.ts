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
  const navigationBusy = sidebar.match(/:navigation-busy="([^"]+)"/)?.[1]
  expect(navigationBusy, "sidebar has a navigation busy condition").toBeTruthy()
  const isNavigationBusy = ({ gitBusy = false, connecting = false, phase = "chat" } = {}) =>
    vm.runInNewContext(navigationBusy, { connecting, workspace: { gitBusy }, phase })

  expect(isNavigationBusy({ connecting: true })).toBe(false)
  expect(isNavigationBusy({ gitBusy: true, connecting: true }), "startup must keep sessions clickable").toBe(false)
  expect(isNavigationBusy({ gitBusy: true })).toBe(true)
  expect(isNavigationBusy({ connecting: true, phase: "trust" })).toBe(true)
})

test("sidebar does not reapply the startup Git lock to session navigation", () => {
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  const disabled = sidebar.match(/const navigationDisabled = computed<boolean>\(\(\) => ([^\n]+)\)/)?.[1]
  expect(disabled, "sidebar has a navigation disabled condition").toBeTruthy()
  const isDisabled = ({ navigationBusy = false, saving = false } = {}) =>
    vm.runInNewContext(disabled, { props: { navigationBusy }, workspace: { gitBusy: true }, saving: { value: saving } })

  expect(isDisabled(), "the parent allows queued navigation during startup").toBe(false)
  expect(isDisabled({ navigationBusy: true })).toBe(true)
  expect(isDisabled({ saving: true })).toBe(true)
})
