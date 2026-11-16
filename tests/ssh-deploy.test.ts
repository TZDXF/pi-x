import { afterEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { useSshDeploy } from "@/composables/useSshDeploy"

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  deploy: vi.fn(),
}))

vi.mock("@/api/piClient", () => ({ sshDeployStatus: mocks.status, sshDeployPi: mocks.deploy }))
vi.mock("@/composables/useSshDeployProgress", () => ({ useSshDeployProgress: () => ref(null) }))

afterEach(() => vi.resetAllMocks())

test("loads optional status without losing existing results on failure", async () => {
  const state = useSshDeploy()
  const status = { piFound: false, deployed: false, piBin: null, version: null, contentHash: null }
  mocks.status.mockResolvedValueOnce(status).mockRejectedValueOnce(new Error("offline"))

  await state.loadStatus({ id: "one" })
  await state.loadStatus({ id: "two" })
  expect(state.statuses.value).toEqual({ one: status })
})

test("deduplicates deployment and records the successful result", async () => {
  let resolve!: (value: unknown) => void
  mocks.deploy.mockReturnValue(
    new Promise(done => {
      resolve = done
    }),
  )
  const onSuccess = vi.fn()
  const state = useSshDeploy({ onSuccess })
  const pending = state.deploy({ id: "one" })
  expect(state.deployingIds.value.has("one")).toBe(true)
  await state.deploy({ id: "one" })
  expect(mocks.deploy).toHaveBeenCalledOnce()

  state.progress.value = { step: "upload", message: "Uploading", percent: 50 }
  resolve({ piBin: "/pi", deployed: true, version: "1", contentHash: "hash" })
  await pending
  expect(state.statuses.value.one).toEqual({
    piFound: true,
    piBin: "/pi",
    deployed: true,
    version: "1",
    contentHash: "hash",
  })
  expect(onSuccess).toHaveBeenCalledOnce()
  expect(state.deployingIds.value.has("one")).toBe(false)
  expect(state.progress.value).toBeNull()
})

test("reports deployment errors and clears in-flight state", async () => {
  const error = new Error("offline")
  mocks.deploy.mockRejectedValue(error)
  const onError = vi.fn()
  const state = useSshDeploy({ onError })
  state.progress.value = { step: "upload", message: "Uploading", percent: 50 }

  await state.deploy({ id: "one" })
  expect(onError).toHaveBeenCalledWith(error)
  expect(state.statuses.value).toEqual({})
  expect(state.deployingIds.value.has("one")).toBe(false)
  expect(state.progress.value).toBeNull()
})
