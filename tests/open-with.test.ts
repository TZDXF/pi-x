import { readFileSync } from "node:fs"
import { afterEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  desktop: true,
  invoke: async () => undefined,
  listen: async () => () => {},
}))

vi.mock("@/api/transport", () => ({
  get isDesktop() {
    return mocks.desktop
  },
  invoke: (command, args) => mocks.invoke(command, args),
  listen: (name, handler) => mocks.listen(name, handler),
}))

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

async function harness(saved = null, desktop = true) {
  const config = { preferences: saved === null ? {} : { openWith: saved } }
  let failWrite = false
  const calls = []
  let changed
  mocks.desktop = desktop
  mocks.invoke = async (command, args) => {
    if (command === "app_config_get") return config
    if (command === "app_preference_set") {
      if (failWrite) throw Error("blocked")
      config.preferences[args.key] = args.value
      return
    }
    calls.push({ command, args })
  }
  mocks.listen = async (name, handler) => {
    if (name === "pi://app-config-changed") changed = handler
    return () => {}
  }
  vi.stubGlobal("localStorage", { getItem: () => null, removeItem() {} })
  vi.resetModules()
  const { initializeConfigPreferences } = await import("@/lib/configPreference")
  await initializeConfigPreferences()
  const api = await import("@/lib/openWith")
  return {
    ...api,
    calls,
    stored: () => config.preferences.openWith,
    failStorage: () => {
      failWrite = true
    },
    storage: value => {
      config.preferences.openWith = value
      changed?.({ payload: config })
    },
  }
}
test("defaults safely and restores only valid editor preferences", async () => {
  for (const value of [null, "{", '{"kind":"arbitrary-command"}'])
    expect((await harness(value)).openWithPreference.value.kind).toBe("vscode")
  expect((await harness('{"kind":"cursor"}')).openWithPreference.value.kind).toBe("cursor")
})
test("persists default and custom executable and synchronizes other clients", async () => {
  const h = await harness()
  await h.setOpenWith("custom", " C:/Program Files/My IDE/ide.exe ")
  expect(JSON.parse(h.stored()).executable).toBe("C:/Program Files/My IDE/ide.exe")
  h.storage('{"kind":"system"}')
  expect(h.openWithPreference.value.kind).toBe("system")
  h.failStorage()
  await expect(h.setOpenWith("cursor")).rejects.toThrow(/blocked/)
  expect(h.openWithPreference.value.kind).toBe("system")
})
test("passes the file and project separately without shell interpolation", async () => {
  const h = await harness()
  await h.setOpenWith("cursor")
  await h.openFileInEditor("src/file & 中文.ts", "C:/my project")
  expect(h.calls[0].command).toBe("open_in_editor")
  expect(h.calls[0].args.path).toBe("src/file & 中文.ts")
  expect(h.calls[0].args.project).toBe("C:/my project")
  expect(h.calls[0].args.kind).toBe("cursor")
  expect(h.calls[0].args.executable).toBe(null)
  await h.setOpenWith("custom", "C:/ide.exe")
  await h.openFileInEditor("a.ts", "C:/project")
  expect(h.calls[1].args.executable).toBe("C:/ide.exe")
})
test("does not launch an editor from remote web mode", async () => {
  const h = await harness(null, false)
  await expect(h.openFileInEditor("a.ts", "/project")).rejects.toThrow(/desktop/)
  expect(h.calls.length).toBe(0)
})
test("both split panes reuse the shared themed scrollbars", () => {
  const split = readFileSync(new URL("../src/components/ReviewSplitDiff.vue", import.meta.url), "utf8")
  expect((split.match(/<ScrollArea\s/g) ?? []).length).toBe(2)
  expect((split.match(/orientation="both"/g) ?? []).length).toBe(2)
  expect((split.match(/@viewport-scroll=/g) ?? []).length).toBe(2)
})
