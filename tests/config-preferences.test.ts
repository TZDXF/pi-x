import { afterEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  config: { preferences: {} as Record<string, string> },
  changed: null as null | ((event: { payload: { preferences?: Record<string, string> } }) => void),
  failWrite: false,
  writes: [] as { key: string; value: string }[],
}))

vi.mock("@/api/transport", () => ({
  isDesktop: true,
  invoke: async (command: string, args: { key: string; value: string }) => {
    if (command === "app_config_get") return mocks.config
    if (command === "app_preference_set") {
      if (mocks.failWrite) throw new Error("denied")
      mocks.writes.push({ key: args.key, value: args.value })
      mocks.config.preferences[args.key] = args.value
    }
  },
  listen: async (_name: string, handler: (event: { payload: { preferences?: Record<string, string> } }) => void) => {
    mocks.changed = handler
    return () => {}
  },
}))

const storage = new Map<string, string>()

async function harness(preferences: Record<string, string> = {}) {
  vi.resetModules()
  mocks.config = { preferences: { ...preferences } }
  mocks.changed = null
  mocks.failWrite = false
  mocks.writes = []
  const module = await import("@/lib/configPreference")
  return module
}

afterEach(() => {
  storage.clear()
  vi.unstubAllGlobals()
})

function stubStorage() {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
  })
}

test("loads config.json values and updates listeners from backend events", async () => {
  stubStorage()
  const { createConfigPreference, initializeConfigPreferences } = await harness()
  const preference = createConfigPreference({ key: "theme", defaultValue: "system" })
  expect(preference.value.value).toBe("system")

  expect(await initializeConfigPreferences()).toBe(true)
  // The initial empty config was replaced only if supplied at initialization;
  // explicitly load a host value through the public config argument as App does.
  await initializeConfigPreferences({ preferences: { theme: "dark" } })
  expect(preference.value.value).toBe("dark")

  await vi.waitFor(() => expect(mocks.changed).not.toBeNull())
  mocks.changed?.({ payload: { preferences: { theme: "light" } } })
  expect(preference.value.value).toBe("light")
})

test("writes settings to config preferences rather than localStorage", async () => {
  stubStorage()
  const { createConfigPreference, initializeConfigPreferences } = await harness()
  await initializeConfigPreferences()
  const preference = createConfigPreference({ key: "processDetail", defaultValue: "detailed" })

  await preference.set("concise")
  expect(preference.value.value).toBe("concise")
  expect(mocks.writes).toEqual([{ key: "processDetail", value: "concise" }])
  expect(storage.size).toBe(0)
})

test("migrates a legacy value only when config.json has no authoritative value", async () => {
  stubStorage()
  storage.set("pix.theme", "dark")
  const { createConfigPreference, initializeConfigPreferences } = await harness()
  const preference = createConfigPreference({ key: "theme", legacyKey: "pix.theme", defaultValue: "system" })
  await initializeConfigPreferences()

  await vi.waitFor(() => expect(mocks.writes).toEqual([{ key: "theme", value: "dark" }]))
  expect(preference.value.value).toBe("dark")
  expect(storage.has("pix.theme")).toBe(false)

  storage.set("pix.theme", "light")
  const next = await harness({ theme: "dark" })
  const configured = next.createConfigPreference({
    key: "theme",
    legacyKey: "pix.theme",
    defaultValue: "system",
  })
  await next.initializeConfigPreferences()
  expect(configured.value.value).toBe("dark")
  expect(mocks.writes).toEqual([])
  expect(storage.has("pix.theme")).toBe(false)
})

test("strict writes reject without changing the in-memory preference", async () => {
  stubStorage()
  const { createConfigPreference, initializeConfigPreferences } = await harness({ openWith: "cursor" })
  await initializeConfigPreferences()
  const preference = createConfigPreference({
    key: "openWith",
    defaultValue: "vscode",
    throwOnWriteError: true,
  })
  mocks.failWrite = true

  await expect(preference.set("custom")).rejects.toThrow("denied")
  expect(preference.value.value).toBe("cursor")
})
