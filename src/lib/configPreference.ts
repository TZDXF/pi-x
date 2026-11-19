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
 * 一笔本地写入。
 * `revision` 是主机回执里的修订号：命令返回前为 null（在途），旧后端始终为 null。
 */
interface PendingWrite {
  raw: string
  revision: number | null
}

/**
 * 主机视图：我们已知的主机 preferences，对应修订号 `hostRevision`。**不是**显示值。
 *
 * 主机侧每写一次偏好就把 `preferencesRevision` 加一并返回；推送事件与 `app_config_get`
 * 都携带该修订号（包括真实 `0` —— 新后端始终输出该字段，只有不认识它的旧后端才缺省）。
 */
let preferences: Record<string, string> = {}
/** 已应用过的最新主机修订号；-1 表示还没收到过带修订号的快照（旧后端 / 尚未初始化）。 */
let hostRevision = -1
let initialized = false
let listening = false
let reconnectListening = false

/**
 * 尚未被主机确认的写入（key → 按时间排列）。
 *
 * 写入身份不靠「值相同」判定 —— 用户可能连续选回同一个值（0→1→0 时首笔 `0` 与末值同值），
 * 值匹配无法区分「自己那笔的回执」和「之后又切了一次」：
 * - 回执修订号 >= 该笔的修订号 → 这笔已被主机采纳，删记录；
 * - 修订号更旧的事件 / 更旧的读取 → 整份丢弃（已知状态更新，绝不能被它覆盖）；
 * - 仍有未被覆盖的写入 → 显示值用本地值（主机视图照常更新，外部改动不会被藏）。
 */
const pendingWrites = new Map<string, PendingWrite[]>()
/**
 * 宽松写入失败后仍保留在界面上的本地选择（key → raw）。
 * 主机明确说「没写成」时不该闪回默认值，但它不是可屏蔽权威状态的记录：
 * 任何一次被采纳的主机快照都会清空它。
 */
const failedOverrides = new Map<string, string>()

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

/** 删掉所有已被 `revision` 覆盖（含回执）的记录；修订号未知的在途写入保留。 */
function clearPendingCovered(revision: number) {
  for (const [key, list] of [...pendingWrites]) {
    const remaining = list.filter(entry => entry.revision === null || entry.revision > revision)
    if (remaining.length) pendingWrites.set(key, remaining)
    else pendingWrites.delete(key)
  }
}

/** 显示用的 raw：未被覆盖的本地写入优先，其次写失败保留的本地选择，最后主机视图。 */
function effectiveRaw(key: string): string | undefined {
  const pending = newestPending(key)
  if (pending) return pending.raw
  const failed = failedOverrides.get(key)
  if (failed !== undefined) return failed
  return hasConfigValue(key) ? preferences[key] : undefined
}

/**
 * 一份快照的有效修订号。
 *
 * 新后端在线上快照里始终带 `preferencesRevision`（真实 `0` 也算），旧后端完全不认识该字段。
 * 因此：一旦本端见过修订号，后续「没有修订号」的快照只能来自旧格式，按等效 `0` 处理 ——
 * 这样它就不会被当成新事件覆盖已知道更高修订的状态（旧配置升级后的迟到全量保存事件）。
 */
function snapshotRevision(revision: number | undefined): number | undefined {
  if (typeof revision === "number") return revision
  return hostRevision >= 0 ? 0 : undefined
}

/**
 * 应用一份主机快照。
 *
 * - `authoritative`（主动读取：启动 / 重连 / 显式刷新）能纠正丢失的事件，但**不得**
 *   覆盖已知更高修订的状态（读取抓取时刻早于已应用的推送时整份丢弃），也不得吞掉
 *   这份读取还没覆盖到的本地写入（在途写入、或修订号高于该读取的写入）。
 * - 推送事件按修订号单调过滤；更旧的整份丢弃。
 * - 旧后端（从未见过修订号）退化为有界 FIFO 降级。
 */
function replacePreferences(
  next: Record<string, string> | undefined,
  snapshot: { revision?: number; authoritative?: boolean } = {},
) {
  const incoming = next ?? {}
  const revision = snapshotRevision(snapshot.revision)

  if (snapshot.authoritative && typeof revision === "number") {
    // 抓取时刻早于已知状态：这份读取是过时的，什么都不改（否则会把 UI 扳回旧值）。
    if (revision < hostRevision) return
    hostRevision = revision
    clearPendingCovered(revision)
    failedOverrides.clear()
    preferences = { ...incoming }
    initialized = true
    notify()
    for (const migrate of migrationCallbacks) migrate()
    return
  }

  if (snapshot.authoritative) {
    // 旧后端（或首次加载时还没有修订号）：整表采用；出现在快照里的键按 FIFO 确认一笔，
    // 快照里没有的键仍保留在途写入（不能让一次读取吞掉尚未发布的新写入）。
    confirmLegacyPending(incoming)
    failedOverrides.clear()
    preferences = { ...incoming }
    initialized = true
    notify()
    for (const migrate of migrationCallbacks) migrate()
    return
  }

  if (typeof revision === "number") {
    if (revision < hostRevision) return
    hostRevision = revision
    clearPendingCovered(revision)
  } else {
    // 旧后端没有修订号：快照里出现的键，其最老一笔本地写入按 FIFO 视为已确认。
    // 快照里没出现的键（只改了别的 key 的旧事件）不能吞掉本地记录，否则会闪回默认值。
    confirmLegacyPending(incoming)
  }

  failedOverrides.clear()
  preferences = { ...incoming }
  initialized = true
  notify()
  for (const migrate of migrationCallbacks) migrate()
}

/** 旧后端（无修订号）路径：快照里出现的键各按 FIFO 确认一笔写入。 */
function confirmLegacyPending(incoming: Record<string, string>) {
  for (const [key, list] of [...pendingWrites]) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue
    if (list.length > 1) pendingWrites.set(key, list.slice(1))
    else pendingWrites.delete(key)
  }
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
 * 主机已接受了这笔写入（命令成功返回）：把它并入主机视图，并清掉已被它覆盖的记录。
 *
 * 只有当我们这笔就是已知最新修订时才能改写主机视图 —— 否则更新的状态（别的客户端的
 * 后续写入 / 更晚的推送）优先，不能倒回去。
 */
function acceptWrite(key: string, raw: string, revision: number | undefined) {
  if (revision === undefined) {
    // 旧后端不返回修订号：命令成功即主机已接受，直接并入主机视图。
    preferences = { ...preferences, [key]: raw }
    notify()
    return
  }
  if (revision >= hostRevision) {
    hostRevision = revision
    preferences = { ...preferences, [key]: raw }
    clearPendingCovered(revision)
  }
  notify()
}

/**
 * 写入一笔偏好。
 *
 * - 宽松模式（默认）：先乐观显示（登记待确认），失败后按既有语义保留显示；
 * - 严格模式（`throwOnWriteError`）：**提交成功之前不改生效值** —— 打开文件、设置页等
 *   直接读该偏好的路径不会看到还没被主机接受的值。
 */
async function commit(key: string, raw: string, legacyKey: string | undefined, mode: { optimistic: boolean }) {
  // 新写入接管这个 key：之前写失败保留的旧选择不再显示。
  failedOverrides.delete(key)
  const entry: PendingWrite | null = mode.optimistic ? { raw, revision: null } : null
  if (entry) {
    addPending(key, entry)
    notify()
  }
  try {
    const revision = await persistRawValue(key, raw, legacyKey)
    if (entry) {
      entry.revision = revision ?? null
      // 主机有时先广播事件、后返回命令结果：回执已经途经本端时不能再留下幽灵记录，
      // 否则之后的权威读取会被它挡住（严格写入路径曾出现这个回归）。
      if (revision !== undefined && revision <= hostRevision) removePending(key, entry)
    }
    acceptWrite(key, raw, revision)
  } catch (error) {
    // 只清理这一笔：同键其它仍在途 / 后续写入的记录不受影响。
    if (entry) {
      removePending(key, entry)
      // 只有这笔是该键最新的本地意图时才保留显示：更老的失败不能盖住之后的选择
      //（连点时代码排队执行，旧写入较晚才失败）。
      if (mode.optimistic && !newestPending(key)) failedOverrides.set(key, raw)
    }
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
  void commit(options.key, raw, options.legacyKey, { optimistic: true })
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
 * 重连后主动读一次主机配置以纠正丢失的事件；这份读取仍受修订号约束（见 replacePreferences）。
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

/** 主动读取主机配置：能纠正丢事件，但不覆盖更新状态、不吞掉未被覆盖的本地写入。 */
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
      await commit(options.key, raw, options.legacyKey, { optimistic: false })
      return
    }
    try {
      await commit(options.key, raw, options.legacyKey, { optimistic: true })
    } catch (error) {
      console.warn(`[pi] failed to save preference ${options.key}:`, error)
    }
  }

  return { value: readonly(state), set, read }
}
