/**
 * aux 的**租约**（`docs/aux-chat-spec.md` §5）：心跳周期、租约条目的宽容解析与
 * "重连只恢复自己的条目"的过滤规则。
 *
 * 保持零依赖（纯函数）：`stores/auxChat.ts` 在模块级跑心跳，`lib/workspaceRuntime.ts`
 * 的重连恢复也要用同一套过滤规则，两侧都不该为此拖进 transport 或 store 依赖。
 */

/** 心跳周期（规格 §5：20s）。回收器的判定要求 `claims` 为空，心跳就是"我还在看着它"。 */
export const AUX_LEASE_HEARTBEAT_MS = 20_000

/**
 * 租约 TTL（与后端 `aux_leases::AUX_LEASE_TTL` 对齐，90s = 4.5 个心跳）。
 *
 * 前端只用它做一件事：丢了 token（页面重载）时，`aux_claim` 会返回
 * `auxLeaseConflict` —— 此时**不重试、不停用 Tab**，而是在这个窗口过去后自动再试
 * （旧条目届时已被后端惰性摘掉，这次算首次领取、签发新 token）。
 */
export const AUX_LEASE_TTL_MS = 90_000

/** 该错误是否表示"这个 clientId 已被占用，续租必须出示原 token"（`auxLeaseConflict`）。 */
export function isAuxLeaseConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "")
  return text.includes("auxLeaseConflict")
}

/**
 * 该错误是否表示"这个实例正在被回收，不再接受新租约"（`auxLeaseReaping`）。
 *
 * 回收墓碑是**永久**的（runtimeId 一实例一个 UUID、永不复用），所以这条错误意味着
 * 实例已经（或正在）被回收 —— 前端同样要进退避窗口：继续每 20s 打一次只会刷无效
 * 请求（复审第三轮观察到 10 次 tick 发 10 次 claim）。
 */
export function isAuxLeaseReaping(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "")
  return text.includes("auxLeaseReaping")
}

/** 一条租约（后端 `aux_list` 的条目）。`parentRuntimeId` 可能为 `null`（未知归属）。 */
export interface AuxLeaseEntry {
  runtimeId: string
  parentRuntimeId: string | null
  clientId: string
}

/**
 * 宽容解析 `aux_list` 的返回。
 *
 * 为什么要宽容：远程 `dispatch` 与桌面走同一条 JSON 通道，字段名是 camelCase；
 * 旧版后端（或某次回归）少一个 `parentRuntimeId` 时，**不该**把整张表当成空——
 * 只丢那一条本身（它照样无法通过归属过滤），其余正常恢复。
 */
export function parseAuxLeaseEntries(raw: unknown): AuxLeaseEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: AuxLeaseEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const value = item as Record<string, unknown>
    const runtimeId = typeof value.runtimeId === "string" ? value.runtimeId : ""
    const clientId = typeof value.clientId === "string" ? value.clientId : ""
    if (!runtimeId || !clientId) continue
    const parent = typeof value.parentRuntimeId === "string" ? value.parentRuntimeId : null
    entries.push({ runtimeId, parentRuntimeId: parent || null, clientId })
  }
  return entries
}

/**
 * 重连归属过滤（规格 §5 第 4 条）：只保留
 * **`clientId == 本机` 且 `parentRuntimeId` 在本地注册表** 的条目。
 *
 * 其余一律**不动**（不 kill、不改状态）：它们可能是别的窗口/别的机器在用的实例，
 * 由回收器按三条件兜底。这就是"重连不把全部 aux 当孤儿"的落点。
 */
export function ownAuxLeases(
  entries: readonly AuxLeaseEntry[],
  clientId: string,
  isKnownParent: (parentRuntimeId: string) => boolean,
): AuxLeaseEntry[] {
  return entries.filter(
    entry => entry.clientId === clientId && entry.parentRuntimeId !== null && isKnownParent(entry.parentRuntimeId),
  )
}

/** 是否有值得跳心跳的条目（规格 §5：只在存在 aux 条目时跑心跳）。 */
export function shouldHeartbeat(runtimeIds: readonly string[]): boolean {
  return runtimeIds.some(id => id.startsWith("aux:"))
}
