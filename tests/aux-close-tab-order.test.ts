import { effectScope } from "vue"
import { beforeEach, expect, test, vi } from "vitest"

const controls = vi.hoisted(() => ({
  events: [] as string[],
  closeAux: vi.fn(),
  closeSidebarTab: vi.fn(),
}))

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@/lib/auxSpawn", () => ({
  auxParentContext: () => null,
  spawnAuxRuntime: async () => {},
}))
vi.mock("@/stores/auxChat", () => ({
  auxCanOpen: () => true,
  auxCreationPending: () => false,
  auxInstancesFor: () => [],
  auxPendingCreation: () => undefined,
  auxTabBySidebarId: (id: number) =>
    id === 7 ? { tabId: id, runtimeId: "aux:test", parentRuntimeId: "runtime:parent" } : undefined,
  closeAux: (...args: unknown[]) => controls.closeAux(...args),
  openAux: async () => null,
  registerAuxAskRouter: () => {},
  setAuxTabId: () => {},
}))

const { useAuxTabs } = await import("@/composables/useAuxTabs")

function pending() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  controls.events = []
  controls.closeAux.mockReset()
  controls.closeSidebarTab.mockReset()
  controls.closeSidebarTab.mockImplementation((id: number) => controls.events.push(`tab:${id}:close`))
})

function harness() {
  const scope = effectScope()
  const aux = scope.run(() =>
    useAuxTabs({
      runtimeId: "runtime:parent",
      session: { cwd: "C:/project" } as never,
      ui: { pushToast: () => {} } as never,
      workspace: {} as never,
      project: () => "C:/project",
      addSidebarTab: () => 7,
      closeSidebarTab: controls.closeSidebarTab,
      activate: () => {},
      tabs: () => [],
      activeTabId: () => 7,
    }),
  )!
  return { aux, stop: () => scope.stop() }
}

test("closing an aux removes its sidebar tab before awaiting process cleanup", async () => {
  const cleanup = pending()
  controls.closeAux.mockImplementation(async (runtimeId: string) => {
    controls.events.push(`${runtimeId}:cleanup:start`)
    await cleanup.promise
    controls.events.push(`${runtimeId}:cleanup:end`)
  })
  const { aux, stop } = harness()

  const closing = aux.closeTab(7)

  // closeAux 会同步清页面，但 rpc_kill 可能尚未返回；用户手势必须先撤掉 Tab。
  expect(controls.events).toEqual(["tab:7:close", "aux:test:cleanup:start"])
  cleanup.resolve()
  await closing
  expect(controls.events).toEqual(["tab:7:close", "aux:test:cleanup:start", "aux:test:cleanup:end"])
  stop()
})

test("closing a non-aux tab still removes its slot synchronously", async () => {
  const { aux, stop } = harness()
  await aux.closeTab(8)
  expect(controls.closeSidebarTab).toHaveBeenCalledWith(8)
  expect(controls.closeAux).not.toHaveBeenCalled()
  stop()
})
