import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/**
 * aux 的**租约与心跳**（TZD-104，规格 §5/§11）：
 *
 * 1. 心跳是**模块级**的：`auxChat` 里存在 `aux:` 条目时每 20s 续租一次，
 *    没有条目时自动停表；切父会话（Pane 卸载）不中断。
 * 2. 关闭顺序：**先 `aux_release` 再 `rpc_kill`**（与 §5 销毁段一致）。
 * 3. 重连归属：`aux_list` 里只恢复 `clientId == 本机 && parentRuntimeId 在本地注册表`
 *    的条目；他客户端条目一律不动，本机残条（实例已不在表）释放租约。
 * 4. **clientId 不是凭证**：`aux_release` 只认服务端在 `aux_claim` 时签发的 lease token。
 * 5. 纯逻辑：宽容解析与过滤（`lib/auxLease.ts`）。
 *
 * 不访问任何真实模型/进程：`@/api/piClient` 全部替身，`aux_*` 走注入的 bridge。
 */
const controls = vi.hoisted(() => ({
  rpcRequest: vi.fn(async () => ({ success: true, data: {} })),
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
  rpcRequest: (...args: unknown[]) => controls.rpcRequest(...(args as [])),
  // `aux_claim` 回服务端签发的 token；`aux_release` 只认 token。
  auxClaim: async (runtimeId: string) => `token-${runtimeId}`,
  auxRelease: async () => {},
  auxList: async () => [],
  killPi: async () => {},
  spawnAuxPi: async () => {},
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

type AuxChat = typeof import("@/stores/auxChat")
type AuxLease = typeof import("@/lib/auxLease")
let aux: AuxChat
let lease: AuxLease

/** 调用顺序记账（先 release 再 kill、token 是否被正确出示）。 */
const calls: string[] = []

beforeEach(async () => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  vi.resetModules()
  aux = await import("@/stores/auxChat")
  lease = await import("@/lib/auxLease")
  calls.length = 0
  controls.rpcRequest.mockReset()
  controls.rpcRequest.mockImplementation(async () => ({ success: true, data: {} }))
  aux.registerAuxRuntimeBridge({
    kill: async (runtimeId: string) => {
      calls.push(`kill:${runtimeId}`)
    },
    claim: async (runtimeId: string, clientId: string) => {
      calls.push(`claim:${runtimeId}:${clientId}`)
      return `token-${runtimeId}`
    },
    release: async (runtimeId: string, leaseToken: string) => {
      calls.push(`release:${runtimeId}:${leaseToken}`)
    },
    list: async () => [],
  })
})

afterEach(() => {
  aux.resetAuxChatForTest()
  vi.useRealTimers()
})

async function openTab(parent = "main", tabId = 1) {
  return (await aux.openAux(parent, { tabId, titlePrefix: "aux", spawn: async () => {} }))!
}

test("parseAuxLeaseEntries keeps well-formed rows and drops only broken ones", () => {
  const parsed = lease.parseAuxLeaseEntries([
    { runtimeId: "aux:a", parentRuntimeId: "main", clientId: "c1" },
    // 缺 parentRuntimeId：保留（parent 为 null，随后被归属过滤丢弃），不是整表失败。
    { runtimeId: "aux:b", clientId: "c1" },
    { runtimeId: "aux:c", parentRuntimeId: null, clientId: "c1" },
    // 缺关键字段：只丢这一条。
    { parentRuntimeId: "main", clientId: "c1" },
    { runtimeId: "aux:d", parentRuntimeId: "main" },
    "junk",
    null,
  ])
  expect(parsed.map(entry => entry.runtimeId)).toEqual(["aux:a", "aux:b", "aux:c"])
  expect(parsed[1].parentRuntimeId).toBe(null)
  // 非数组一律当空表（旧后端/异常返回不该让恢复流程抛错）。
  expect(lease.parseAuxLeaseEntries(undefined)).toEqual([])
  expect(lease.parseAuxLeaseEntries({ entries: [] })).toEqual([])
})

test("ownAuxLeases only keeps this machine's leases whose parent is still known", () => {
  const entries = [
    { runtimeId: "aux:mine", parentRuntimeId: "main", clientId: "me" },
    // 别的窗口/别的机器的实例：不动（等回收器）。
    { runtimeId: "aux:other", parentRuntimeId: "main", clientId: "someone-else" },
    // 本机但父会话已不在本地注册表：同样不动。
    { runtimeId: "aux:orphan", parentRuntimeId: "gone", clientId: "me" },
    // 父会话未知（后端没记到）：无法判定归属，丢弃。
    { runtimeId: "aux:unknown", parentRuntimeId: null, clientId: "me" },
  ]
  const own = lease.ownAuxLeases(entries, "me", parent => parent === "main")
  expect(own.map(entry => entry.runtimeId)).toEqual(["aux:mine"])
})

test("shouldHeartbeat only fires while an aux: instance exists", () => {
  expect(lease.shouldHeartbeat([])).toBe(false)
  expect(lease.shouldHeartbeat(["main"])).toBe(false)
  expect(lease.shouldHeartbeat(["main", "aux:x"])).toBe(true)
})

test("heartbeat claims every live instance every 20s and stops when the last one closes", async () => {
  const tab = await openTab("main", 1)
  // 创建即起心跳（模块级，不等 spawn 返回）。
  expect(aux.auxHeartbeatRunning()).toBe(true)
  calls.length = 0
  await vi.advanceTimersByTimeAsync(lease.AUX_LEASE_HEARTBEAT_MS)
  expect(calls).toEqual([`claim:${tab.runtimeId}:${aux.currentAuxClientId()}`])
  // 心跳周期是 20s，不是别处的 60s/30s。
  expect(lease.AUX_LEASE_HEARTBEAT_MS).toBe(20_000)

  await aux.closeAux(tab.runtimeId)
  expect(aux.auxHeartbeatRunning()).toBe(false)
  const afterClose = calls.length
  await vi.advanceTimersByTimeAsync(lease.AUX_LEASE_HEARTBEAT_MS * 3)
  expect(calls.length).toBe(afterClose)
})

test("closing an instance releases the lease with a token before killing the process", async () => {
  const tab = await openTab("main", 2)
  // 就绪时拿到的 token 必须被记住（release 只认它）。
  expect(aux.auxLeaseToken(tab.runtimeId)).toBe(`token-${tab.runtimeId}`)
  calls.length = 0
  await aux.closeAux(tab.runtimeId)
  const releaseIndex = calls.findIndex(call => call.startsWith("release:"))
  const killIndex = calls.findIndex(call => call.startsWith("kill:"))
  expect(releaseIndex, `release 必须先于 kill：${calls.join(", ")}`).toBeGreaterThanOrEqual(0)
  expect(killIndex).toBeGreaterThan(releaseIndex)
  // 出示的是 token，不是 clientId（后者是公开标识，不能当凭证）。
  expect(calls[releaseIndex]).toBe(`release:${tab.runtimeId}:token-${tab.runtimeId}`)
  expect(calls[releaseIndex]).not.toContain(aux.currentAuxClientId())
  // 释放后本机不再持有 token。
  expect(aux.auxLeaseToken(tab.runtimeId)).toBeUndefined()
})

test("without a token the close path does not release (the TTL expires it instead)", async () => {
  // 模拟"页面重载后旧租约还在 TTL 内、本机已拿不到那个 token"：宿主 claim 不回 token。
  aux.registerAuxRuntimeBridge({
    kill: async (runtimeId: string) => {
      calls.push(`kill:${runtimeId}`)
    },
    claim: async () => undefined as unknown as string,
    release: async (runtimeId: string, leaseToken: string) => {
      calls.push(`release:${runtimeId}:${leaseToken}`)
    },
  })
  const tab = await openTab("main", 9)
  expect(aux.auxLeaseToken(tab.runtimeId)).toBeUndefined()
  calls.length = 0
  await aux.closeAux(tab.runtimeId)
  // 没有 token 就不发 release（绝不拿 clientId 顶替 —— 那是 P1-2），但进程照样收尾。
  expect(calls.filter(call => call.startsWith("release:"))).toHaveLength(0)
  expect(calls.filter(call => call.startsWith("kill:"))).toHaveLength(1)
})

test("late settlement also releases the lease, not only the process", async () => {
  const tab = await openTab("main", 3)
  const token = aux.auxLeaseToken(tab.runtimeId)
  expect(token).toBe(`token-${tab.runtimeId}`)
  await aux.closeAux(tab.runtimeId)
  calls.length = 0
  // 迟到路径（spawn 返回/init 抛错/面板重试）走的是同一个 `settleLateAux`。
  const settled = await aux.settleLateAux(tab.runtimeId)
  expect(settled).toBe(true)
  // 已经 release 过（token 已消费）：迟到收尾不再重复出示。
  expect(calls.filter(call => call.startsWith("kill:"))).toHaveLength(1)
  expect(calls[0].startsWith("kill:")).toBe(true)
})

test("reconnect restores only this client's leases and releases its stale ones", async () => {
  const live = await openTab("main", 4)
  aux.registerAuxRuntimeBridge({
    kill: async () => {},
    claim: async (runtimeId: string) => {
      calls.push(`claim:${runtimeId}`)
      return `token-${runtimeId}`
    },
    release: async (runtimeId: string, leaseToken: string) => {
      calls.push(`release:${runtimeId}:${leaseToken}`)
    },
    list: async () => [
      // 本机、父会话在本地注册表、实例也活着：续租（不释放）。
      { runtimeId: live.runtimeId, parentRuntimeId: "main", clientId: aux.currentAuxClientId() },
      // 本机但实例已不在表（已关闭/本页从未拥有）：本机没有它的 token，交给 TTL。
      { runtimeId: "aux:stale", parentRuntimeId: "main", clientId: aux.currentAuxClientId() },
      // 他客户端：不动（既不 claim 也不 release）。
      { runtimeId: "aux:other", parentRuntimeId: "main", clientId: "someone-else" },
      // 父会话不在本地：不动。
      { runtimeId: "aux:foreign", parentRuntimeId: "gone", clientId: aux.currentAuxClientId() },
    ],
  })
  calls.length = 0
  const own = await aux.reconcileAuxLeases()
  expect(own.sort()).toEqual([live.runtimeId, "aux:stale"].sort())
  // 没有 token 的条目不会被"用 clientId 冒充"的方式释放（P1-2 的那条缺口）。
  expect(calls.filter(call => call.startsWith("release:"))).toEqual([])
  expect(calls).toContain(`claim:${live.runtimeId}`)
})

test("reconnect without any aux instance stays quiet and keeps the heartbeat stopped", async () => {
  calls.length = 0
  const own = await aux.reconcileAuxLeases()
  expect(own).toEqual([])
  expect(calls).toEqual([])
  expect(aux.auxHeartbeatRunning()).toBe(false)
})
