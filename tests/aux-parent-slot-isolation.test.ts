import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { effectScope, type EffectScope } from "vue"

/** 真实侧栏接线 + aux 注册表；仅替换进程、RPC 与持久化，不访问真实模型。 */
const controls = vi.hoisted(() => ({
  spawn: vi.fn(async (_parent: unknown, _tab: unknown) => {}),
  kill: vi.fn(async (_id: string) => {}),
}))

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@/api/piClient", () => ({
  adoptSession: async () => {},
  sessionHistory: async () => [],
  sessionLastError: async () => null,
  sessionMtime: async () => 0,
  generateSessionTitle: async () => ({ title: "" }),
  getPiSettings: async () => ({ retry: { enabled: true } }),
  getModelsConfig: async () => ({ providers: [] }),
  rpcNotify: async () => {},
  rpcRequest: async () => ({ success: true, data: {} }),
  pixLog() {},
}))
vi.mock("@/api/transport", () => ({ invoke: async () => null }))
vi.mock("@/i18n", () => ({ i18n: { global: { t: (key: string) => key } }, tBackendError: String }))
vi.mock("@/lib/fileRewind", () => ({ fileRewindState: async () => [] }))
vi.mock("@/lib/notifications", () => ({ notifyTurnComplete() {}, notifyQuestion() {} }))
vi.mock("@/stores/sessionRunStatus", () => ({
  setSessionRunStatus() {},
  sessionRunStatus() {},
  sessionActivitySnapshot() {},
}))
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: () => ({
    sidebarTabs: {},
    persistSidebarTabs() {},
    histories: {},
    refresh: async () => {},
    preview() {},
  }),
}))
vi.mock("@/lib/auxSpawn", () => ({
  auxParentContext: (id: string) => ({ id }),
  spawnAuxRuntime: (parent: unknown, tab: unknown) => controls.spawn(parent, tab),
}))

import { useChatViewSidebar } from "@/composables/useChatViewSidebar"
import { auxInstancesFor, auxTabBySidebarId, registerAuxRuntimeBridge, resetAuxChatForTest } from "@/stores/auxChat"

const scopes: EffectScope[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  controls.spawn.mockReset().mockImplementation(async () => {})
  controls.kill.mockClear()
  registerAuxRuntimeBridge({ kill: controls.kill })
})

afterEach(() => {
  scopes.forEach(scope => scope.stop())
  scopes.length = 0
  resetAuxChatForTest()
  vi.unstubAllGlobals()
})

function sidebar(runtimeId: string) {
  const scope = effectScope()
  const toast = vi.fn()
  scopes.push(scope)
  return scope.run(() =>
    useChatViewSidebar({
      runtimeId,
      session: { sessionFile: null, cwd: "qa" } as never,
      ui: { pushToast: toast } as never,
      project: () => "qa",
      onFirstTabAdded() {},
      onLastTabClosed() {},
    }),
  )!
}

test("same slot id in parents A/B renders and closes only the instance owned by that parent", async () => {
  const a = sidebar("runtime:a")
  const b = sidebar("runtime:b")
  await a.addTab("aux")
  await b.addTab("aux")
  const left = auxInstancesFor("runtime:a")[0]!
  const right = auxInstancesFor("runtime:b")[0]!
  expect(left.tabId).toBe(1)
  expect(right.tabId).toBe(1)

  // 与 RightSidebar 相同的显示查找：B 的 id=1 不能解析到先登记的 A。
  const renderedFrom = auxTabBySidebarId("runtime:b", b.tabs.value[0]!.id)?.parentRuntimeId
  await b.closeTab(right.tabId)

  expect({
    renderedFrom,
    killed: controls.kill.mock.calls[0]?.[0],
    leftLive: auxInstancesFor("runtime:a").length,
    rightLive: auxInstancesFor("runtime:b").length,
  }).toEqual({ renderedFrom: "runtime:b", killed: right.runtimeId, leftLive: 1, rightLive: 0 })
})
