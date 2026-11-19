import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { effectScope, type EffectScope } from "vue"

/**
 * 跨父会话的同号槽位隔离（TZD-127）：真实侧栏接线 + 真实 aux 注册表，
 * 仅替换进程、RPC 与持久化，不访问真实模型。
 *
 * `isolate: false`：模块缓存跨测试文件共享。每个用例前 `vi.resetModules()` 再动态
 * import，既让本文件的 `vi.mock` 生效，也避免拿到别的文件缓存过的注册表实例
 * （否则结果随执行顺序时好时坏）。
 */
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

type AuxChat = typeof import("@/stores/auxChat")
type Sidebar = typeof import("@/composables/useChatViewSidebar")

let auxChat: AuxChat
let useChatViewSidebar: Sidebar["useChatViewSidebar"]

const scopes: EffectScope[] = []

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  controls.spawn.mockReset().mockImplementation(async () => {})
  controls.kill.mockClear()
  vi.resetModules()
  auxChat = await import("@/stores/auxChat")
  ;({ useChatViewSidebar } = await import("@/composables/useChatViewSidebar"))
  auxChat.registerAuxRuntimeBridge({ kill: controls.kill })
})

afterEach(() => {
  scopes.forEach(scope => scope.stop())
  scopes.length = 0
  auxChat.resetAuxChatForTest()
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
  const left = auxChat.auxInstancesFor("runtime:a")[0]!
  const right = auxChat.auxInstancesFor("runtime:b")[0]!
  expect(left.tabId).toBe(1)
  expect(right.tabId).toBe(1)

  // 与 RightSidebar 相同的显示查找：B 的 id=1 不能解析到先登记的 A。
  const renderedFrom = auxChat.auxTabBySidebarId("runtime:b", b.tabs.value[0]!.id)?.parentRuntimeId
  await b.closeTab(right.tabId)

  expect({
    renderedFrom,
    killed: controls.kill.mock.calls[0]?.[0],
    leftLive: auxChat.auxInstancesFor("runtime:a").length,
    rightLive: auxChat.auxInstancesFor("runtime:b").length,
  }).toEqual({ renderedFrom: "runtime:b", killed: right.runtimeId, leftLive: 1, rightLive: 0 })
})
