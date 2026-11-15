import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, getActivePinia, setActivePinia } from "pinia"

/**
 * 真实启动链上的关闭竞态（三条缺陷的回归）：
 *
 * ① `spawnAuxPi` 已成功返回、`session.init` 抛错的窗口里关闭 →
 *    `kill` 被调用且 aux 的 session store **不留**在表/Pinia 里；
 * ② 关闭之后迟到的 `spawnAuxPi` 返回 → 不重建 store、`kill` 被调用、`auxTabs()` 无该项；
 * ③ 重试（`retryAuxSpawn`）在 `spawnAuxRuntime` 迟到返回时遇到已关闭 → `kill` 被调用。
 *
 * 与 `aux-chat.test.ts` 的区别：那份用替身 spawn（只看注册表），这份跑**真实
 * `spawnAuxRuntime` / `retryAuxSpawn`**，只替身 transport 与 `spawnAuxPi`。
 * 任何一条在旧实现（`auxSessionFor` 缺席即创建、catch/retry 各自 return）上都会红。
 */
const controls = vi.hoisted(() => ({
  rpcRequest: vi.fn(async () => ({ success: true, data: {} })),
  spawnAuxPi: vi.fn(async () => {}),
}))
/** 每次 RPC 的 `type`（顺序）。"关闭后零续发"= 快照之后不再追加。 */
const rpcLog: string[] = []
/** 进程存活状态：kill 的判据是"进程不再存活"，而不是 kill 次数。 */
const proc = { alive: false }
/** kill 记账放本文件私有数组：`registerAuxRuntimeBridge` 是模块级状态，在
 *  `isolate: false` 下跨测试文件共享，用 mock 调用次数会受别的文件影响而 flaky。 */
const killed: string[] = []

vi.mock("@/api/piClient", () => ({
  adoptSession: async () => {},
  sessionHistory: async () => [],
  sessionLastError: async () => null,
  sessionMtime: async () => 0,
  generateSessionTitle: async () => ({ title: "" }),
  getPiSettings: async () => ({ retry: { enabled: true } }),
  getModelsConfig: async () => ({ providers: [] }),
  rpcNotify: async () => {},
  rpcRequest: (...args: unknown[]) => controls.rpcRequest(...(args as [])),
  spawnAuxPi: (...args: unknown[]) => controls.spawnAuxPi(...(args as [])),
  killPi: async (runtimeId: string) => {
    killed.push(runtimeId)
    proc.alive = false
  },
  sshConnectionList: async () => [],
  pixLog() {},
}))
vi.mock("@/api/transport", () => ({ invoke: async () => null }))
vi.mock("@/i18n", () => ({
  i18n: { global: { t: (key: string) => key } },
  tBackendError: (value: unknown) => String(value ?? ""),
}))
vi.mock("@/lib/fileRewind", () => ({ fileRewindState: async () => [] }))
vi.mock("@/lib/notifications", () => ({
  notifyTurnComplete() {},
  notifyQuestion: (title: string, target: unknown) => {
    questions.push({ title, target })
  },
}))
vi.mock("@/stores/sessionRunStatus", () => ({
  setSessionRunStatus() {},
  sessionRunStatus: () => undefined,
  sessionActivitySnapshot: () => undefined,
}))
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: () => ({
    histories: {},
    projectName: (path: string) => path,
    refresh: async () => {},
    preview() {},
  }),
}))
// 远程连接解析在本用例无关（父会话是本地路径，`terminalConnectionId` 恒返回 undefined）。
vi.mock("@/lib/sshTrust", () => ({ terminalConnectionId: async () => undefined }))

/** 每个用例重新取模块：`isolate: false` 下 `vi.mock` 注册表跨文件共享，
 *  固定 import 会绑到别的测试文件先装上的替身（表现为 `rpcRequest` 返回 undefined）。 */
async function load() {
  vi.resetModules()
  setActivePinia(createPinia())
  const store = await import("@/stores/auxChat")
  const spawnMod = await import("@/lib/auxSpawn")
  return { store, spawnMod }
}
let store: Awaited<ReturnType<typeof load>>["store"]
let spawnMod: Awaited<ReturnType<typeof load>>["spawnMod"]

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** 每次 `notifyQuestion` 的调用（提问静默的 aux/主会话对照）。 */
const questions: Array<{ title: string; target: unknown }> = []

/** 父会话上下文（本地项目 + 明确模型）。 */
const parent = () => ({
  runtimeId: "main",
  project: "C:/proj",
  model: { provider: "home", model: "big", thinking: "high" },
})

/** aux 自己的 store 表里是否还有该 runtime（`auxSessions` 侧的判据）。 */
function auxStoreLeftover(runtimeId: string) {
  return store.auxSessionExisting(runtimeId) !== undefined
}

/** Pinia 里与某 runtime 相关的实例键（幽灵 store 的判据）。 */
function piniaKeysFor(runtimeId: string) {
  const pinia = getActivePinia() as unknown as { _s: Map<string, unknown> }
  return [...pinia._s.keys()].filter(key => key.includes(runtimeId))
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  killed.length = 0
  controls.rpcRequest.mockClear()
  controls.spawnAuxPi.mockClear()
  rpcLog.length = 0
  proc.alive = false
  controls.rpcRequest.mockImplementation(async (command: { type?: string }) => {
    rpcLog.push(String(command?.type ?? "?"))
    return { success: true, data: {} }
  })
  controls.spawnAuxPi.mockImplementation(async () => {
    proc.alive = true
  })
  const loaded = await load()
  store = loaded.store
  spawnMod = loaded.spawnMod
  // 每次 beforeEach 重新登记（模块级 bridge 会被别的测试文件覆盖）。
  store.registerAuxRuntimeBridge({
    kill: async (runtimeId: string) => {
      killed.push(runtimeId)
      // kill 的判据：进程不再存活（次数不作数）。
      proc.alive = false
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test("① init 已进入后关闭：尾部思考等级/统计类 RPC 零续发，kill 后不再发请求", async () => {
  // spawnAuxPi 立即成功（进程已起），随后 init 的首批四段 RPC 挂在飞行中 → 关闭 →
  // 再放行首批响应。旧实现（公共 `session.init` 一把梭）会在关闭后继续发
  // `get_available_thinking_levels`；`initAuxSession` 必须在每段之间判活。
  const batch = deferred()
  controls.rpcRequest.mockImplementation(async (command: { type?: string }) => {
    rpcLog.push(String(command?.type ?? "?"))
    await batch.promise
    return { success: true, data: {} }
  })
  const opened = store.openAux("main", {
    tabId: 1,
    titlePrefix: "aux",
    spawn: async tab => {
      await spawnMod.spawnAuxRuntime(parent(), tab)
    },
  })
  const tab = store.auxTabBySidebarId(1)!
  // 等首批四段全部发出（get_state / get_commands / get_available_models / get_session_stats）。
  await vi.waitFor(() => expect(rpcLog.length).toBeGreaterThanOrEqual(4))
  expect(proc.alive).toBe(true)

  await store.closeAux(tab.runtimeId)
  const afterClose = rpcLog.length
  // 关闭后进程必须已被杀（判据是进程状态，不是次数）。
  expect(proc.alive).toBe(false)

  batch.resolve()
  await opened
  // 关闭之后**零**续发：尾部思考等级（以及任何二次统计/配置推送）一条都不许再发。
  expect(rpcLog.length).toBe(afterClose)
  expect(rpcLog.filter(type => type === "get_available_thinking_levels")).toHaveLength(0)
  // 也不能落在"留表带 error"那条路径上。
  expect(store.auxTabByRuntime(tab.runtimeId)).toBeUndefined()
  expect(piniaKeysFor(tab.runtimeId)).toEqual([])
  expect(auxStoreLeftover(tab.runtimeId)).toBe(false)
})

test("①c init 抛错且实例已被关闭：catch 分支同样走收尾（kill + 不留 store）", async () => {
  // spawnAuxPi 立即成功，首批 RPC 挂起 → 关闭 → 让首批 reject（init 抛错）。
  // 覆盖 `openAux` 的 catch 在"实例已关闭"时也要收尾，而不是只走"留表带 error"。
  const batch = deferred()
  controls.rpcRequest.mockImplementation(async (command: { type?: string }) => {
    rpcLog.push(String(command?.type ?? "?"))
    await batch.promise
    throw new Error("init failed")
  })
  const opened = store.openAux("main", {
    tabId: 2,
    titlePrefix: "aux",
    spawn: async tab => {
      await spawnMod.spawnAuxRuntime(parent(), tab)
    },
  })
  const tab = store.auxTabBySidebarId(2)!
  await vi.waitFor(() => expect(rpcLog.length).toBeGreaterThanOrEqual(4))
  await store.closeAux(tab.runtimeId)
  const afterClose = rpcLog.length
  batch.resolve()
  await opened

  expect(killed.length).toBeGreaterThanOrEqual(2)
  expect(proc.alive).toBe(false)
  expect(rpcLog.length).toBe(afterClose)
  expect(store.auxTabByRuntime(tab.runtimeId)).toBeUndefined()
  expect(piniaKeysFor(tab.runtimeId)).toEqual([])
  expect(auxStoreLeftover(tab.runtimeId)).toBe(false)
})

test("①d 正常路径对照：不关闭时尾部思考等级 RPC 确实会发（证明零续发不是从不发）", async () => {
  const tab = await store.openAux("main", {
    tabId: 9,
    titlePrefix: "aux",
    spawn: async created => {
      await spawnMod.spawnAuxRuntime(parent(), created)
    },
  })
  expect(tab?.status).toBe("ready")
  expect(rpcLog).toContain("get_available_thinking_levels")
  expect(rpcLog).toContain("get_session_stats")
})

test("①b init 抛错但实例仍活着：留在表里带 error，且不 kill（不能误杀活进程）", async () => {
  controls.rpcRequest.mockImplementation(async () => {
    throw new Error("init failed")
  })
  const tab = await store.openAux("main", {
    tabId: 3,
    titlePrefix: "aux",
    spawn: async created => {
      await spawnMod.spawnAuxRuntime(parent(), created)
    },
  })
  expect(tab?.status).toBe("error")
  expect(tab?.error).toContain("init failed")
  expect(store.auxTabByRuntime(tab!.runtimeId)).toBeTruthy()
  // 活实例失败不 kill（进程可能仍在、由用户决定关闭）。
  expect(killed).toHaveLength(0)
})

test("⑥ kill 不幂等：收尾之后迟到 spawn 真正落地，必须再被杀一次（进程不再存活）", async () => {
  // 序列：spawnAuxPi 挂起 → 关闭（第一次 kill）→ 旧引用再调一次 retry 触发第二次收尾
  // （旧实现到这里就把 `lateSettled` 的额度用完了）→ 原 spawnAuxPi 才真正落地（进程起来）
  // → 第三次收尾必须**再杀一次**。旧实现下这次被幂等挡掉：`killed` 不变、进程仍活。
  const gate = deferred()
  controls.spawnAuxPi.mockImplementation(() => gate.promise)
  const opened = store.openAux("main", {
    tabId: 7,
    titlePrefix: "aux",
    spawn: async tab => {
      await spawnMod.spawnAuxRuntime(parent(), tab)
    },
  })
  const tab = store.auxTabBySidebarId(7)!
  await store.closeAux(tab.runtimeId)
  // 旧引用再走一次入口守卫 ⇒ 第二次收尾（旧实现此时耗尽幂等额度）。
  await spawnMod.retryAuxSpawn(parent(), tab)

  // 现在让原 spawn 真正落地（进程起）。
  gate.resolve()
  proc.alive = true
  await opened

  // 判据是进程状态：迟到进程必须不再存活；kill 次数至少 2（close + 迟到收尾）。
  expect(proc.alive).toBe(false)
  expect(killed.length).toBeGreaterThanOrEqual(2)
})

test("⑦ 提问静默：aux 的未答询问不弹系统通知，主会话同场景照常弹（对照）", async () => {
  questions.length = 0
  // aux 的 ui store 是 silent 的：`extension_ui_request` 入队但不通知。
  const auxUi = store.auxUiFor("aux:quiet")
  auxUi.handleRequest({ type: "extension_ui_request", id: "q1", method: "confirm", message: "aux ask" } as never)
  expect(auxUi.dialogs).toHaveLength(1)
  expect(questions).toHaveLength(0)

  // 主会话同一场景（不 silent）：必须通知，否则上面的"零调用"就失去意义。
  const { uiFor } = await import("@/stores/conversations")
  const mainUi = uiFor("main:loud")
  mainUi.handleRequest({ type: "extension_ui_request", id: "q2", method: "confirm", message: "main ask" } as never)
  expect(mainUi.dialogs).toHaveLength(1)
  expect(questions.length).toBe(1)
  expect(questions[0]!.title).toContain("main ask")
})

test("② 关闭后迟到返回的 spawnAuxPi：不重建 store、kill 被调用、auxTabs() 无该项", async () => {
  const gate = deferred()
  controls.spawnAuxPi.mockImplementation(() => gate.promise)
  const opened = store.openAux("main", {
    tabId: 4,
    titlePrefix: "aux",
    spawn: async tab => {
      await spawnMod.spawnAuxRuntime(parent(), tab)
    },
  })
  const tab = store.auxTabBySidebarId(4)!
  await store.closeAux(tab.runtimeId)
  // 关闭之后进程才真正起来（迟到的 spawnAuxPi 返回）。
  gate.resolve()
  await opened

  expect(killed.length).toBeGreaterThanOrEqual(2)
  // 判据是"进程不再存活"，不是 kill 次数（迟到 spawn 可能才刚落地）。
  expect(proc.alive).toBe(false)
  expect(store.auxTabs()).toHaveLength(0)
  expect(store.auxTabByRuntime(tab.runtimeId)).toBeUndefined()
  // 迟到路径必须"只查不建"：旧实现会重建 session store 并在 Pinia 里留下实例。
  expect(piniaKeysFor(tab.runtimeId)).toEqual([])
  expect(auxStoreLeftover(tab.runtimeId)).toBe(false)
  // 也不能对已 kill 的 runtime 继续握手。
  expect(controls.rpcRequest).not.toHaveBeenCalled()
})

test("③ 重试在 spawnAuxRuntime 迟到返回时遇到已关闭：kill 被调用且不留 store", async () => {
  // 先造一个失败实例（spawnAuxPi 抛错）。
  controls.spawnAuxPi.mockImplementationOnce(async () => {
    throw new Error("spawn failed")
  })
  const tab = await store.openAux("main", {
    tabId: 4,
    titlePrefix: "aux",
    spawn: async created => {
      await spawnMod.spawnAuxRuntime(parent(), created)
    },
  })
  expect(tab?.status).toBe("error")
  expect(killed).toHaveLength(0)

  // 重试：spawnAuxPi 挂起，重试途中关闭实例，然后放行。
  const gate = deferred()
  killed.length = 0
  controls.spawnAuxPi.mockImplementation(() => gate.promise)
  const retrying = spawnMod.retryAuxSpawn(parent(), tab!)
  await Promise.resolve()
  await store.closeAux(tab!.runtimeId)
  gate.resolve()
  await retrying

  expect(killed.length).toBeGreaterThanOrEqual(2)
  expect(store.auxTabByRuntime(tab!.runtimeId)).toBeUndefined()
  expect(piniaKeysFor(tab!.runtimeId)).toEqual([])
  expect(auxStoreLeftover(tab!.runtimeId)).toBe(false)
})

test("⑤ 入口守卫：对已关闭实例调 spawn/retry 时不新增进程，也不写状态", async () => {
  // 先造一个正常实例并关闭它。
  const tab = await store.openAux("main", {
    tabId: 6,
    titlePrefix: "aux",
    spawn: async created => {
      await spawnMod.spawnAuxRuntime(parent(), created)
    },
  })
  expect(tab?.status).toBe("ready")
  await store.closeAux(tab!.runtimeId)
  killed.length = 0
  controls.spawnAuxPi.mockClear()
  controls.rpcRequest.mockClear()

  // 关闭之后任何一处仍然拿着旧 tab 引用去 spawn / retry：都必须在**起进程之前**被挡下。
  await spawnMod.spawnAuxRuntime(parent(), tab!)
  await spawnMod.retryAuxSpawn(parent(), tab!)
  expect(controls.spawnAuxPi).not.toHaveBeenCalled()
  expect(controls.rpcRequest).not.toHaveBeenCalled()
  // kill **不**幂等：每次命中都杀一次（迟到的 spawn 可能在下一次命中时才真正落地，
  // 幂等的只能是"拆 store"那一半）。这里两次调用 ⇒ 两次 kill，且都没有起进程。
  expect(killed).toHaveLength(2)
  expect(killed.every(id => id === tab!.runtimeId)).toBe(true)
})

test("④ 正常路径不受影响：spawn → init 成功即为 ready，且无 kill、无幽灵 store", async () => {
  const tab = await store.openAux("main", {
    tabId: 5,
    titlePrefix: "aux",
    spawn: async created => {
      await spawnMod.spawnAuxRuntime(parent(), created)
    },
  })
  expect(tab?.status).toBe("ready")
  expect(piniaKeysFor(tab!.runtimeId)).toContain(`session:${tab!.runtimeId}`)
  expect(killed).toHaveLength(0)
  expect(controls.rpcRequest).toHaveBeenCalled()
})
