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
  // 预先加载客户端配置模块：`startConfigListener` 用动态 import，isolate:false 下
  // 每轮 resetModules 后首次解析这个模块会慢一拍，测试不应因此偶发失败。
  await import("@/api/client/config")
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

test("a stale event snapshot never reverses a newer local write", async () => {
  stubStorage()
  const { createConfigPreference, initializeConfigPreferences } = await harness()
  await initializeConfigPreferences({ preferences: { theme: "system" } })
  const preference = createConfigPreference({ key: "theme", defaultValue: "system" })
  await vi.waitFor(() => expect(mocks.changed).not.toBeNull())

  // 连点「关 → 开」：两次本地写入，UI 立刻跟着最后一次。
  await preference.set("dark")
  await preference.set("light")
  expect(preference.value.value).toBe("light")

  // 迟到的旧回执（dark）：必须被忽略，否则 UI 会闪回上一次的选择。
  mocks.changed?.({ payload: { preferences: { theme: "dark" } } })
  expect(preference.value.value).toBe("light")

  // 最新值的回执到达才解除「待确认」，之后主机事件照常生效。
  mocks.changed?.({ payload: { preferences: { theme: "light" } } })
  expect(preference.value.value).toBe("light")
  mocks.changed?.({ payload: { preferences: { theme: "system" } } })
  expect(preference.value.value).toBe("system")
})

test("a snapshot missing an unconfirmed key does not reset it to the default", async () => {
  stubStorage()
  const { createConfigPreference, initializeConfigPreferences } = await harness()
  await initializeConfigPreferences({ preferences: { theme: "system", processDetail: "detailed" } })
  const preference = createConfigPreference({ key: "theme", defaultValue: "system" })
  await vi.waitFor(() => expect(mocks.changed).not.toBeNull())

  await preference.set("dark")
  // 旧快照里没有这一项（例如只改了别的 key 的很早期快照）：未确认的本地写入必须保留。
  mocks.changed?.({ payload: { preferences: { processDetail: "detailed" } } })
  expect(preference.value.value).toBe("dark")

  mocks.changed?.({ payload: { preferences: { processDetail: "concise" } } })
  expect(preference.value.value).toBe("dark")
})

test("a genuinely external value is still applied while a local write is pending", async () => {
  stubStorage()
  const { createConfigPreference, initializeConfigPreferences } = await harness()
  await initializeConfigPreferences({ preferences: { theme: "system", processDetail: "detailed" } })
  const theme = createConfigPreference({ key: "theme", defaultValue: "system" })
  const detail = createConfigPreference({ key: "processDetail", defaultValue: "detailed" })
  await vi.waitFor(() => expect(mocks.changed).not.toBeNull())

  await theme.set("dark")
  // 值不是本客户端写过的（别的窗口/远程端改了）：属于真实外部变更，正常应用；
  // 同快照里 processDetail 的变化同样立刻生效。只有本地写过的旧值才被视为迟到回执。
  mocks.changed?.({ payload: { preferences: { theme: "system", processDetail: "concise" } } })
  expect(theme.value.value).toBe("system")
  expect(detail.value.value).toBe("concise")
})

test("a failed write releases the unconfirmed guard", async () => {
  stubStorage()
  const { createConfigPreference, initializeConfigPreferences } = await harness()
  await initializeConfigPreferences({ preferences: { theme: "system" } })
  const preference = createConfigPreference({ key: "theme", defaultValue: "system" })
  await vi.waitFor(() => expect(mocks.changed).not.toBeNull())

  mocks.failWrite = true
  await preference.set("dark")
  expect(preference.value.value).toBe("dark")
  // 没写进主机，就不该再拦着后续快照。
  mocks.changed?.({ payload: { preferences: { theme: "light" } } })
  expect(preference.value.value).toBe("light")
})
