import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const mocks = vi.hoisted(() => ({
  desktop: true,
  getConfig: vi.fn(),
  checkAppUpdate: vi.fn(),
}))

vi.mock("@/api/transport", () => ({
  get isDesktop() {
    return mocks.desktop
  },
  invoke: async () => null,
}))
vi.mock("@/api/client/config", () => ({ getConfig: mocks.getConfig }))
vi.mock("@/api/client/updates", () => ({ checkAppUpdate: mocks.checkAppUpdate }))

import { useAppUpdateStore } from "@/stores/appUpdate"

const updateStatus = {
  channel: "stable",
  currentVersion: "1.0.0",
  updateAvailable: true,
  waitingStable: false,
  version: "1.1.0",
  releaseNotes: null,
  releaseUrl: "https://example.com/release",
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.desktop = true
  // 默认 vitest 的 DEV 为 true；自动检查只在非开发构建里跑，按需翻转
  vi.stubEnv("DEV", false)
  mocks.getConfig.mockReset()
  mocks.checkAppUpdate.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

test("auto check queries the configured channel once and stores the result", async () => {
  mocks.getConfig.mockResolvedValue({ updateChannel: "preview" })
  mocks.checkAppUpdate.mockResolvedValue({ ...updateStatus, channel: "preview" })

  const store = useAppUpdateStore()
  expect(store.status).toBeNull()

  await store.autoCheck()
  expect(mocks.getConfig).toHaveBeenCalledTimes(1)
  expect(mocks.checkAppUpdate).toHaveBeenCalledWith("preview")
  expect(store.status?.updateAvailable).toBe(true)
  expect(store.status?.version).toBe("1.1.0")
  expect(store.checked).toBe(true)

  await store.autoCheck()
  expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(1)
})

test("auto check falls back to the stable channel when config has no channel", async () => {
  mocks.getConfig.mockResolvedValue({})
  mocks.checkAppUpdate.mockResolvedValue(updateStatus)

  const store = useAppUpdateStore()
  await store.autoCheck()
  expect(mocks.checkAppUpdate).toHaveBeenCalledWith("stable")
})

test("auto check does nothing in remote mode or development builds", async () => {
  mocks.desktop = false
  const remote = useAppUpdateStore()
  await remote.autoCheck()
  expect(mocks.getConfig).not.toHaveBeenCalled()
  expect(remote.status).toBeNull()

  mocks.desktop = true
  vi.stubEnv("DEV", true)
  const dev = useAppUpdateStore()
  await dev.autoCheck()
  expect(mocks.getConfig).not.toHaveBeenCalled()
  expect(dev.status).toBeNull()
})

test("auto check failures stay silent and leave the state untouched", async () => {
  mocks.getConfig.mockRejectedValue(new Error("offline"))

  const store = useAppUpdateStore()
  await expect(store.autoCheck()).resolves.toBeUndefined()
  expect(store.status).toBeNull()
  expect(store.checked).toBe(false)
})
