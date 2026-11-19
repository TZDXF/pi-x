import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/**
 * `askInAux` 的路由与去重（TZD-103）。
 *
 * 覆盖四件事：
 * 1. 有**激活**的 aux → 引用进它的桶，且不新建进程（只 reveal 一次）；
 * 2. 没有激活但有存活实例 → 复用最近一个（不新建）；
 * 3. 一个都没有 → 新建并把引用投进新实例的桶；
 * 4. 连点同一手势 → 只建一个实例、引用不重复；新建未完成/入口缺失 → 不写任何桶。
 *
 * `@/api/piClient` 全部替身：不触碰真实模型/进程。
 */
const controls = vi.hoisted(() => ({ rpcRequest: vi.fn(), kill: vi.fn(async () => {}) }))

vi.mock("@/api/piClient", () => ({
  adoptSession: async () => {},
  sessionHistory: async () => [],
  sessionLastError: async () => null,
  sessionMtime: async () => 0,
  generateSessionTitle: async () => ({ title: "" }),
  getPiSettings: async () => ({ retry: { enabled: true } }),
  getModelsConfig: async () => ({ providers: [] }),
  rpcNotify: async () => {},
  rpcRequest: (...args) => controls.rpcRequest(...args),
  pixLog() {},
}))
vi.mock("@/api/transport", () => ({ invoke: async () => null }))
vi.mock("@/i18n", () => ({ i18n: { global: { t: key => key } }, tBackendError: value => String(value ?? "") }))
vi.mock("@/lib/fileRewind", () => ({ fileRewindState: async () => [] }))
vi.mock("@/lib/notifications", () => ({ notifyTurnComplete() {}, notifyQuestion() {} }))
vi.mock("@/stores/sessionRunStatus", () => ({
  setSessionRunStatus() {},
  sessionRunStatus: () => undefined,
  sessionActivitySnapshot: () => undefined,
}))
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: () => ({ histories: {}, projectName: path => path, refresh: async () => {}, preview() {} }),
}))

type Module = typeof import("@/stores/auxChat")
let aux: Module
let buckets: typeof import("@/stores/auxSelections")

beforeEach(async () => {
  setActivePinia(createPinia())
  // `isolate: false`：模块缓存跨文件共享，重置后重新求值才能拿到干净的注册表。
  vi.resetModules()
  aux = await import("@/stores/auxChat")
  buckets = await import("@/stores/auxSelections")
  aux.registerAuxRuntimeBridge({ kill: controls.kill })
  controls.rpcRequest.mockReset()
  controls.rpcRequest.mockImplementation(async () => ({ success: true, data: {} }))
})

afterEach(() => aux.resetAuxChatForTest())

/** 造一个存活实例（走真实 `openAux`，含同步入表与 store 创建）。 */
async function liveTab(parent: string, tabId: number) {
  return (await aux.openAux(parent, { tabId, titlePrefix: "aux", spawn: async () => {} }))!
}

test("askInAux delivers into the activated tab's bucket without creating a process", async () => {
  const parent = "runtime:parent"
  const tab = await liveTab(parent, 10)
  let opened = 0
  aux.registerAuxAskRouter(parent, {
    active: () => tab,
    open: async () => {
      opened += 1
      return null
    },
    reveal: () => {},
  })
  const outcome = await aux.askInAux(parent, { text: "选中的正文", source: "assistant", messageId: 4 })
  expect(outcome).toMatchObject({ ok: true, tab: { runtimeId: tab.runtimeId }, duplicate: false })
  expect(buckets.auxSelectionItems(tab.runtimeId).map(item => item.text)).toEqual(["选中的正文"])
  expect(opened).toBe(0)
  expect(aux.auxLiveCount()).toBe(1)
})

test("without an activated tab a live instance is reused instead of opening another", async () => {
  const parent = "runtime:parent"
  const first = await liveTab(parent, 11)
  const second = await liveTab(parent, 12)
  let opened = 0
  aux.registerAuxAskRouter(parent, {
    active: () => null,
    open: async () => {
      opened += 1
      return null
    },
    reveal: () => {},
  })
  const outcome = await aux.askInAux(parent, { text: "正文" })
  expect(outcome.ok).toBe(true)
  // 复用"最近一个"（`activeAuxFor` 的实现顺序），不新开进程。
  expect(outcome.ok && outcome.tab.runtimeId).toBe(second.runtimeId)
  expect(buckets.auxSelectionItems(second.runtimeId)).toHaveLength(1)
  expect(buckets.auxSelectionItems(first.runtimeId)).toHaveLength(0)
  expect(opened).toBe(0)
})

test("multiple live instances honor the selected target or an explicit new-chat choice", async () => {
  const parent = "runtime:parent"
  const first = await liveTab(parent, 13)
  const second = await liveTab(parent, 14)
  let opened = 0
  let created: Awaited<ReturnType<typeof liveTab>> | null = null
  aux.registerAuxAskRouter(parent, {
    // 即使有激活项，显式选择也不能被它覆盖。
    active: () => first,
    open: async () => {
      opened += 1
      created = await liveTab(parent, 15)
      return created
    },
    reveal: () => {},
  })

  const selected = await aux.askInAux(parent, { text: "给第二个" }, second.runtimeId)
  expect(selected.ok && selected.tab.runtimeId).toBe(second.runtimeId)
  expect(buckets.auxSelectionItems(first.runtimeId)).toHaveLength(0)
  expect(buckets.auxSelectionItems(second.runtimeId).map(item => item.text)).toEqual(["给第二个"])
  expect(opened).toBe(0)

  const fresh = await aux.askInAux(parent, { text: "给新对话" }, null)
  expect(fresh.ok && fresh.tab.runtimeId).toBe(created!.runtimeId)
  expect(opened).toBe(1)
  expect(buckets.auxSelectionItems(created!.runtimeId).map(item => item.text)).toEqual(["给新对话"])

  // 选择态打开后实例可能已关闭，或父会话已切换；不得悄悄改投激活/最近实例。
  const stale = await aux.askInAux(parent, { text: "旧选项" }, "aux:missing")
  expect(stale).toEqual({ ok: false, reason: "unavailable" })
  aux.registerAuxAskRouter("runtime:other", { active: () => null, open: async () => null, reveal: () => {} })
  const wrongParent = await aux.askInAux("runtime:other", { text: "跨会话" }, second.runtimeId)
  expect(wrongParent).toEqual({ ok: false, reason: "unavailable" })
})

test("with no live instance the router opens one and the reference lands in its bucket", async () => {
  const parent = "runtime:parent"
  let revealCount = 0
  let created: Module["auxTabs"] extends () => (infer T)[] ? T : never
  aux.registerAuxAskRouter(parent, {
    active: () => null,
    open: async () => {
      created = await liveTab(parent, 20)
      return created
    },
    reveal: () => {
      revealCount += 1
    },
  })
  const outcome = await aux.askInAux(parent, { text: "正文" })
  expect(outcome.ok).toBe(true)
  expect(buckets.auxSelectionCount(created!.runtimeId)).toBe(1)
  // 新建后要把面板切到激活（否则引用进了桶但用户看不到）。
  expect(revealCount).toBe(1)
})

test("repeated gestures in the same turn create one instance and one reference", async () => {
  const parent = "runtime:parent"
  let opens = 0
  let tab: Awaited<ReturnType<typeof liveTab>> | null = null
  aux.registerAuxAskRouter(parent, {
    active: () => null,
    open: async () => {
      opens += 1
      // 模拟真实 openAux：第一次同步入表，第二次进来时表里已有实例。
      tab ??= await liveTab(parent, 30)
      return tab
    },
    reveal: () => {},
  })
  const payload = { text: "同一段选中" }
  const [a, b] = await Promise.all([aux.askInAux(parent, payload), aux.askInAux(parent, payload)])
  expect(a.ok && b.ok).toBe(true)
  expect(aux.auxLiveCount()).toBe(1)
  expect(buckets.auxSelectionCount(tab!.runtimeId)).toBe(1)
  // 引用不重复：两个手势里恰好一个是"判重成功"（谁先落库取决于 await 顺序，不作断言）。
  expect(a.ok && b.ok).toBe(true)
  expect([a.ok && a.duplicate, b.ok && b.duplicate].filter(Boolean)).toHaveLength(1)
  expect(opens).toBeLessThanOrEqual(2)
})

test("no router or an unfinished creation writes into no bucket at all", async () => {
  const parent = "runtime:parent"
  // 入口未接线（没有 ChatView 挂载该父会话）：不写桶，返回 unavailable。
  const missing = await aux.askInAux(parent, { text: "正文" })
  expect(missing).toEqual({ ok: false, reason: "unavailable" })
  expect(aux.auxLiveCount()).toBe(0)

  // **入口优先**（P2-2）：实例还活着、但父 ChatView 已卸载（router 注销）时，
  // 仍必须是 `unavailable` 且一个字都不写桶 —— 否则会留下投不进也看不到的引用。
  const orphan = await liveTab(parent, 45)
  const orphaned = await aux.askInAux(parent, { text: "无入口的引用" })
  expect(orphaned).toEqual({ ok: false, reason: "unavailable" })
  expect(buckets.auxSelectionCount(orphan.runtimeId)).toBe(0)

  // 入口可用、实例也还活着 → 复用那个实例（这是裁定过的语义：有实例就别新建）。
  aux.registerAuxAskRouter(parent, { active: () => null, open: async () => null, reveal: () => {} })
  const reused = await aux.askInAux(parent, { text: "入口恢复后的引用" })
  expect(reused.ok && reused.tab.runtimeId).toBe(orphan.runtimeId)
  expect(buckets.auxSelectionCount(orphan.runtimeId)).toBe(1)

  // 新建未完成（例如通用侧栏容量不足或创建期间被关闭）：返回 unavailable，引用不入任何桶。
  aux.registerAuxAskRouter("runtime:empty", { active: () => null, open: async () => null, reveal: () => {} })
  const unfinished = await aux.askInAux("runtime:empty", { text: "正文" })
  expect(unfinished).toEqual({ ok: false, reason: "unavailable" })
})

test("the append limits are reported back instead of silently dropping the reference", async () => {
  const parent = "runtime:parent"
  const tab = await liveTab(parent, 50)
  aux.registerAuxAskRouter(parent, { active: () => tab, open: async () => null, reveal: () => {} })
  const outcome = await aux.askInAux(parent, { text: "x".repeat(9_000) })
  expect(outcome).toEqual({ ok: false, reason: "append", appendReason: "single" })
  expect(buckets.auxSelectionCount(tab.runtimeId)).toBe(0)
})

test("closing an aux instance drops its bucket, and late settlement drops it too", async () => {
  const parent = "runtime:parent"
  const tab = await liveTab(parent, 60)
  aux.registerAuxAskRouter(parent, { active: () => tab, open: async () => null, reveal: () => {} })
  await aux.askInAux(parent, { text: "正文" })
  expect(buckets.auxSelectionCount(tab.runtimeId)).toBe(1)
  await aux.closeAux(tab.runtimeId)
  expect(buckets.auxSelectionCount(tab.runtimeId)).toBe(0)

  // 迟到收尾（墓碑命中或实例已不在表里）同样清桶：否则内存里留一份永远发不出去的引用。
  buckets.addAuxSelection("aux:ghost", { text: "正文" })
  expect(buckets.auxSelectionCount("aux:ghost")).toBe(1)
  expect(await aux.settleLateAux("aux:ghost")).toBe(true)
  expect(buckets.auxSelectionCount("aux:ghost")).toBe(0)
})

test("the runtime id, not the parent, keys the bucket: two aux of one parent stay separate", async () => {
  const parent = "runtime:parent"
  const a = await liveTab(parent, 70)
  const b = await liveTab(parent, 71)
  aux.registerAuxAskRouter(parent, { active: () => a, open: async () => null, reveal: () => {} })
  await aux.askInAux(parent, { text: "给 A" })
  aux.registerAuxAskRouter(parent, { active: () => b, open: async () => null, reveal: () => {} })
  await aux.askInAux(parent, { text: "给 B" })
  expect(buckets.auxSelectionItems(a.runtimeId).map(item => item.text)).toEqual(["给 A"])
  expect(buckets.auxSelectionItems(b.runtimeId).map(item => item.text)).toEqual(["给 B"])
})
