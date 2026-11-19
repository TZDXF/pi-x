import { effectScope } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

/**
 * 关闭 aux 槽位的顺序（TZD-130）：先同步撤槽位，再销毁实例。
 *
 * `isolate: false`：模块缓存跨测试文件共享。每个用例前 `vi.resetModules()` 再动态
 * import，`vi.mock` 才会作用到本次求值的模块 —— 否则可能拿到别的文件已缓存的真实
 * 注册表，两个来源的顺序断言会随执行顺序时好时坏。
 */
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
  auxCreationPending: () => false,
  auxInstancesFor: () => [],
  auxPendingCreation: () => undefined,
  // 槽位按父会话 + id 联合定位（TZD-127）：只命中本父会话的 id=7。
  auxTabBySidebarId: (parentRuntimeId: string, tabId: number) =>
    parentRuntimeId === "runtime:parent" && tabId === 7
      ? { tabId, runtimeId: "aux:test", parentRuntimeId: "runtime:parent" }
      : undefined,
  closeAux: (...args: unknown[]) => controls.closeAux(...args),
  openAux: async () => null,
  registerAuxAskRouter: () => {},
  setAuxTabId: () => {},
}))

afterEach(() => {
  // 与接线用例同理：本文件的 `vi.mock` 替身不得随模块缓存漏给后续测试文件。
  vi.resetModules()
})

function pending() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

let useAuxTabs: (typeof import("@/composables/useAuxTabs"))["useAuxTabs"]

beforeEach(async () => {
  controls.events = []
  controls.closeAux.mockReset()
  controls.closeSidebarTab.mockReset()
  controls.closeSidebarTab.mockImplementation((id: number) => controls.events.push(`tab:${id}:close`))
  vi.resetModules()
  ;({ useAuxTabs } = await import("@/composables/useAuxTabs"))
})

function harness() {
  const scope = effectScope()
  const aux = scope.run(() =>
    useAuxTabs({
      runtimeId: "runtime:parent",
      session: { cwd: "C:/project" } as never,
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
