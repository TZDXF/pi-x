import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, getActivePinia, setActivePinia } from "pinia"

/**
 * aux（辅助对话）注册表的单测：序号分配、上限 5（含创建中）、关闭即销毁的清理序列、
 * spawn 失败的 coded error、迟到事件的墓碑丢弃。
 *
 * 不访问任何真实模型/进程：`@/api/piClient` 全部替身，`kill` 走注入的 bridge。
 */
const controls = vi.hoisted(() => ({
  rpcRequest: vi.fn(),
  kill: vi.fn(async () => {}),
}))

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
vi.mock("@/i18n", () => ({
  i18n: { global: { t: key => key } },
  tBackendError: value => String(value ?? ""),
}))
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

const reset = vi.hoisted(() => ({ fn: null as null | (() => void) }))
// 部分替身：只为拿到 `resetAuxChatForTest` 的句柄，其余保持真实实现。
vi.mock("@/stores/auxChat", async importOriginal => {
  const actual = await importOriginal<typeof import("@/stores/auxChat")>()
  const wrapped = {
    ...actual,
    resetAuxChatForTest: () => {
      actual.resetAuxChatForTest()
      reset.fn = actual.resetAuxChatForTest
    },
  }
  reset.fn = actual.resetAuxChatForTest
  return wrapped
})

const { AUX_MAX_TABS, nextAuxOrdinal } = await import("@/lib/auxRuntime")
const {
  auxCanOpen,
  auxCreationPending,
  auxLiveCount,
  auxSessionFor,
  auxTabByRuntime,
  auxTabBySidebarId,
  auxUiFor,
  auxTabs,
  closeAux,
  isClosedAux,
  openAux,
  registerAuxRuntimeBridge,
} = await import("@/stores/auxChat")
const { auxDraftCount, clearAuxDraft, saveAuxDraft } = await import("@/stores/auxDrafts")
const { uiFor } = await import("@/stores/conversations")
const { encodeCodedError } = await import("@/lib/backendError")

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  reset.fn?.()
  controls.kill.mockClear()
  registerAuxRuntimeBridge({ kill: controls.kill })
})

afterEach(() => {
  vi.unstubAllGlobals()
  reset.fn?.()
})

test("ordinals fill the smallest free positive integer and are reused after a close", () => {
  expect(nextAuxOrdinal([])).toBe(1)
  expect(nextAuxOrdinal([1])).toBe(2)
  // 关掉 2 之后新开一个复用 2，而不是累加到 3。
  expect(nextAuxOrdinal([1, 3])).toBe(2)
  expect(nextAuxOrdinal([1, 2, 3])).toBe(4)
})

test("each aux instance gets a distinct aux: runtime id, ordinal and title", async () => {
  const first = await openAux("runtime:parent", { tabId: 10, titlePrefix: "aux", spawn: async () => {} })
  const second = await openAux("runtime:parent", { tabId: 11, titlePrefix: "aux", spawn: async () => {} })
  expect(first?.ordinal).toBe(1)
  expect(second?.ordinal).toBe(2)
  expect(first?.title).toBe("aux 1")
  expect(second?.title).toBe("aux 2")
  expect(first?.runtimeId.startsWith("aux:")).toBe(true)
  expect(first?.runtimeId).not.toBe(second?.runtimeId)
  expect(auxTabBySidebarId(10)?.runtimeId).toBe(first?.runtimeId)
})

test("every instance carries a stable local clientId for later lease/reconnect filtering", async () => {
  const { currentAuxClientId } = await import("@/stores/auxChat")
  const a = await openAux("runtime:a", { tabId: 1, titlePrefix: "aux", spawn: async () => {} })
  const b = await openAux("runtime:b", { tabId: 2, titlePrefix: "aux", spawn: async () => {} })
  expect(a?.clientId).toBeTruthy()
  // 同一客户端内实例共享一个 id（④ 的"只恢复本机条目"按它筛选）。
  expect(a?.clientId).toBe(b?.clientId)
  expect(a?.clientId).toBe(currentAuxClientId())
})

test("a different parent session keeps its own ordinal sequence", async () => {
  await openAux("runtime:a", { tabId: 1, titlePrefix: "aux", spawn: async () => {} })
  const other = await openAux("runtime:b", { tabId: 2, titlePrefix: "aux", spawn: async () => {} })
  expect(other?.ordinal).toBe(1)
  expect(other?.parentRuntimeId).toBe("runtime:b")
})

test("creating instances count against the limit of five", async () => {
  const gates = Array.from({ length: AUX_MAX_TABS }, () => pending<void>())
  expect(auxCanOpen()).toBe(true)
  // 五个父会话各自开一个：spawn 都还悬着（status === "creating"），但名额已被占用。
  for (let index = 0; index < AUX_MAX_TABS; index++) {
    const opening = openAux(`runtime:p${index}`, {
      tabId: index + 1,
      titlePrefix: "aux",
      spawn: () => gates[index]!.promise,
    })
    expect(auxLiveCount()).toBe(index + 1)
    expect(opening).toBeInstanceOf(Promise)
  }
  expect(auxTabs().every(tab => tab.status === "creating")).toBe(true)
  // 第 6 个必须被拒绝（返回 null），而不是先入表再补删。
  expect(await openAux("runtime:p6", { tabId: 99, titlePrefix: "aux", spawn: async () => {} })).toBeNull()
  expect(auxLiveCount()).toBe(AUX_MAX_TABS)
  expect(auxCanOpen()).toBe(false)
  for (const gate of gates) gate.resolve()
  await Promise.all(auxTabs().map(tab => Promise.resolve(tab)))
})

test("the same parent gesture is deduplicated into one creation", async () => {
  const gate = pending<void>()
  const first = openAux("runtime:parent", { tabId: 1, titlePrefix: "aux", spawn: () => gate.promise })
  expect(auxCreationPending("runtime:parent")).toBe(true)
  const second = openAux("runtime:parent", { tabId: 2, titlePrefix: "aux", spawn: async () => {} })
  // 同一次创建：只入表一个实例，第二个手势拿到同一个 promise（不新建进程）。
  expect(auxLiveCount()).toBe(1)
  gate.resolve()
  expect(await second).toBe(await first)
  expect(auxCreationPending("runtime:parent")).toBe(false)
  // 整个手势只建了一个实例，槽位 2 从未对应任何实例。
  expect(auxTabBySidebarId(2)).toBeUndefined()
})

test("a spawn failure keeps the instance with its coded error and does not kill it", async () => {
  const coded = encodeCodedError("auxPiUnsupported", "当前 pi 版本不支持辅助对话所需的隔离参数")
  const tab = await openAux("runtime:parent", {
    tabId: 7,
    titlePrefix: "aux",
    spawn: async () => {
      throw new Error(coded)
    },
  })
  expect(tab?.status).toBe("error")
  // 面板要拿到**原始 coded error**（由 formatCodedError 按当前语言翻译），不能吞成布尔值。
  expect(tab?.error).toBe(coded)
  expect(isClosedAux(tab!.runtimeId)).toBe(false)
  // 失败不触发 rpc_kill（进程根本没起来）。
  expect(controls.kill).not.toHaveBeenCalled()
})

test("spawn failure of an unknown kind still records a readable reason", async () => {
  const tab = await openAux("runtime:parent", {
    tabId: 8,
    titlePrefix: "aux",
    spawn: async () => {
      throw new TypeError("boom")
    },
  })
  expect(tab?.status).toBe("error")
  expect(tab?.error).toContain("boom")
})

test("closing destroys stores in the documented order and tombstones the runtime", async () => {
  const parent = "runtime:parent"
  const tab = await openAux(parent, { tabId: 3, titlePrefix: "aux", spawn: async () => {} })
  const runtimeId = tab!.runtimeId
  const session = auxSessionFor(runtimeId)
  const ui = auxUiFor(runtimeId)
  session.entries.push({ kind: "user", id: 1, text: "hi", timestamp: 0 })
  ui.pushToast("toast", "info")
  ui.pendingEditorText = "typed"
  ui.handleRequest({ type: "extension_ui_request", id: "req-1", method: "confirm" } as never)
  saveAuxDraft(runtimeId, { text: "draft", files: [] })
  expect(auxDraftCount()).toBe(1)

  const atKill: Record<string, unknown> = {}
  controls.kill.mockImplementationOnce(async (id: string) => {
    // `rpc_kill` 必须在 store 拆除**之前**：那时进程已死但 store 仍在，
    // 否则迟到事件会找到仍存活的 store 并被当成活实例。
    atKill.runtimeId = id
    atKill.entries = session.entries.length
    atKill.dialogs = ui.dialogs.length
    atKill.toasts = ui.toasts.length
    atKill.pendingEditorText = ui.pendingEditorText
    atKill.draft = auxDraftCount()
    const pinia = getActivePinia() as unknown as { _s: Map<string, unknown> }
    // 拆 store 之前，两个 Pinia 实例都还在表里（顺序证据）。
    atKill.sessionStore = pinia._s.has(`session:${runtimeId}`)
    atKill.uiStore = pinia._s.has(`ui:${runtimeId}`)
  })

  await closeAux(runtimeId)

  expect(atKill.runtimeId).toBe(runtimeId)
  // 销毁顺序：墓碑 → session/ui/草稿清理 → rpc_kill → store 拆除。
  expect(atKill.entries).toBe(0)
  expect(atKill.dialogs).toBe(0)
  expect(atKill.toasts).toBe(0)
  expect(atKill.pendingEditorText).toBe(null)
  expect(atKill.draft).toBe(0)
  expect(atKill.sessionStore).toBe(true)
  expect(atKill.uiStore).toBe(true)
  expect(isClosedAux(runtimeId)).toBe(true)
  // 拆完之后 Pinia 实例表里不能再有这两个键。
  const pinia = getActivePinia() as unknown as { _s: Map<string, unknown> }
  expect(pinia._s.has(`session:${runtimeId}`)).toBe(false)
  expect(pinia._s.has(`ui:${runtimeId}`)).toBe(false)
  expect(session.entries).toHaveLength(0)
  expect(ui.dialogs).toHaveLength(0)
  expect(auxTabByRuntime(runtimeId)).toBeUndefined()
  expect(auxLiveCount()).toBe(0)
  // uiFor 的查找表也要摘掉：否则 `ExtensionDialog` 还能按旧 id 解析到已销毁的 store。
  expect(uiFor(runtimeId) === ui).toBe(false)
})

test("closeAux is idempotent and kills exactly once", async () => {
  const tab = await openAux("runtime:parent", { tabId: 4, titlePrefix: "aux", spawn: async () => {} })
  await closeAux(tab!.runtimeId)
  await closeAux(tab!.runtimeId)
  expect(controls.kill).toHaveBeenCalledTimes(1)
})

test("closing while the creation is still in flight kills the late process instead of reviving it", async () => {
  const gate = pending<void>()
  const opening = openAux("runtime:parent", { tabId: 5, titlePrefix: "aux", spawn: () => gate.promise })
  const tab = auxTabBySidebarId(5)!
  await closeAux(tab.runtimeId)
  gate.resolve()
  expect(await opening).toBeNull()
  // spawn 成功但实例已被关闭：进程要被收掉，且不得复活。
  expect(controls.kill).toHaveBeenCalledTimes(2)
  expect(auxTabByRuntime(tab.runtimeId)).toBeUndefined()
})

test("a tombstoned aux runtime is dropped instead of being rebuilt from a late event", async () => {
  const tab = await openAux("runtime:parent", { tabId: 6, titlePrefix: "aux", spawn: async () => {} })
  await closeAux(tab!.runtimeId)
  // 迟到 exit/事件按墓碑丢弃：查表得 undefined，调用方据此直接 return（不 sessionFor）。
  expect(auxTabByRuntime(tab!.runtimeId)).toBeUndefined()
  expect(isClosedAux(tab!.runtimeId)).toBe(true)
})

test("aux ui store is resolvable by session id without entering the conversation list", async () => {
  const tab = await openAux("runtime:parent", { tabId: 12, titlePrefix: "aux", spawn: async () => {} })
  const auxUi = auxUiFor(tab!.runtimeId)
  // `ExtensionDialog` / `StatusBar` 用 `uiFor(props.sessionId)` 解析：必须命中 aux 自己的 store。
  expect(uiFor(tab!.runtimeId)).toBe(auxUi)
  // 但 aux 不进会话表（allConversations 不见它），主会话 ui 也不受影响。
  const { allConversations, hasConversation } = await import("@/stores/conversations")
  expect(hasConversation(tab!.runtimeId)).toBe(false)
  expect(allConversations().length).toBe(0)
  auxUi.handleRequest({ type: "extension_ui_request", id: "q", method: "select", options: ["a"] } as never)
  expect(auxUi.dialogs).toHaveLength(1)
  expect(uiFor("main-ui").dialogs).toHaveLength(0)
})

test("aux ui store keeps an unanswered question visible for the sidebar badge", async () => {
  const tab = await openAux("runtime:parent", { tabId: 13, titlePrefix: "aux", spawn: async () => {} })
  auxUiFor(tab!.runtimeId).handleRequest({ type: "extension_ui_request", id: "q", method: "confirm" } as never)
  const { auxHasPendingQuestion, auxTitleForSidebarId } = await import("@/stores/auxChat")
  expect(auxHasPendingQuestion(13)).toBe(true)
  expect(auxTitleForSidebarId(13)).toBe("aux 1")
  auxUiFor(tab!.runtimeId).resolveRequest("q")
  expect(auxHasPendingQuestion(13)).toBe(false)
})

test("drafts are memory-only and cleared per runtime on close", async () => {
  const a = await openAux("runtime:a", { tabId: 20, titlePrefix: "aux", spawn: async () => {} })
  const b = await openAux("runtime:a", { tabId: 21, titlePrefix: "aux", spawn: async () => {} })
  saveAuxDraft(a!.runtimeId, { text: "first", files: [] })
  saveAuxDraft(b!.runtimeId, { text: "second", files: [] })
  expect(auxDraftCount()).toBe(2)
  clearAuxDraft(b!.runtimeId)
  expect(auxDraftCount()).toBe(1)
  await closeAux(a!.runtimeId)
  // 关闭即丢草稿：重开是全新实例（无历史、无草稿）。
  expect(auxDraftCount()).toBe(0)
  // 零 localStorage：只 stub 了 getItem/setItem，没有任何 setItem 调用。
  expect((localStorage.setItem as any).mock?.calls?.length ?? 0).toBe(0)
})
