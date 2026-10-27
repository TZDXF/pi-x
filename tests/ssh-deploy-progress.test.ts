import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, type EffectScope } from "vue"

const mocks = vi.hoisted(() => ({
  listeners: [] as ((event: { payload: { step: string; message: string; percent: number } }) => void)[],
  unlisten: [] as ReturnType<typeof vi.fn>[],
  pending: null as null | ((fn: () => void) => void),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, listener: (typeof mocks.listeners)[number]) => {
    mocks.listeners.push(listener)
    const unlisten = vi.fn()
    mocks.unlisten.push(unlisten)
    return mocks.pending
      ? new Promise<() => void>(resolve => {
          mocks.pending?.(resolve)
        })
      : Promise.resolve(unlisten)
  }),
}))

const scopes: EffectScope[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  mocks.listeners.length = 0
  mocks.unlisten.length = 0
  mocks.pending = null
})

test("deployment progress uses one listener and removes it with its scope", async () => {
  const { useSshDeployProgress } = await import("@/composables/useSshDeployProgress")
  const scope = effectScope()
  scopes.push(scope)
  const progress = scope.run(useSshDeployProgress)!
  await nextTick()

  const payload = { step: "upload", message: "Uploading", percent: 40 }
  mocks.listeners[0]!({ payload })
  expect(progress.value).toEqual(payload)
  expect(mocks.listeners).toHaveLength(1)

  scope.stop()
  expect(mocks.unlisten[0]).toHaveBeenCalledTimes(1)
})

test("a listener registered after disposal is removed immediately", async () => {
  let register!: (fn: () => void) => void
  mocks.pending = fn => {
    register = fn
  }
  const { useSshDeployProgress } = await import("@/composables/useSshDeployProgress")
  const scope = effectScope()
  const progress = scope.run(useSshDeployProgress)!
  scope.stop()
  register(mocks.unlisten[0]!)
  await nextTick()

  expect(mocks.unlisten[0]).toHaveBeenCalledTimes(1)
  expect(progress.value).toBeNull()
})
