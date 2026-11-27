import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { effectScope, nextTick, type EffectScope } from "vue"

/**
 * 辅助对话的**创建窗口**与**关闭同步性**（TZD-155）。
 *
 * 两条成员要求：
 * 1. 创建期间（实例仍是 `creating`）提问必须照常落到该父会话的 aux，并且引用真的投进
 *    桶里 —— 不能等到 spawn 握手结束才回答，更不能在期间被关闭后让下一次提问复用一个
 *    注定返回 `null` 的在途创建（那会给出"没有可用的辅助对话入口"的错误提示，而父会话
 *    完全可用）。只有父会话本身不可用（router 未接线、侧栏无空位）时才保留失败提示。
 * 2. 实例经由**任何**入口消失时，它的侧栏槽位必须在同一同步步骤里撤掉：面板靠
 *    `auxInstance(tab.id)` 渲染，实例先摘、槽位后撤就会出现"内容先关、Tab 后关"。
 *
 * 走真实接线（`useChatViewSidebar` + 两个注册表），只替身进程与 RPC。
 */
const controls = vi.hoisted(() => ({
  persisted: {} as Record<string, unknown>,
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
    sidebarTabs: controls.persisted,
    persistSidebarTabs(key: string, value: unknown) {
      if (value === null) delete controls.persisted[key]
      else controls.persisted[key] = value
    },
    histories: {},
    refresh: async () => {},
    preview() {},
  }),
}))
vi.mock("@/lib/auxSpawn", () => ({
  auxParentContext: (id: string) => ({ id }),
  spawnAuxRuntime: (parent: unknown, tab: unknown) => controls.spawn(parent, tab),
}))

type ChatViewSidebarModule = typeof import("@/composables/useChatViewSidebar")
type AuxChatModule = typeof import("@/stores/auxChat")
type AuxSelectionsModule = typeof import("@/stores/auxSelections")
type SidebarTabsModule = typeof import("@/stores/sidebarTabs")

let useChatViewSidebar: ChatViewSidebarModule["useChatViewSidebar"]
let auxChat: AuxChatModule
let auxSelectionItems: AuxSelectionsModule["auxSelectionItems"]
let resetAuxChatForTest: AuxChatModule["resetAuxChatForTest"]
let resetRegistryForTest: SidebarTabsModule["resetRegistryForTest"]
let resetQueuesForTest: SidebarTabsModule["resetQueuesForTest"]

let scopes: EffectScope[] = []

beforeEach(async () => {
  setActivePinia(createPinia())
  // `isolate: false`：模块缓存与 `vi.mock` 注册表跨文件共享，重置后再求值才干净。
  vi.resetModules()
  auxChat = await import("@/stores/auxChat")
  resetAuxChatForTest = auxChat.resetAuxChatForTest
  auxSelectionItems = (await import("@/stores/auxSelections")).auxSelectionItems
  const sidebar = await import("@/stores/sidebarTabs")
  resetRegistryForTest = sidebar.resetRegistryForTest
  resetQueuesForTest = sidebar.resetQueuesForTest
  useChatViewSidebar = (await import("@/composables/useChatViewSidebar")).useChatViewSidebar
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  controls.spawn.mockReset()
  controls.spawn.mockImplementation(async () => {})
  controls.kill.mockReset()
  controls.kill.mockImplementation(async () => {})
  for (const key in controls.persisted) delete controls.persisted[key]
  resetRegistryForTest()
  resetQueuesForTest()
  resetAuxChatForTest()
  auxChat.registerAuxRuntimeBridge({ kill: controls.kill })
})

afterEach(() => {
  scopes.forEach(scope => scope.stop())
  scopes = []
  resetAuxChatForTest()
  resetQueuesForTest()
  resetRegistryForTest()
  vi.unstubAllGlobals()
  // 本文件用真实 `@/stores/auxChat`；留着会污染随后用全量替身的用例（反之亦然）。
  vi.resetModules()
})

function mount(runtimeId: string) {
  const scope = effectScope()
  scopes.push(scope)
  const toast = vi.fn()
  const side = scope.run(() =>
    useChatViewSidebar({
      runtimeId,
      session: { sessionFile: null, cwd: "qa" } as never,
      ui: { pushToast: toast } as never,
      project: () => "qa",
      onFirstTabAdded() {},
      onLastTabClosed() {},
    }),
  )!
  return { side, toast }
}

function pending<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test("a question lands in the creating instance instead of waiting for the handshake", async () => {
  const gate = pending()
  controls.spawn.mockImplementationOnce(() => gate.promise)
  const { side } = mount("qa-creating")
  // 不 await：`addAux` 已同步加了槽位并入了表，实例还在 `creating`。
  const opening = side.addTab("aux")
  const slot = side.tabs.value[0]
  expect(slot?.type).toBe("aux")
  const instance = auxChat.auxInstancesFor("qa-creating")[0]!
  expect(instance.status).toBe("creating")

  // 创建期间提问：引用直接落进该实例自己的桶，并且不叠加第二次 spawn。
  const outcome = await side.askAux({ text: "创建期间的提问" })
  expect(outcome.ok).toBe(true)
  expect(outcome.ok && outcome.tab.runtimeId).toBe(instance.runtimeId)
  expect(auxSelectionItems(instance.runtimeId).map(item => item.text)).toEqual(["创建期间的提问"])
  expect(controls.spawn).toHaveBeenCalledTimes(1)

  // 多实例选择器的"新建"入口（`target: null`）同样不能挂在握手上：在途创建就是这次
  // 新建的结果，引用照样立刻落桶（旧实现会一直 await 到 spawn 返回才回答）。
  const fresh = await side.askAux({ text: "另起一条的提问" }, null)
  expect(fresh.ok).toBe(true)
  expect(fresh.ok && fresh.tab.runtimeId).toBe(instance.runtimeId)
  expect(auxSelectionItems(instance.runtimeId).map(item => item.text)).toEqual(["创建期间的提问", "另起一条的提问"])
  expect(controls.spawn).toHaveBeenCalledTimes(1)
  // 面板已激活（引用进了桶就要看得见），槽位仍是同一格。
  expect(side.activeId.value).toBe(slot!.id)
  expect(side.tabs.value).toHaveLength(1)

  // 握手完成：同一个实例转 `ready`，引用仍在（用户可以直接发送）。
  gate.resolve()
  await opening
  expect(auxChat.auxInstancesFor("qa-creating")[0]!.status).toBe("ready")
  expect(auxSelectionItems(instance.runtimeId)).toHaveLength(2)
})

test("a question right after closing the creating instance opens a fresh one instead of failing", async () => {
  const firstSpawn = pending()
  controls.spawn.mockImplementationOnce(() => firstSpawn.promise)
  const { side } = mount("qa-closed-then-ask")
  const opening = side.addTab("aux")
  const slot = side.tabs.value[0]!
  const first = auxChat.auxInstancesFor("qa-closed-then-ask")[0]!

  // 创建期间关闭：槽位与实例都同步撤掉，去重键随之解除。
  await side.closeTab(slot.id)
  expect(side.tabs.value).toHaveLength(0)
  expect(auxChat.auxInstancesFor("qa-closed-then-ask")).toHaveLength(0)
  expect(auxChat.auxCreationPending("qa-closed-then-ask")).toBe(false)

  // 随即再提问必须**新建**并成功投递 —— 旧实现会复用到那次注定返回 null 的创建。
  const outcome = await side.askAux({ text: "关闭之后又提问" })
  expect(outcome.ok).toBe(true)
  const fresh = auxChat.auxInstancesFor("qa-closed-then-ask")[0]!
  expect(fresh.runtimeId).not.toBe(first.runtimeId)
  expect(outcome.ok && outcome.tab.runtimeId).toBe(fresh.runtimeId)
  expect(auxSelectionItems(fresh.runtimeId).map(item => item.text)).toEqual(["关闭之后又提问"])
  expect(controls.spawn).toHaveBeenCalledTimes(2)

  // 迟到的第一次创建返回 null，且**不得**把新一笔在途创建（或新实例）一起清掉。
  firstSpawn.resolve()
  await opening
  expect(auxChat.auxInstancesFor("qa-closed-then-ask")[0]!.runtimeId).toBe(fresh.runtimeId)
  expect(side.tabs.value.filter(tab => tab.type === "aux")).toHaveLength(1)
})

test("only an unusable parent keeps the failure notice", async () => {
  // 父会话不可用（没有挂载接线 → router 未注册）：保留失败提示，不写任何桶。
  const outcome = await auxChat.askInAux("qa-no-parent", { text: "正文" })
  expect(outcome).toEqual({ ok: false, reason: "unavailable" })
  expect(auxChat.auxLiveCount()).toBe(0)
})

test("closing an instance from any entry point removes its sidebar slot in the same step", async () => {
  const { side } = mount("qa-close-any")
  await side.addTab("aux")
  await side.addTab("files")
  const aux = auxChat.auxInstancesFor("qa-close-any")[0]!
  expect(side.tabs.value.map(tab => tab.type)).toEqual(["aux", "files"])

  // 不经关闭按钮，直接销毁实例（父会话收尾/其他入口都走这一条）。
  let releaseKill!: () => void
  const blocked = new Promise<void>(resolve => (releaseKill = resolve))
  controls.kill.mockImplementationOnce(async () => {
    await blocked
  })
  const closing = auxChat.closeAux(aux.runtimeId)
  // `closeAux` 在第一个 await 之前就摘实例并通知：槽位此刻必须已经不在，且是同一 tick。
  expect(side.tabs.value.map(tab => tab.type)).toEqual(["files"])
  expect(auxChat.auxInstancesFor("qa-close-any")).toHaveLength(0)
  // 面板渲染判据（`auxInstance(tab.id)`）已为空，Tab 也已消失 —— 同一个渲染帧里两者同时消失。
  expect(auxChat.auxTabBySidebarId("qa-close-any", aux.tabId)).toBeUndefined()
  releaseKill()
  await closing
  expect(side.tabs.value.map(tab => tab.type)).toEqual(["files"])
  // 普通 Tab 不受影响，也不多发 kill。
  expect(controls.kill.mock.calls.map(([id]) => id)).toEqual([aux.runtimeId])
})

test("a removal for another parent's instance never touches this group's slots", async () => {
  const a = mount("qa-remove-a").side
  const b = mount("qa-remove-b").side
  await a.addTab("aux")
  await b.addTab("aux")
  await a.addTab("files")
  const aAux = auxChat.auxInstancesFor("qa-remove-a")[0]!
  const bAux = auxChat.auxInstancesFor("qa-remove-b")[0]!
  // 两个父会话的 aux 都是 id=1（槽位 id 只在组内唯一，TZD-131）。
  expect([aAux.tabId, bAux.tabId]).toEqual([1, 1])
  const before = a.tabs.value.map(tab => [tab.id, tab.type])
  expect(b.tabs.value.map(tab => [tab.id, tab.type])).toEqual([[1, "aux"]])

  await auxChat.closeAux(bAux.runtimeId)
  await nextTick()
  // A 组的 1 号槽位仍属于 A 的存活实例；只撤 B 组自己的那一格。
  expect(a.tabs.value.map(tab => [tab.id, tab.type])).toEqual(before)
  expect(b.tabs.value).toHaveLength(0)
  expect(auxChat.auxInstancesFor("qa-remove-a").map(tab => tab.runtimeId)).toEqual([aAux.runtimeId])
})
