import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/**
 * aux 的**租约与心跳**（TZD-104，规格 §5）：
 *
 * 1. 心跳是**模块级**的：`auxChat` 里存在 `aux:` 条目时每 20s 续租一次，
 *    没有条目时自动停表；切父会话（Pane 卸载）不中断。
 * 2. 关闭顺序：**先 `aux_release` 再 `rpc_kill`**（与 §5 销毁段一致）。
 * 3. 重连归属：`aux_list` 里只恢复 `clientId == 本机 && parentRuntimeId 在本地注册表`
 *    的条目；他客户端条目一律不动，本机残条（实例已不在表）释放租约。
 * 4. 纯逻辑：宽容解析与过滤（`lib/auxLease.ts`）。
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
  auxClaim: async () => {},
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

/** 校验顺序的记账（先 release 再 kill）。 */
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
    },
    release: async (runtimeId: string, clientId: string) => {
      calls.push(`release:${runtimeId}:${clientId}`)
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

test("closing an instance releases the lease before killing the process", async () => {
  const tab = await openTab("main", 2)
  calls.length = 0
  await aux.closeAux(tab.runtimeId)
  const releaseIndex = calls.findIndex(call => call.startsWith("release:"))
  const killIndex = calls.findIndex(call => call.startsWith("kill:"))
  expect(releaseIndex, `release 必须先于 kill：${calls.join(", ")}`).toBeGreaterThanOrEqual(0)
  expect(killIndex).toBeGreaterThan(releaseIndex)
  expect(calls[releaseIndex]).toBe(`release:${tab.runtimeId}:${aux.currentAuxClientId()}`)
})

test("late settlement also releases the lease, not only the process", async () => {
  const tab = await openTab("main", 3)
  await aux.closeAux(tab.runtimeId)
  calls.length = 0
  // 迟到路径（spawn 返回/init 抛错/面板重试）走的是同一个 `settleLateAux`。
  const settled = await aux.settleLateAux(tab.runtimeId)
  expect(settled).toBe(true)
  expect(calls.filter(call => call.startsWith("release:"))).toHaveLength(1)
  expect(calls.filter(call => call.startsWith("kill:"))).toHaveLength(1)
  expect(calls[0].startsWith("release:")).toBe(true)
})

test("reconnect restores only this client's leases and releases its stale ones", async () => {
  const live = await openTab("main", 4)
  aux.registerAuxRuntimeBridge({
    kill: async () => {},
    claim: async (runtimeId: string) => {
      calls.push(`claim:${runtimeId}`)
    },
    release: async (runtimeId: string) => {
      calls.push(`release:${runtimeId}`)
    },
    list: async () => [
      // 本机、父会话在本地注册表、实例也活着：续租（不释放）。
      { runtimeId: live.runtimeId, parentRuntimeId: "main", clientId: aux.currentAuxClientId() },
      // 本机但实例已不在表（已关闭/本页从未拥有）：释放残租约。
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
  expect(calls).toContain(`release:aux:stale`)
  expect(calls).not.toContain("release:aux:other")
  expect(calls).not.toContain("release:aux:foreign")
  expect(calls).toContain(`claim:${live.runtimeId}`)
})

test("reconnect without any aux instance stays quiet and keeps the heartbeat stopped", async () => {
  calls.length = 0
  const own = await aux.reconcileAuxLeases()
  expect(own).toEqual([])
  expect(calls).toEqual([])
  expect(aux.auxHeartbeatRunning()).toBe(false)
})
