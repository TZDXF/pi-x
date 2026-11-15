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
vi.mock("@/lib/notifications", () => ({ notifyTurnComplete() {}, notifyQuestion() {} }))
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

/** 父会话上下文（本地项目 + 明确模型）。 */
const parent = () => ({
  runtimeId: "main",
  project: "C:/proj",
  model: { provider: "home", model: "big", thinking: "high" },
})

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
  controls.rpcRequest.mockImplementation(async () => ({ success: true, data: {} }))
  controls.spawnAuxPi.mockImplementation(async () => {})
  const loaded = await load()
  store = loaded.store
  spawnMod = loaded.spawnMod
  // 每次 beforeEach 重新登记（模块级 bridge 会被别的测试文件覆盖）。
  store.registerAuxRuntimeBridge({
    kill: async (runtimeId: string) => {
      killed.push(runtimeId)
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test("① 关闭落在 spawnAuxPi 已返回、session.init 抛错的窗口：迟到错误也要补 kill 且不留 session store", async () => {
  // spawnAuxPi 挂起 → 关闭 → 放行（进程此时才起来）→ init 抛错。
  // 这一条覆盖"关闭 + 迟到 + init 抛错"的组合窗口：旧实现在 catch 里只 return，漏掉第二次 kill。
  const gate = deferred()
  controls.spawnAuxPi.mockImplementation(() => gate.promise)
  controls.rpcRequest.mockImplementation(async () => {
    throw new Error("init failed")
  })
  const opened = store.openAux("main", {
    tabId: 1,
    titlePrefix: "aux",
    spawn: async tab => {
      await spawnMod.spawnAuxRuntime(parent(), tab)
    },
  })
  const tab = store.auxTabBySidebarId(1)!
  await store.closeAux(tab.runtimeId)
  gate.resolve()
  await opened

  // close 的 kill + 迟到收尾的 kill：漏掉任一次都说明有窗口没杀。
  expect(killed.length).toBeGreaterThanOrEqual(2)
  expect(store.auxTabByRuntime(tab.runtimeId)).toBeUndefined()
  // 迟到的 init 错误不能把已释放的 store 留在 Pinia 里（旧实现会重建 → 这里红）。
  expect(piniaKeysFor(tab.runtimeId)).toEqual([])
})

test("①b init 抛错但实例仍活着：留在表里带 error，且不 kill（不能误杀活进程）", async () => {
  controls.rpcRequest.mockImplementation(async () => {
    throw new Error("init failed")
  })
  const tab = await store.openAux("main", {
    tabId: 2,
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

test("② 关闭后迟到返回的 spawnAuxPi：不重建 store、kill 被调用、auxTabs() 无该项", async () => {
  const gate = deferred()
  controls.spawnAuxPi.mockImplementation(() => gate.promise)
  const opened = store.openAux("main", {
    tabId: 3,
    titlePrefix: "aux",
    spawn: async tab => {
      await spawnMod.spawnAuxRuntime(parent(), tab)
    },
  })
  const tab = store.auxTabBySidebarId(3)!
  await store.closeAux(tab.runtimeId)
  // 关闭之后进程才真正起来（迟到的 spawnAuxPi 返回）。
  gate.resolve()
  await opened

  expect(killed.length).toBeGreaterThanOrEqual(2)
  expect(store.auxTabs()).toHaveLength(0)
  expect(store.auxTabByRuntime(tab.runtimeId)).toBeUndefined()
  // 迟到路径必须"只查不建"：旧实现会重建 session store 并在 Pinia 里留下实例。
  expect(piniaKeysFor(tab.runtimeId)).toEqual([])
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
  // 收尾幂等：第一次命中再补一次 kill（覆盖"关闭时进程才起来"的迟到窗口），
  // 之后的重复调用不再追加 kill（`lateSettled` 记账）。
  expect(killed).toHaveLength(1)
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
