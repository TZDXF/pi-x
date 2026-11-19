import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { effectScope, nextTick, reactive, type EffectScope } from "vue"

/**
 * `aux` 槽位与侧栏组 LRU 淘汰的交互（TZD-131）。
 *
 * 缺陷：同一父会话先开 aux（槽位 `id=1`）再开文件 Tab（`id=2`），卸载该侧栏组并被
 * 24 组容量淘汰后重挂载 —— `aux` 永不落盘，落盘的文件 Tab 重新拿到 `id=1`；恢复
 * 逻辑只比数字 id，误认 aux 槽位仍在，界面不再显示 aux；随后关闭该文件 Tab 又会
 * 发出 `kill(aux)`，中断用户仍在进行的对话。
 *
 * 这里走**真实接线**（`useChatViewSidebar` + 侧栏/aux 两个注册表），只替换进程与
 * RPC，钉住四条不能回退的契约：
 * 1. 恢复按**槽位类型**认定 aux，不按数字 id；
 * 2. 关闭普通 Tab 不得终止 aux 进程，关闭 aux 槽位只终止它自己的实例；
 * 3. 未淘汰的普通重挂载不得重复补槽位；
 * 4. 普通 Tab 的 20 条 / 24 组通用容量与 aux 的加/关路径不回归。
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

import { useChatViewSidebar } from "@/composables/useChatViewSidebar"
import { auxSelectionItems } from "@/stores/auxSelections"
import {
  auxDeliverableFor,
  auxInstancesFor,
  auxTabBySidebarId,
  registerAuxRuntimeBridge,
  resetAuxChatForTest,
  setAuxTabId,
} from "@/stores/auxChat"
import {
  groupKeyFor,
  hasGroup,
  releaseGroup,
  retainGroup,
  resetQueuesForTest,
  resetRegistryForTest,
  retainedGroupCount,
  tabsFor,
} from "@/stores/sidebarTabs"

let scopes: EffectScope[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  controls.spawn.mockReset().mockImplementation(async () => {})
  controls.kill.mockReset().mockImplementation(async () => {})
  for (const key in controls.persisted) delete controls.persisted[key]
  resetAuxChatForTest()
  registerAuxRuntimeBridge({ kill: controls.kill })
})
afterEach(() => {
  scopes.forEach(scope => scope.stop())
  scopes = []
  resetAuxChatForTest()
  resetQueuesForTest()
  resetRegistryForTest()
  vi.unstubAllGlobals()
  // `vitest.config.ts` 是 `isolate: false`：模块缓存与 `vi.mock` 注册表跳测试文件
  // 共享。本文件用的是**真实**的 `@/stores/auxChat`，若把它留在缓存里，随后某个用
  // `useAuxTabs` + 全量替身 `auxChat` 的用例（如 `aux-close-tab-order`）会拿到这份
  // 真实实例，出现与代码无关的假红（反之亦然）。用完即清，两个方向都不污染。
  vi.resetModules()
})

function mount(runtimeId: string) {
  const scope = effectScope()
  const toast = vi.fn()
  scopes.push(scope)
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

const kindOf = (tabs: readonly { type: string }[]) => tabs.map(tab => tab.type)
const idsOf = (tabs: readonly { id: number }[]) => tabs.map(tab => tab.id)

/** 让刚释放的侧栏组被 24 组容量淘汰（真实 LRU 路径，不是直接 `dropGroup`）。 */
function evict() {
  const fillers = Array.from({ length: 24 }, (_, index) => `qa-filler-${index}`)
  for (const key of fillers) expect(retainGroup(key)).toBe(true)
  for (const key of fillers) releaseGroup(key)
}

test("an LRU remount restores aux to its own slot instead of the file tab that reused its id", async () => {
  const before = mount("qa-evicted")
  await before.side.addTab("aux")
  await before.side.addTab("files")
  const aux = auxInstancesFor("qa-evicted")[0]!
  expect(before.side.tabs.value.map(({ id, type }) => [id, type])).toEqual([
    [1, "aux"],
    [2, "files"],
  ])
  expect(aux.tabId).toBe(1)

  // 切走父会话（卸载并释放该组）→ 组被 24 组容量淘汰：落盘只剩文件 Tab。
  scopes.pop()!.stop()
  evict()

  const after = mount("qa-evicted")
  // 文件 Tab 重新拿到 id=1；aux 必须是**独立且类型明确**的新槽位，不能被它顶掉。
  expect(kindOf(after.side.tabs.value)).toEqual(["files", "aux"])
  const files = after.side.tabs.value.find(tab => tab.type === "files")!
  expect(files.id).toBe(1)
  const auxSlot = after.side.tabs.value.find(tab => tab.type === "aux")!
  expect(auxSlot.id).not.toBe(files.id)
  expect(aux.tabId).toBe(auxSlot.id)
  // 面板按槽位取实例：拿到的仍是原来那个存活实例（界面照常显示 aux）。
  expect(auxTabBySidebarId("qa-evicted", auxSlot.id)?.runtimeId).toBe(aux.runtimeId)

  // 关闭普通 Tab：只撤槽位，绝不发 kill。
  await after.side.closeTab(files.id)
  expect(kindOf(after.side.tabs.value)).toEqual(["aux"])
  expect(controls.kill).not.toHaveBeenCalled()
  expect(auxInstancesFor("qa-evicted").map(tab => tab.runtimeId)).toEqual([aux.runtimeId])

  // 关闭 aux 槽位：只终止它自己的实例。
  await after.side.closeTab(auxSlot.id)
  expect(controls.kill.mock.calls.map(([id]) => id)).toEqual([aux.runtimeId])
  expect(after.side.tabs.value).toHaveLength(0)
  expect(auxInstancesFor("qa-evicted")).toHaveLength(0)
})

test("a plain remount (no eviction) keeps the aux slot and does not add a duplicate one", async () => {
  const before = mount("qa-remount")
  await before.side.addTab("aux")
  await before.side.addTab("files")
  const aux = auxInstancesFor("qa-remount")[0]!
  expect(before.side.tabs.value.map(({ id, type }) => [id, type])).toEqual([
    [1, "aux"],
    [2, "files"],
  ])

  scopes.pop()!.stop()
  const after = mount("qa-remount")
  expect(after.side.tabs.value.map(({ id, type }) => [id, type])).toEqual([
    [1, "aux"],
    [2, "files"],
  ])
  expect(after.side.tabs.value.filter(tab => tab.type === "aux")).toHaveLength(1)
  expect(aux.tabId).toBe(1)
  expect(controls.kill).not.toHaveBeenCalled()
  expect(controls.spawn).toHaveBeenCalledTimes(1)
})

test("two aux instances keep distinct slots after an eviction remount", async () => {
  const before = mount("qa-two-aux")
  await before.side.addTab("aux")
  await before.side.addTab("aux")
  await before.side.addTab("files")
  const [first, second] = auxInstancesFor("qa-two-aux")
  expect([first!.tabId, second!.tabId]).toEqual([1, 2])

  scopes.pop()!.stop()
  evict()

  const after = mount("qa-two-aux")
  const auxSlots = after.side.tabs.value.filter(tab => tab.type === "aux")
  expect(kindOf(after.side.tabs.value)).toEqual(["files", "aux", "aux"])
  // 两个实例各占一格：共用同一个 id 会让一格渲染两个实例、另一个没有入口。
  expect(new Set(idsOf(auxSlots)).size).toBe(2)
  expect([first!.tabId, second!.tabId]).toEqual(idsOf(auxSlots))
  expect(auxSlots.map(slot => auxTabBySidebarId("qa-two-aux", slot.id)?.runtimeId)).toEqual([
    first!.runtimeId,
    second!.runtimeId,
  ])

  const files = after.side.tabs.value.find(tab => tab.type === "files")!
  await after.side.closeTab(files.id)
  expect(controls.kill).not.toHaveBeenCalled()
  expect(kindOf(after.side.tabs.value)).toEqual(["aux", "aux"])

  // 关一个 aux 只终止它自己，另一个仍在运行。
  await after.side.closeTab(first!.tabId)
  expect(controls.kill.mock.calls.map(([id]) => id)).toEqual([first!.runtimeId])
  expect(auxInstancesFor("qa-two-aux").map(tab => tab.runtimeId)).toEqual([second!.runtimeId])
})

test("adding and closing an aux tab still spawns one process and kills only that instance", async () => {
  const { side } = mount("qa-aux-basic")
  await side.addTab("aux")
  await side.addTab("files")
  const aux = auxInstancesFor("qa-aux-basic")[0]!
  expect(controls.spawn).toHaveBeenCalledTimes(1)
  expect(kindOf(side.tabs.value)).toEqual(["aux", "files"])

  // 关闭普通 Tab：不发 kill（回归：关闭路径按槽位类型判定）。
  await side.closeTab(side.tabs.value.find(tab => tab.type === "files")!.id)
  expect(controls.kill).not.toHaveBeenCalled()
  expect(auxInstancesFor("qa-aux-basic")).toHaveLength(1)

  await side.closeTab(aux.tabId)
  expect(controls.kill.mock.calls.map(([id]) => id)).toEqual([aux.runtimeId])
  expect(auxInstancesFor("qa-aux-basic")).toHaveLength(0)
  expect(side.tabs.value).toHaveLength(0)
})

test("ordinary tabs still fill 20 slots, refuse the 21st and free one when closed", async () => {
  const { side, toast } = mount("qa-capacity")
  for (let index = 0; index < 20; index++) await side.addTab("files")
  expect(side.tabs.value).toHaveLength(20)

  await side.addTab("files")
  expect(side.tabs.value).toHaveLength(20)
  expect(toast).toHaveBeenCalledWith("sidebarTabs.limitReached", "warning")

  await side.closeTab(side.tabs.value[0]!.id)
  expect(side.tabs.value).toHaveLength(19)
  await side.addTab("files")
  expect(side.tabs.value).toHaveLength(20)
})

test("the 25th retained sidebar group is still rejected before any aux spawn", async () => {
  for (let index = 0; index < 24; index++) expect(retainGroup(`qa-full-${index}`)).toBe(true)
  const { side, toast } = mount("qa-overflow")
  await side.addTab("aux")
  expect(side.tabs.value).toHaveLength(0)
  expect(toast).toHaveBeenCalledWith("sidebarTabs.groupLimitReached", "warning")
  expect(controls.spawn).not.toHaveBeenCalled()
})

/**
 * 关闭路径的「跨父会话同号槽」边界（TZD-131 返工，来自质量复验的 `qa-tzd131` 夹具）。
 *
 * 槽位 id 只在一组侧栏 Tab 内唯一：A、B 的首个 aux 都是 `id=1`。若关闭入口在"本组没有
 * 该槽位"时仍按裸 id 查全局实例表，重复关闭或过期手势就会落到另一个父会话的存活实例上。
 *
 * 三条回归与附件用例一一对应：
 * 1. 同父会话内 kill 未返回时重复关闭：先同步撤槽位，再按已解析实例只 kill 一次；
 * 2. A 撤掉自己的槽位后重复关闭：不得误杀 B 组同号的实例；
 * 3. A 组根本没有该槽位：`closeTab(1)` 不得杀 B 组的活实例。
 */
test("a duplicate close while kill is pending removes the slot first and kills only once", async () => {
  const { side } = mount("qa-close")
  await side.addTab("aux")
  const own = auxInstancesFor("qa-close")[0]!

  let releaseKill!: () => void
  let enteredKill!: () => void
  const entered = new Promise<void>(resolve => (enteredKill = resolve))
  const blocked = new Promise<void>(resolve => (releaseKill = resolve))
  const slotsAtKill: number[][] = []
  controls.kill.mockImplementation(async () => {
    slotsAtKill.push(idsOf(side.tabs.value))
    enteredKill()
    await blocked
  })

  const first = side.closeTab(own.tabId)
  try {
    // 槽位与实例都先同步撤掉，用户看到 Tab 立即关闭。
    expect(side.tabs.value).toHaveLength(0)
    expect(auxInstancesFor("qa-close")).toHaveLength(0)
    const second = side.closeTab(own.tabId)
    await entered
    await second
    // 第二次关闭无槽位可撤，也不该再发 kill；第一批 kill 时槽位已空。
    expect(slotsAtKill).toEqual([[]])
    expect(controls.kill.mock.calls).toEqual([[own.runtimeId]])
  } finally {
    releaseKill()
    await first
  }
})

test("a duplicate close after the slot is gone must not kill another parent's aux with the same id", async () => {
  const a = mount("qa-dup-a").side
  const b = mount("qa-dup-b").side
  await a.addTab("aux")
  await b.addTab("aux")
  const own = auxInstancesFor("qa-dup-a")[0]!
  const other = auxInstancesFor("qa-dup-b")[0]!
  expect([own.tabId, other.tabId]).toEqual([1, 1])

  let releaseKill!: () => void
  let enteredKill!: () => void
  const entered = new Promise<void>(resolve => (enteredKill = resolve))
  const blocked = new Promise<void>(resolve => (releaseKill = resolve))
  controls.kill.mockImplementation(async (id: string) => {
    if (id !== own.runtimeId) return
    enteredKill()
    await blocked
  })

  const first = a.closeTab(own.tabId)
  try {
    await entered
    // A 的槽位已撤、实例已摘除：再次向 A 关闭同一个号不得落到 B 的实例上。
    await a.closeTab(own.tabId)
    expect({
      killed: controls.kill.mock.calls.flat(),
      bLive: auxInstancesFor("qa-dup-b").map(tab => tab.runtimeId),
    }).toEqual({
      killed: [own.runtimeId],
      bLive: [other.runtimeId],
    })
  } finally {
    releaseKill()
    await first
  }
})

test("a close of a missing local slot must not kill another parent's live aux", async () => {
  const a = mount("qa-empty").side
  const b = mount("qa-live").side
  await b.addTab("aux")
  const other = auxInstancesFor("qa-live")[0]!
  expect(a.tabs.value).toHaveLength(0)

  await a.closeTab(other.tabId)
  expect({
    killed: controls.kill.mock.calls.flat(),
    bLive: auxInstancesFor("qa-live").map(tab => tab.runtimeId),
  }).toEqual({
    killed: [],
    bLive: [other.runtimeId],
  })
})

/**
 * 延迟准入（TZD-131 收尾，来自质量复验的 `qa-tzd131-delayed-admission` 夹具）。
 *
 * 组满时构造期补不上槽位不该是终态：`ChatView` 仍挂载、组在排队，名额空出后
 * `useSidebarTabs` 会原地准入并补普通 Tab —— 此时也必须**幂等**补回存活 aux，
 * 否则实例活着但没有任何侧栏入口，用户既看不到也关不掉。
 *
 * 两条回归：淘汰组回挂时组满 → 排队 → 释放名额后同一挂载内恢复可关闭的 aux；
 * 以及淘汰后向**旧接线**发过期关闭请求时不撤实例（缺槽不 kill）。
 */
test("a stale close after LRU eviction does not kill the live aux; an admitted remount restores and can close it", async () => {
  const parent = "qa-admit-later"
  const { side: oldSide } = mount(parent)
  await oldSide.addTab("aux")
  await oldSide.addTab("files")
  const aux = auxInstancesFor(parent)[0]!
  // 淘汰前记下旧的槽位 id（=1）：重挂载后它会被文件 Tab 占用，aux 拿到新槽位。
  const oldId = aux.tabId

  scopes.pop()!.stop()
  evict()
  expect(hasGroup(`runtime:${parent}`)).toBe(false)

  // 槽位已随淘汰消失：过期关闭请求不得 kill 实例（缺槽不 kill，不查裸 id 全局表）。
  await oldSide.closeTab(oldId)
  expect(controls.kill).not.toHaveBeenCalled()
  expect(auxInstancesFor(parent).map(tab => tab.runtimeId)).toEqual([aux.runtimeId])

  // 重挂载时组能直接获准：普通 Tab 先恢复，aux 补在自己的槽位上。
  const { side } = mount(parent)
  expect(kindOf(side.tabs.value)).toEqual(["files", "aux"])
  expect(controls.spawn).toHaveBeenCalledTimes(1)

  // 同一挂载内关掉占着旧 id 的普通槽：不 kill；关 aux 槽：只 kill 它自己。
  await side.closeTab(oldId)
  expect(controls.kill).not.toHaveBeenCalled()
  expect(kindOf(side.tabs.value)).toEqual(["aux"])
  await side.closeTab(aux.tabId)
  expect(controls.kill.mock.calls).toEqual([[aux.runtimeId]])
  expect(auxInstancesFor(parent)).toHaveLength(0)
})

test("an evicted aux is restored on deferred group admission without a second remount", async () => {
  const parent = "qa-queued"
  const key = `runtime:${parent}`
  const { side: oldSide } = mount(parent)
  await oldSide.addTab("aux")
  await oldSide.addTab("files")
  const aux = auxInstancesFor(parent)[0]!

  // 卸载 → 24 个别的会话组占满名额 → 组被淘汰。
  scopes.pop()!.stop()
  for (let index = 0; index < 24; index++) mount(`qa-held-${index}`)
  expect(hasGroup(key)).toBe(false)

  // 回挂原会话：名额已满，组进队列（侧栏为空并提示）。
  const { side, toast } = mount(parent)
  expect(hasGroup(key)).toBe(false)
  expect(side.tabs.value).toHaveLength(0)
  expect(toast).toHaveBeenCalledWith("sidebarTabs.groupLimitReached", "warning")

  // 释放一个名额，但**保持本 ChatView 挂载**：组原地获准并载入。
  scopes[0]!.stop()
  await nextTick()
  expect(hasGroup(key)).toBe(true)
  expect(retainedGroupCount(key)).toBe(1)

  // 获准后普通 Tab 与存活 aux 都要有入口，且能在同一挂载内正常关闭。
  expect(kindOf(side.tabs.value)).toEqual(["files", "aux"])
  expect(controls.kill).not.toHaveBeenCalled()
  const auxSlot = side.tabs.value.find(tab => tab.type === "aux")!
  expect(aux.tabId).toBe(auxSlot.id)
  await side.closeTab(auxSlot.id)
  expect(controls.kill.mock.calls).toEqual([[aux.runtimeId]])
  expect(auxInstancesFor(parent)).toHaveLength(0)
})

test("a repeated group admission does not add a duplicate aux slot", async () => {
  const parent = "qa-idempotent"
  // 身份键迁移（`runtime:` → 文件键）会再走一次 `adoptKey` → 组获准回调：
  // 已有 aux 槽位被认领（类型 + 未重复认领的判据），不得因此多补一格。
  const session = reactive({ sessionFile: null as string | null, cwd: "qa" })
  const scope = effectScope()
  scopes.push(scope)
  const side = scope.run(() =>
    useChatViewSidebar({
      runtimeId: parent,
      session: session as never,
      ui: { pushToast: () => {} } as never,
      project: () => "qa",
      onFirstTabAdded() {},
      onLastTabClosed() {},
    }),
  )!
  await side.addTab("aux")
  await side.addTab("files")
  const aux = auxInstancesFor(parent)[0]!

  session.sessionFile = "qa-idempotent.jsonl"
  await nextTick()
  expect(kindOf(side.tabs.value)).toEqual(["aux", "files"])
  expect(side.tabs.value.filter(tab => tab.type === "aux")).toHaveLength(1)
  expect(aux.tabId).toBe(1)
  expect(controls.kill).not.toHaveBeenCalled()
})

/**
 * 换键回滚（TZD-131 返工，来自质量复验的 `qa-tzd131-key-rollback` 夹具）。
 *
 * 文件键已有 `[files, aux]` 且 `files` 已落盘；23 组占满名额后会话回滚为
 * `sessionFile=null`，运行时键排队；名额空出后获准、在**临时键**上补出 `[aux]` ——
 * 若之后重试同一文件键时把这份临时组整组搬过去，会顶掉目标的 `files` 并写 null
 * 删掉磁盘条目（丢 Tab 布局）。因此 `rebindGroup` 只在源含**可落盘** Tab 时才算
 * 非空源；仅由恢复生成的 `aux` 临时组按空源处理，目标与磁盘条目不动。
 */
test("a queued rollback to the runtime key and a retry to the same file key preserve saved tabs", async () => {
  const parent = "qa-key-rollback"
  const file = "qa-key-rollback.jsonl"
  const fileKey = groupKeyFor(parent, file, "qa")
  const runtimeKey = groupKeyFor(parent, null, "qa")
  const session = reactive({ sessionFile: file as string | null, cwd: "qa" })
  const scope = effectScope()
  scopes.push(scope)
  const toast = vi.fn()
  const side = scope.run(() =>
    useChatViewSidebar({
      runtimeId: parent,
      session: session as never,
      ui: { pushToast: toast } as never,
      project: () => "qa",
      onFirstTabAdded() {},
      onLastTabClosed() {},
    }),
  )!
  await side.addTab("files")
  await side.addTab("aux")
  const aux = auxInstancesFor(parent)[0]!
  expect(kindOf(side.tabs.value)).toEqual(["files", "aux"])
  const savedFileTabs = controls.persisted[fileKey]
  expect(savedFileTabs).toBeDefined()

  // 23 个别的会话占满名额（加本会话自己做的那一组共 24）→ 回滚到运行时键只能排队。
  for (let index = 0; index < 23; index++) mount(`qa-key-holder-${index}`)
  session.sessionFile = null
  await nextTick()
  expect(hasGroup(runtimeKey)).toBe(false)
  expect(toast).toHaveBeenCalledWith("sidebarTabs.groupLimitReached", "warning")

  // 释放一个名额、保持本 ChatView 挂载：运行时键原地获准，只补回存活 aux。
  scopes[1]!.stop()
  await nextTick()
  expect(retainedGroupCount(runtimeKey)).toBe(1)
  expect(kindOf(tabsFor(runtimeKey))).toEqual(["aux"])
  expect(controls.persisted[fileKey]).toEqual(savedFileTabs)

  // 重试同一文件键：临时键上的 `[aux]` 不得顶掉目标的普通 Tab，也不得删掉磁盘条目。
  session.sessionFile = file
  await nextTick()
  expect(kindOf(side.tabs.value)).toEqual(["files", "aux"])
  expect(controls.persisted[fileKey]).toEqual(savedFileTabs)
  expect(auxInstancesFor(parent).map(tab => tab.runtimeId)).toEqual([aux.runtimeId])
  expect(controls.spawn).toHaveBeenCalledTimes(1)
  expect(controls.kill).not.toHaveBeenCalled()
  // 原 aux 只有一格，且能在同一挂载内关闭。
  const auxSlots = side.tabs.value.filter(tab => tab.type === "aux")
  expect(auxSlots).toHaveLength(1)
  expect(aux.tabId).toBe(auxSlots[0]!.id)
  await side.closeTab(auxSlots[0]!.id)
  expect(controls.kill.mock.calls).toEqual([[aux.runtimeId]])
})

/**
 * 在途创建 + 换键：异步收尾不得再用创建时的旧槽位 id（TZD-131 返工，来自
 * 质量复验的 `qa-tzd131-slot-reuse-boundary` 夹具）。
 *
 * `addAux` / `openForAsk` 会在 spawn 期间继续等到结果；这段时间里会话身份键可能变化
 * （`runtime:` → 文件键），槽位被重排，旧 id 可能已经属于普通 Tab。收尾必须按实例的
 * **当前** `tabId` 验证槽位归属：成功只激活真实存在的 aux 格；失败/关闭只撤仍无主的
 * aux 格，绝不按旧 id 删普通 Tab（及其落盘布局）。
 */
function keyedRuntime(runtimeId: string) {
  const scope = effectScope()
  scopes.push(scope)
  const session = reactive({ sessionFile: null as string | null, cwd: "qa" })
  const side = scope.run(() =>
    useChatViewSidebar({
      runtimeId,
      session: session as never,
      ui: { pushToast() {} } as never,
      project: () => "qa",
      onFirstTabAdded() {},
      onLastTabClosed() {},
    }),
  )!
  return { side, session, scope }
}

/** 文件键上已有 `[files]` 并落盘；aux 在临时运行时键上以 id=1 启动，期间换到该文件键。 */
async function pendingAuxAcrossKey(parent: string) {
  const file = `${parent}.jsonl`
  const fileKey = groupKeyFor(parent, file, "qa")
  const saved = { kinds: ["files"], active: 0 }
  controls.persisted[fileKey] = saved
  const { side, session } = keyedRuntime(parent)
  let finish!: () => void
  controls.spawn.mockImplementationOnce(() => new Promise<void>(resolve => (finish = resolve)))
  const opening = side.addTab("aux")
  expect(auxInstancesFor(parent)[0]?.tabId).toBe(1)
  session.sessionFile = file
  await nextTick()
  return { side, fileKey, saved, finish, opening }
}

test("spawn completion after an aux-only rebind activates the new aux id, not the reused ordinary id", async () => {
  const parent = "qa-pending-focus"
  const { side, finish, opening } = await pendingAuxAcrossKey(parent)
  try {
    expect(side.tabs.value.map(tab => [tab.id, tab.type])).toEqual([
      [1, "files"],
      [2, "aux"],
    ])
    // 换键后 aux 已搬到 2；启动成功只能激活 2，不能把焦点切到复用了旧 id 的文件 Tab。
    expect(side.activeId.value).toBe(2)
  } finally {
    finish()
    await opening
  }
  expect(auxInstancesFor(parent)[0]?.status).toBe("ready")
  expect(side.activeId.value).toBe(2)
})

test("closing a relocated aux before spawn completes must not delete the ordinary tab at its old id", async () => {
  const parent = "qa-pending-close"
  const { side, fileKey, saved, finish, opening } = await pendingAuxAcrossKey(parent)
  try {
    expect(side.tabs.value.map(tab => [tab.id, tab.type])).toEqual([
      [1, "files"],
      [2, "aux"],
    ])
    await side.closeTab(2)
    expect(kindOf(side.tabs.value)).toEqual(["files"])
    expect(controls.persisted[fileKey]).toEqual(saved)
  } finally {
    finish()
    await opening
  }
  // 迟到的 spawn 收尾不能再按旧 id=1 撤槽位：文件 Tab 与其落盘布局都必须在。
  expect({
    tabs: kindOf(side.tabs.value),
    saved: controls.persisted[fileKey],
    live: auxInstancesFor(parent).length,
  }).toEqual({ tabs: ["files"], saved, live: 0 })
})

test("a brand-new saved key keeps an active aux through an in-flight id remap", async () => {
  const parent = "qa-pending-new-key"
  const { side, session } = keyedRuntime(parent)
  await side.addTab("files") // 占住并随后释放 id=1；aux 从 id=2 开始。
  let finish!: () => void
  controls.spawn.mockImplementationOnce(() => new Promise<void>(resolve => (finish = resolve)))
  const opening = side.addTab("aux")
  try {
    await side.closeTab(1)
    expect(kindOf(side.tabs.value)).toEqual(["aux"])
    expect(auxInstancesFor(parent)[0]?.tabId).toBe(2)
    session.sessionFile = "qa-new-key-with-no-saved-tabs.jsonl"
    await nextTick()
    expect(kindOf(side.tabs.value)).toEqual(["aux"])
  } finally {
    finish()
    await opening
  }
  // 换键后实例被搬到 1（新键上重新编号）：激活必须跟当前 tabId，而不是创建时的 2。
  const current = auxInstancesFor(parent)[0]!
  expect(current.status).toBe("ready")
  expect(idsOf(side.tabs.value)).toEqual([current.tabId])
  expect(side.activeId.value).toBe(current.tabId)
})

test("two instances keep their own slots when one still holds a slot of the other", async () => {
  const parent = "qa-slot-claim"
  const { side } = mount(parent)
  await side.addTab("files")
  await side.addTab("aux")
  await side.addTab("aux")
  const [file, spare, existing] = side.tabs.value
  const [first, second] = auxInstancesFor(parent)
  expect([first!.tabId, second!.tabId]).toEqual([spare!.id, existing!.id])
  // 让后登记者持有备用格的旧 id：重挂载时先锁定精确匹配，再分配备用格，不得两实例同格。
  setAuxTabId(second!.runtimeId, spare!.id)
  side.reorder([file!, existing!, spare!])
  const idsBefore = idsOf(side.tabs.value)
  scopes.pop()!.stop()
  const after = mount(parent)
  expect(idsOf(after.side.tabs.value)).toEqual(idsBefore)
  expect([first!.tabId, second!.tabId]).toEqual([spare!.id, existing!.id])
  // 按格关闭各自只杀对应实例。
  await after.side.closeTab(existing!.id)
  expect(controls.kill.mock.calls).toEqual([[second!.runtimeId]])
  expect(auxInstancesFor(parent).map(tab => tab.runtimeId)).toEqual([first!.runtimeId])
})

/**
 * 满槽换键撞号（TZD-131 返工，来自质量复验的 `qa-tzd131-rebase-capacity` 夹具）。
 *
 * 同父临时组有 6 个存活 aux（旧槽号 16–21），换到已有 15 个普通 Tab 的文件键：本组只
 * 容得下 5 个 aux（20 格上限）。第 6 个补格失败时若**继续留着旧号 21**，后来新建分到
 * 同一个号就会两实例共用一格 —— 显示/关闭都命中旧的，新的没有入口。
 *
 * 因此补格失败的实例一律**收回槽位号**（`tabId = null`，缺槽不 kill），退出按槽位的
 * 查找；名额空出后优先给它补格。
 */
async function rebindAtCapacity(parent: string, count: number, savedCount = 15) {
  const session = reactive({ sessionFile: null as string | null, cwd: "qa" })
  const file = `${parent}.jsonl`
  const scope = effectScope()
  scopes.push(scope)
  const toast = vi.fn()
  const side = scope.run(() =>
    useChatViewSidebar({
      runtimeId: parent,
      session: session as never,
      ui: { pushToast: toast } as never,
      project: () => "qa",
      onFirstTabAdded() {},
      onLastTabClosed() {},
    }),
  )!
  // 先开 15 格再逐一关闭，让 aux 的槽号从 16 起（仍在上限内）。
  for (let index = 0; index < 15; index++) {
    await side.addTab("files")
    await side.closeTab(side.tabs.value[0]!.id)
  }
  for (let index = 0; index < count; index++) await side.addTab("aux")
  const original = auxInstancesFor(parent)
  expect(original.map(aux => aux.tabId)).toEqual(Array.from({ length: count }, (_, index) => 16 + index))

  const fileKey = groupKeyFor(parent, file, "qa")
  const saved = { kinds: Array.from({ length: savedCount }, () => "files"), active: 0 }
  controls.persisted[fileKey] = saved
  session.sessionFile = file
  await nextTick()
  return { original, side, saved }
}

test("aux restored within the slot limit keep their own slots after a 15+5 rebind", async () => {
  const parent = "qa-exact-cap"
  const { original, side } = await rebindAtCapacity(parent, 5)
  expect(kindOf(side.tabs.value)).toEqual([
    ...Array.from({ length: 15 }, () => "files"),
    ...Array.from({ length: 5 }, () => "aux"),
  ])
  const slots = side.tabs.value.filter(tab => tab.type === "aux")
  expect(slots.map(slot => auxTabBySidebarId(parent, slot.id)?.runtimeId)).toEqual(original.map(tab => tab.runtimeId))
  expect(controls.spawn).toHaveBeenCalledTimes(5)
})

test("an aux that could not get a slot on a full rebind drops its old id and is restored when a slot frees", async () => {
  const parent = "qa-over-cap"
  const { original, side } = await rebindAtCapacity(parent, 6)
  const overflowed = original[5]!
  // 20 格已满：第 6 个 aux 没有入口，但进程仍在。
  expect(kindOf(side.tabs.value).filter(type => type === "aux")).toHaveLength(5)
  expect(overflowed.tabId).toBeNull()
  expect(auxTabBySidebarId(parent, 21)).toBeUndefined()
  expect(controls.kill).not.toHaveBeenCalled()
  expect(auxInstancesFor(parent)).toHaveLength(6)

  // 关一个普通 Tab（15 → 14）：名额优先补回第 6 个，而不是留给下一次新建。
  const files = side.tabs.value.find(tab => tab.type === "files")!
  await side.closeTab(files.id)
  const restoredSlot = side.tabs.value
    .filter(tab => tab.type === "aux")
    .find(slot => auxTabBySidebarId(parent, slot.id)?.runtimeId === overflowed.runtimeId)
  expect(restoredSlot).toBeDefined()
  expect(overflowed.tabId).toBe(restoredSlot!.id)
  expect(controls.kill).not.toHaveBeenCalled()

  // 此刻 20 格已满（14 文件 + 6 aux）：再开 aux 会被上限拒绝，且不新增实例。
  await side.addTab("aux")
  expect(auxInstancesFor(parent)).toHaveLength(6)
  expect(side.tabs.value).toHaveLength(20)

  // 再腾一格后新建：新实例拿到的是另一个号，两实例各占一格、互不干扰。
  await side.closeTab(side.tabs.value.find(tab => tab.type === "files")!.id)
  await side.addTab("aux")
  const newest = auxInstancesFor(parent)[6]!
  expect(newest.tabId).not.toBe(overflowed.tabId)
  const instancesAtNewSlot = auxInstancesFor(parent)
    .filter(tab => tab.tabId === newest.tabId)
    .map(tab => tab.runtimeId)
  expect(instancesAtNewSlot).toEqual([newest.runtimeId])
  expect(auxTabBySidebarId(parent, newest.tabId!)?.runtimeId).toBe(newest.runtimeId)

  await side.closeTab(newest.tabId!)
  expect(controls.kill.mock.calls.flat()).toEqual([newest.runtimeId])
  expect(auxInstancesFor(parent).map(tab => tab.runtimeId)).toContain(overflowed.runtimeId)
  // 磁盘上的普通 Tab 布局跟着实际关闭数变化（aux 永不落盘），此处只核对没有 aux 混入。
  const persisted = controls.persisted[groupKeyFor(parent, `${parent}.jsonl`, "qa")] as { kinds: string[] }
  expect(persisted.kinds.every(kind => kind === "files")).toBe(true)
  expect(persisted.kinds.length).toBe(side.tabs.value.filter(tab => tab.type === "files").length)
})

/**
 * 等位实例不能被当成可用目标（TZD-131 返工，来自质量复验的 `qa-tzd131-waiting-slots`）。
 *
 * 补格失败的实例（`tabId === null`）仍在跑、草稿也保留，但它**没有面板入口**：把它列进
 * 划词菜单、或被单实例自动路由挑中，只会把引用写进一个用户打不开的待发送桶，而且不报错。
 * 因此目标必须按「确有本组槽位」过滤；没有可用目标时沿用容量不足的失败提示。
 */
test("a slotless waiting aux is not offered as a target and never receives a hidden reference", async () => {
  const parent = "qa-waiting-targets"
  const { side } = await rebindAtCapacity(parent, 6)
  const hidden = auxInstancesFor(parent)[5]!
  expect(hidden.tabId).toBeNull()
  const files = side.tabs.value.find(tab => tab.type === "files")!
  side.activeId.value = files.id

  // 菜单只列有入口的实例：等位实例不在候选里。
  expect(side.auxTargets.value.map(target => target.runtimeId)).not.toContain(hidden.runtimeId)
  expect(side.auxTargets.value).toHaveLength(5)

  // 显式选中它（例如浮层里的旧选项）：拒绝、不写桶、保持原激活、不激活不存在的格。
  const refused = await side.askAux({ text: "quote from the parent conversation" }, hidden.runtimeId)
  expect(refused.ok).toBe(false)
  expect(auxSelectionItems(hidden.runtimeId)).toHaveLength(0)
  expect(side.activeId.value).toBe(files.id)
})

test("the automatic single-aux route ignores a slotless instance and reports failure", async () => {
  const parent = "qa-waiting-auto"
  // 20 个普通 Tab 的文件键 + 1 个 aux：换键后这个 aux 没有槽位，是组里唯一的实例。
  const { side } = await rebindAtCapacity(parent, 1, 20)
  const hidden = auxInstancesFor(parent)[0]!
  expect(hidden.tabId).toBeNull()
  expect(side.tabs.value.every(tab => tab.type === "files")).toBe(true)
  expect(side.auxTargets.value).toHaveLength(0)

  const auto = await side.askAux({ text: "quote via the single-aux automatic route" })
  expect(auto.ok).toBe(false)
  expect(auxSelectionItems(hidden.runtimeId)).toHaveLength(0)
})

/**
 * 投递前的"入口"判据必须问**当前侧栏组**（TZD-131 返工，来自 `qa-tzd131-live-aux-entry`）。
 *
 * 实例表里的 `tabId` 是"上一次分配到的号"：组被淘汰/排队/换键后它与当前组无关。若只拿
 * 实例表自查，就会把引用写进一个打不开的桶。两条典型路径：
 * 1. 划词选「新建」、spawn 在途时换到已满（20 个普通 Tab）的文件键 → 新实例无槽位，
 *    放行 spawn 后仍不能算投递成功；
 * 2. 24 组占满时回滚身份键 → 新运行时组排队、侧栏无任何槽，但实例还带旧 `tabId = 1`，
 *    候选、显式目标与自动路由都必须拒绝。
 */
test("an in-flight new aux that lost its slot during a rebind must not accept the reference", async () => {
  const parent = "qa-live-new-rebind"
  const mounted = keyedRuntime(parent)
  let finish!: () => void
  controls.spawn.mockImplementationOnce(() => new Promise<void>(resolve => (finish = resolve)))
  const asking = mounted.side.askAux({ text: "in-flight new quote" }, null)
  const instance = auxInstancesFor(parent)[0]!
  try {
    expect(instance.tabId).not.toBeNull()
    controls.persisted[groupKeyFor(parent, `${parent}.jsonl`, "qa")] = {
      kinds: Array.from({ length: 20 }, () => "files"),
      active: 0,
    }
    mounted.session.sessionFile = `${parent}.jsonl`
    await nextTick()
    expect(kindOf(mounted.side.tabs.value)).toEqual(Array.from({ length: 20 }, () => "files"))
    expect(instance.tabId).toBeNull()
    finish()
    const outcome = await asking
    expect(outcome.ok).toBe(false)
    expect(auxSelectionItems(instance.runtimeId)).toHaveLength(0)
  } finally {
    finish()
    await asking
  }
})

test("an aux whose group is queued at the 24-group limit is neither offered nor delivered to", async () => {
  const parent = "qa-live-queued"
  const session = reactive({ sessionFile: `${parent}.jsonl` as string | null, cwd: "qa" })
  const scope = effectScope()
  scopes.push(scope)
  const side = scope.run(() =>
    useChatViewSidebar({
      runtimeId: parent,
      session: session as never,
      ui: { pushToast: () => {} } as never,
      project: () => "qa",
      onFirstTabAdded() {},
      onLastTabClosed() {},
    }),
  )!
  await side.addTab("aux")
  const instance = auxInstancesFor(parent)[0]!
  for (let index = 0; index < 23; index++) expect(retainGroup(`qa-pinned-${index}`)).toBe(true)

  // 回滚身份键：新运行时组排队，当前侧栏没有任何槽，但实例还带旧号 1。
  session.sessionFile = null
  await nextTick()
  expect(side.tabs.value).toHaveLength(0)
  expect(instance.tabId).toBe(1)
  expect(side.auxTargets.value).toHaveLength(0)

  const explicit = await side.askAux({ text: "explicit quote into the old group" }, instance.runtimeId)
  const auto = await side.askAux({ text: "automatic quote into the old group" })
  expect([explicit.ok, auto.ok]).toEqual([false, false])
  expect(auxSelectionItems(instance.runtimeId)).toHaveLength(0)
  for (let index = 0; index < 23; index++) releaseGroup(`qa-pinned-${index}`)
})

/**
 * 父视图卸载后的划词投递（TZD-131 返工，来自 `qa-tzd131-router-disposal`）。
 *
 * `useAuxTabs` 的 `onScopeDispose` 会注销该父会话的 router；此时实例仍在表里、还带着
 * 旧槽号，但它**没有任何当前组的入口**。因此不能靠"实例表自查"兜底：没有当前 router
 * 一律视为无入口 —— 候选为空、投递 `unavailable`、不写桶（与「父视图卸载后不投递」
 * 的既有契约一致）。重新挂载且当前入口有效时，在途请求仍应正常投给原实例。
 */
test("an in-flight quote must not land in a live aux after the parent view was disposed", async () => {
  const parent = "qa-scope-away"
  const mounted = keyedRuntime(parent)
  let finish!: () => void
  controls.spawn.mockImplementationOnce(() => new Promise<void>(resolve => (finish = resolve)))
  const asking = mounted.side.askAux({ text: "quote while the parent view goes away" }, null)
  const instance = auxInstancesFor(parent)[0]!
  try {
    expect(instance.tabId).toBe(1)
    mounted.scope.stop()
    // 实例还带着旧号，但当前组没有入口：候选为空、新请求被拒。
    expect(auxDeliverableFor(parent)).toHaveLength(0)
    const later = await mounted.side.askAux({ text: "a new handoff after disposal" }, instance.runtimeId)
    expect(later.ok).toBe(false)
    finish()
    const outcome = await asking
    expect({
      result: outcome.ok ? "ok" : outcome.reason,
      quotes: auxSelectionItems(instance.runtimeId).length,
      alive: auxInstancesFor(parent)[0]?.runtimeId,
      killed: controls.kill.mock.calls.flat(),
    }).toEqual({ result: "unavailable", quotes: 0, alive: instance.runtimeId, killed: [] })
  } finally {
    finish()
    await asking
  }
})

test("a remounted parent with an authoritative entry still receives the in-flight quote", async () => {
  const parent = "qa-scope-remount"
  const mounted = keyedRuntime(parent)
  let finish!: () => void
  controls.spawn.mockImplementationOnce(() => new Promise<void>(resolve => (finish = resolve)))
  const asking = mounted.side.askAux({ text: "quote with a live entry restored" }, null)
  const instance = auxInstancesFor(parent)[0]!
  try {
    mounted.scope.stop()
    const remounted = keyedRuntime(parent)
    expect(remounted.side.auxTargets.value.map(tab => tab.runtimeId)).toEqual([instance.runtimeId])
    finish()
    const outcome = await asking
    expect(outcome.ok && outcome.tab.runtimeId).toBe(instance.runtimeId)
    expect(auxSelectionItems(instance.runtimeId)).toHaveLength(1)
    expect(remounted.side.activeId.value).toBe(instance.tabId)
    expect(controls.spawn).toHaveBeenCalledTimes(1)
    expect(controls.kill).not.toHaveBeenCalled()
  } finally {
    finish()
    await asking
  }
})
