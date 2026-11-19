import { readonly, ref, type Ref } from "vue"
import type { AppConfig } from "@/api/client/config"

interface ConfigPreferenceOptions<T> {
  /** Key under `preferences` in ~/.pix/config.json. */
  key: string
  /** Previous localStorage key, imported once when the config key is absent. */
  legacyKey?: string
  defaultValue: T | (() => T)
  validate?: (value: unknown) => value is T
  serialize?: (value: T) => string
  parse?: (raw: string) => unknown
  read?: (raw: string | null) => T
  onChange?: (value: T) => void
  /** Reject the setter and leave the in-memory value unchanged on write failure. */
  throwOnWriteError?: boolean
}

/**
 * 一笔还没有被主机确认的本地写入。
 * `revision` 是主机回执里的修订号（旧后端或未连接远程时为 null）。
 */
interface PendingWrite {
  raw: string
  revision: number | null
}

/** 主机视图：主机最后一次告诉我们的 preferences。**不是**显示值。 */
let preferences: Record<string, string> = {}
let initialized = false
let listening = false
let reconnectListening = false
/**
 * 本客户端尚未被确认的写入（key → FIFO）。
 *
 * 写入身份不靠「值相同」判定 —— 用户可能连续选回同一个值，值匹配无法区分「自己那笔的
 * 回执」和「用户后续又切了一次」。这里改用主机修订号（`app_preference_set` 返回新修订、
 * `pi://app-config-changed` 与 `app_config_get` 携带 `preferencesRevision`）：
 * - 快照修订号 >= 某笔本地写入的修订号 → 那笔写入已经被主机采纳，删掉它的记录；
 * - 仍有一笔未确认的新写入 → 显示值继续用那笔写入的 raw（主机视图照常更新）；
 * - 旧后端没有修订号 → 退化为「每个事件算作最老一笔本地写入的回执」（FIFO 假设），
 *   这是有界降级，真实后端始终带修订号。
 *
 * 这样迟到的旧回执既不会反转最新的选择，也不会让权威快照被旧记录长期屏蔽：
 * 主动读取（`initializeConfigPreferences`）与重连后的重新读取是无条件权威的。
 */
const pendingWrites = new Map<string, PendingWrite[]>()
/**
 * 写入失败但仍然保留在界面上的本地选择（key → raw）。
 * 主机明确表示「没写成」时不该闪回默认值，但这也不再是可以屏蔽权威状态的记录：
 * 任何一次主机快照（推送或主动读取）都会清空它。
 */
const failedOverrides = new Map<string, string>()
/** 已应用过的最新主机修订号；-1 表示还没收到过带修订号的快照。 */
let hostRevision = -1

const listeners = new Set<() => void>()
const migrationCallbacks = new Set<() => void>()
const migrations = new Set<string>()
let writeQueue: Promise<void> = Promise.resolve()

function hasConfigValue(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(preferences, key)
}

function legacyValue(key?: string): string | null {
  if (!key) return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function removeLegacyValue(key?: string) {
  if (!key) return
  try {
    localStorage.removeItem(key)
  } catch {
    /* Legacy cleanup is optional. */
  }
}

function notify() {
  for (const listener of listeners) listener()
}

function newestPending(key: string): PendingWrite | undefined {
  const list = pendingWrites.get(key)
  return list?.[list.length - 1]
}

function addPending(key: string, entry: PendingWrite) {
  pendingWrites.set(key, [...(pendingWrites.get(key) ?? []), entry])
}

/** 只删这一笔（按对象身份），同键的其它写入不受影响 —— 写失败不牵连后续写入。 */
function removePending(key: string, entry: PendingWrite) {
  const list = pendingWrites.get(key)
  if (!list) return
  const remaining = list.filter(candidate => candidate !== entry)
  if (remaining.length) pendingWrites.set(key, remaining)
  else pendingWrites.delete(key)
}

/** 显示用的 raw：仍在主机途中的本地写入优先，其次写失败保留的本地选择，最后主机视图。 */
function effectiveRaw(key: string): string | undefined {
  const pending = newestPending(key)
  if (pending) return pending.raw
  const failed = failedOverrides.get(key)
  if (failed !== undefined) return failed
  return hasConfigValue(key) ? preferences[key] : undefined
}

/**
 * 应用一份主机快照。
 *
 * `snapshot.authoritative` 用于「主动读取」（启动 / 重连 / 显式刷新）：整表直接采用并清空
 * 所有待确认记录 —— 权威读取永远不该被旧记录屏蔽。
 * 否则是推送事件：按修订号判定哪些本地写入已被采纳，其余键保持本地的更新值。
 */
function replacePreferences(
  next: Record<string, string> | undefined,
  snapshot: { revision?: number; authoritative?: boolean } = {},
) {
  const incoming = next ?? {}
  const revision = snapshot.revision

  if (snapshot.authoritative) {
    preferences = { ...incoming }
    pendingWrites.clear()
    failedOverrides.clear()
    if (revision !== undefined && revision > hostRevision) hostRevision = revision
    initialized = true
    notify()
    for (const migrate of migrationCallbacks) migrate()
    return
  }

  if (typeof revision === "number") {
    // 修订号严格单调：更旧的快照（乱序到达的旧事件）整份丢弃。
    if (revision < hostRevision) return
    hostRevision = revision
    // 修订号已覆盖的本地写入即回执：删掉记录，显示值回落到主机视图。
    for (const [key, list] of [...pendingWrites]) {
      const remaining = list.filter(entry => entry.revision === null || entry.revision > revision)
      if (remaining.length) pendingWrites.set(key, remaining)
      else pendingWrites.delete(key)
    }
  } else {
    // 旧后端没有修订号：快照里出现的键，其最老一笔本地写入按 FIFO 视为已确认。
    // 快照里没出现的键（只改了别的 key 的旧事件）不能吞掉本地记录，否则会闪回默认值。
    for (const [key, list] of [...pendingWrites]) {
      if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue
      if (list.length > 1) pendingWrites.set(key, list.slice(1))
      else pendingWrites.delete(key)
    }
  }

  // 推送快照同样代表主机当前状态：写失败留下的本地值到此为止。
  failedOverrides.clear()
  preferences = { ...incoming }
  initialized = true
  notify()
  for (const migrate of migrationCallbacks) migrate()
}

/** Serialize writes within this client; the backend merges each key into the latest config. */
function persistRawValue(key: string, raw: string, legacyKey?: string): Promise<number | undefined> {
  const write = writeQueue
    .catch(() => {})
    .then(async () => {
      const { saveConfigPreference } = await import("@/api/client/config")
      const revision = await saveConfigPreference(key, raw)
      removeLegacyValue(legacyKey)
      return typeof revision === "number" ? revision : undefined
    })
  writeQueue = write.then(
    () => undefined,
    () => undefined,
  )
  return write
}

/**
 * 乐观写入一笔偏好：先登记待确认，主机回执到了才解除。
 * `keepOnFailure`：宽松写入（不抛错）在失败后仍保留界面上的选择（沿用既有乐观 UI）；
 * 严格写入则回落到主机视图（调用方会看到拒绝异常）。
 */
async function commit(key: string, raw: string, legacyKey?: string, keepOnFailure = false) {
  // 新写入接管这个 key：之前写失败保留的旧选择不再显示。
  failedOverrides.delete(key)
  const entry: PendingWrite = { raw, revision: null }
  addPending(key, entry)
  notify()
  try {
    const revision = await persistRawValue(key, raw, legacyKey)
    entry.revision = revision ?? null
    // 主机有时先广播事件、后返回命令结果：回执已经途经本端时不能再留下幽灵记录，
    // 否则之后的权威读取会被它挡住（严格写入路径曾出现这个回归）。
    if (revision !== undefined && revision <= hostRevision) removePending(key, entry)
  } catch (error) {
    // 只清理这一笔：同键其它仍在途 / 后续写入的记录不受影响。
    removePending(key, entry)
    if (keepOnFailure) failedOverrides.set(key, raw)
    throw error
  } finally {
    notify()
  }
}

function migrateLegacyValue(options: ConfigPreferenceOptions<unknown>) {
  if (!initialized || !options.legacyKey || migrations.has(options.key)) return
  if (hasConfigValue(options.key)) {
    removeLegacyValue(options.legacyKey)
    return
  }
  const raw = legacyValue(options.legacyKey)
  if (raw === null) return
  migrations.add(options.key)
  void commit(options.key, raw, options.legacyKey)
    .catch(error => console.warn(`[pi] failed to migrate preference ${options.key}:`, error))
    .finally(() => migrations.delete(options.key))
}

function startConfigListener() {
  if (listening) return
  listening = true
  void import("@/api/client/config")
    .then(({ onAppConfigChanged }) =>
      onAppConfigChanged(config => replacePreferences(config.preferences, { revision: config.preferencesRevision })),
    )
    .catch(() => {
      listening = false
    })
  startReconnectListener()
}

/**
 * 远程传输断开期间事件会丢（见 `api/transport.ts` 的 RECONNECTED_EVENT 契约）。
 * 重连后主动读一次权威配置，避免本地残留的待确认记录继续屏蔽真实状态。
 */
function startReconnectListener() {
  if (reconnectListening) return
  reconnectListening = true
  void import("@/api/transport")
    .then(({ listen, RECONNECTED_EVENT }) => {
      if (!RECONNECTED_EVENT) {
        reconnectListening = false
        return undefined
      }
      return listen(RECONNECTED_EVENT, () => void refreshFromHost())
    })
    .catch(() => {
      reconnectListening = false
    })
}

/** 主动读取权威配置；永远整表采用，并清空待确认记录。 */
export async function refreshFromHost(): Promise<boolean> {
  try {
    const { getConfig } = await import("@/api/client/config")
    const loaded = await getConfig()
    replacePreferences(loaded.preferences, { authoritative: true, revision: loaded.preferencesRevision })
    return true
  } catch {
    return false
  }
}

/** Load host-owned preferences. Safe to retry after remote authentication. */
export async function initializeConfigPreferences(config?: AppConfig): Promise<boolean> {
  if (config) {
    replacePreferences(config.preferences, { authoritative: true, revision: config.preferencesRevision })
    startConfigListener()
    return true
  }
  const loaded = await refreshFromHost()
  if (loaded) startConfigListener()
  return loaded
}

/** A validated config.json ref with optimistic UI updates and legacy migration. */
export function createConfigPreference<T>(options: ConfigPreferenceOptions<T>) {
  const fallback = () =>
    typeof options.defaultValue === "function" ? (options.defaultValue as () => T)() : options.defaultValue

  function read(): T {
    const current = effectiveRaw(options.key)
    const raw = current !== undefined ? current : legacyValue(options.legacyKey)
    try {
      if (options.read) return options.read(raw)
      if (raw === null || raw === undefined) return fallback()
      const value = options.parse ? options.parse(raw) : raw
      return !options.validate || options.validate(value) ? (value as T) : fallback()
    } catch {
      return fallback()
    }
  }

  const state = ref(read()) as Ref<T>
  function sync() {
    state.value = read()
    options.onChange?.(state.value)
  }
  const migrate = () => migrateLegacyValue(options as ConfigPreferenceOptions<unknown>)
  listeners.add(sync)
  migrationCallbacks.add(migrate)
  sync()
  if (initialized) migrate()

  async function set(value: T) {
    const raw = options.serialize ? options.serialize(value) : String(value)
    if (options.throwOnWriteError) {
      await commit(options.key, raw, options.legacyKey, false)
      return
    }
    try {
      await commit(options.key, raw, options.legacyKey, true)
    } catch (error) {
      console.warn(`[pi] failed to save preference ${options.key}:`, error)
    }
  }

  return { value: readonly(state), set, read }
}
