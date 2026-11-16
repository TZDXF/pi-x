import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const mocks = vi.hoisted(() => ({
  desktop: true,
  getConfig: vi.fn(),
  checkAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
  listen: vi.fn(),
}))

vi.mock("@/api/transport", () => ({
  get isDesktop() {
    return mocks.desktop
  },
  invoke: async () => null,
  listen: mocks.listen,
}))
vi.mock("@/api/client/config", () => ({ getConfig: mocks.getConfig }))
vi.mock("@/api/client/updates", () => ({
  APP_UPDATE_PROGRESS_EVENT: "pix://app-update",
  checkAppUpdate: mocks.checkAppUpdate,
  installAppUpdate: mocks.installAppUpdate,
}))

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
  mocks.installAppUpdate.mockReset()
  mocks.listen.mockReset()
  mocks.listen.mockResolvedValue(vi.fn())
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

test("download progress remains available across page listeners and completes globally", async () => {
  let progressHandler: (event: { payload: { stage: string; chunkLength?: number; contentLength?: number } }) => void
  mocks.listen.mockImplementation(async (_event, handler) => {
    progressHandler = handler
    return vi.fn()
  })
  let finishInstall!: () => void
  mocks.installAppUpdate.mockReturnValue(new Promise<void>(resolve => (finishInstall = resolve)))

  const store = useAppUpdateStore()
  const installing = store.install("stable")
  await vi.waitFor(() => expect(mocks.installAppUpdate).toHaveBeenCalledWith("stable"))
  await store.startProgressListener()

  expect(mocks.listen).toHaveBeenCalledTimes(1)
  expect(store.installing).toBe(true)
  expect(store.progress).toBe(0)

  progressHandler!({ payload: { stage: "download", chunkLength: 25, contentLength: 100 } })
  expect(store.progress).toBe(25)
  progressHandler!({ payload: { stage: "download", chunkLength: 25, contentLength: 100 } })
  expect(store.progress).toBe(50)
  progressHandler!({ payload: { stage: "install" } })
  expect(store.progress).toBe(100)

  finishInstall()
  await installing
  expect(store.installed).toBe(true)
  expect(store.installing).toBe(false)
  expect(store.progress).toBeNull()
})

test("a failed install clears progress and can be retried", async () => {
  mocks.installAppUpdate.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined)
  const store = useAppUpdateStore()

  await expect(store.install("stable")).rejects.toThrow("offline")
  expect(store.installing).toBe(false)
  expect(store.installed).toBe(false)
  expect(store.progress).toBeNull()

  await store.install("stable")
  expect(mocks.installAppUpdate).toHaveBeenCalledTimes(2)
  expect(store.installed).toBe(true)
})
