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
 * 共享偏好同步（`~/.pix/config.json` 的 preferences）。
 *
 * 主机每写一次偏好就把 `preferencesRevision` 加一，并把这个修订号随
 * `app_preference_set` 的返回值、`pi://app-config-changed` 推送与 `app_config_get`
 * 一起下发（新后端始终输出该字段，包括真实的 `0`）。
 *
 * 关键点是**按 key 记录「在哪一修订上得知这个值」**，而不是用一个全局修订号判断整表新旧：
 * - 单键写入成功的回执只证明**这一个 key** 在 rN 上已是我们的值，不能把「完整快照」的
 *   水位推到 rN —— 否则仍包含其它 key 新信息的 r(N-1) 全量事件会被整份丢弃；
 * - 全量快照按 key 合并：某个 key 我们已知的修订更新就跳过它，其余照常采用；
 * - 命令还没返回的写入（在途）拥有该 key 的显示权，任何快照都不覆盖；
 * - 旧后端（不支持修订号）保留按 key 的 FIFO 降级：推送按序确认最老一笔写入，
 *   主动读取则以整表为准（一次读取就能纠正丢失的回执）。
 */
interface KnownValue {
  raw: string
  /** 得知这个值的修订号；null 表示来自「不带修订号」的旧后端快照。 */
  revision: number | null
}

/** 我们已知的主机 preferences（按 key 带上得知时的修订号）。**不是**显示值。 */
const known = new Map<string, KnownValue>()
/** 命令尚未返回的本地写入（key → raw，按时间排列）：显示权归它们。 */
const inflight = new Map<string, string[]>()
/** 旧后端专用：命令已成功、但回执事件还没到的写入（key → raw，按时间排列）。 */
const unseen = new Map<string, string[]>()
/** 宽松写入失败后仍保留在界面上的本地选择；任何被采纳的主机快照都会清掉它。 */
const failedOverrides = new Map<string, string>()

/** 见过的最大修订号；-1 表示还没见过任何修订号（旧后端或尚未初始化）。 */
let seenRevision = -1
let initialized = false
let listening = false
let reconnectListening = false

const listeners = new Set<() => void>()
const migrationCallbacks = new Set<() => void>()
const migrations = new Set<string>()
let writeQueue: Promise<void> = Promise.resolve()

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

/**
 * 快照的有效修订号：
 * - 带数字 → 就是它；
 * - 不带，但本端已经见过修订号 → 这是旧格式快照（新后端始终输出该字段），按 R0 处理，
 *   于是它不会覆盖我们已知的更新状态；
 * - 不带且从未见过修订号 → 旧后端，走 FIFO 降级。
 */
function effectiveRevision(revision: number | undefined): number | null {
  if (typeof revision === "number") return revision
  return seenRevision >= 0 ? 0 : null
}

function lastOf(map: Map<string, string[]>, key: string): string | undefined {
  const list = map.get(key)
  return list?.[list.length - 1]
}

/** 显示用的 raw：在途写入 > 旧后端待回执写入 > 写失败保留值 > 主机视图。 */
function effectiveRaw(key: string): string | undefined {
  const pending = lastOf(inflight, key)
  if (pending !== undefined) return pending
  const unseenRaw = lastOf(unseen, key)
  if (unseenRaw !== undefined) return unseenRaw
  const failed = failedOverrides.get(key)
  if (failed !== undefined) return failed
  return known.get(key)?.raw
}

/** 采用快照里的一个 key：只有比我们已知的更新（或同级）才写。 */
function adopt(key: string, raw: string, revision: number) {
  const current = known.get(key)
  if (current?.revision != null && current.revision > revision) return
  known.set(key, { raw, revision })
}

function forget(key: string, revision: number) {
  const current = known.get(key)
  if (!current) return
  // 我们的信息比这份快照新时保留（快照里没有这个 key 只说明旧时刻的状态）。
  if (current.revision !== null && current.revision > revision) return
  known.delete(key)
}

function clearFailedOverrides() {
  for (const key of [...failedOverrides.keys()]) if (!inflight.has(key)) failedOverrides.delete(key)
}

/**
 * 应用一份主机快照（推送事件或主动读取）。
 *
 * 数字修订：按 key 合并 —— 单键回执只推进该 key，不会让其它 key 的新信息被丢弃。
 * 无修订号（旧后端）：`authoritative`（主动读取）以整表为准；否则按 key FIFO 确认。
 */
function replacePreferences(
  next: Record<string, string> | undefined,
  snapshot: { revision?: number; authoritative?: boolean } = {},
) {
  const incoming = next ?? {}
  const revision = effectiveRevision(snapshot.revision)
  const keys = Object.keys(incoming)

  if (revision !== null) {
    if (revision > seenRevision) seenRevision = revision
    for (const key of keys) {
      // 在途写入还没被主机接受，快照（可能产生于它之前）不能决定它的显示。
      if (inflight.has(key)) continue
      adopt(key, incoming[key]!, revision)
      // 数字快照已覆盖这笔写入的更早阶段，之后不再需要 FIFO 确认。
      unseen.delete(key)
    }
    for (const key of [...known.keys()]) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) continue
      if (inflight.has(key)) continue
      forget(key, revision)
    }
  } else if (snapshot.authoritative) {
    // 旧后端主动读取：整表即主机真值。命令已返回的旧写入不再逐笔确认 —— 否则要读多次，
    // 且键被外部删掉时也永远不会回落到默认值。
    for (const key of [...unseen.keys()]) if (!inflight.has(key)) unseen.delete(key)
    for (const key of keys) {
      if (inflight.has(key)) continue
      adopt(key, incoming[key]!, -1)
    }
    for (const key of [...known.keys()]) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) continue
      if (inflight.has(key)) continue
      known.delete(key)
    }
  } else {
    // 旧后端推送：快照里出现的键按 FIFO 确认最老一笔写入；还有未确认的写入时保留本地值。
    for (const key of keys) {
      if (inflight.has(key)) continue
      const pending = unseen.get(key)
      if (pending?.length) {
        if (pending.length > 1) unseen.set(key, pending.slice(1))
        else unseen.delete(key)
        if (unseen.has(key)) continue
      }
      adopt(key, incoming[key]!, -1)
    }
  }

  clearFailedOverrides()
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

/** 主机接受了这笔写入：只更新**这一个 key** 的已知修订（绝不动完整快照的水位）。 */
function acceptWrite(key: string, raw: string, revision: number | undefined) {
  if (revision === undefined) {
    // 旧后端不返回修订号：先记入「待回执」，由推送 / 主动读取来确认。
    unseen.set(key, [...(unseen.get(key) ?? []), raw])
    notify()
    return
  }
  if (revision > seenRevision) seenRevision = revision
  adopt(key, raw, revision)
  notify()
}

/**
 * 写入一笔偏好。
 *
 * - 宽松模式（默认）：先乐观显示（登记在途），失败后保留显示（`failedOverrides`）；
 * - 严格模式（`throwOnWriteError`）：**提交成功之前不改生效值** —— 打开文件、设置页等
 *   直接读该偏好的路径不会看到还没被主机接受的值。
 */
async function commit(key: string, raw: string, legacyKey: string | undefined, mode: { optimistic: boolean }) {
  // 新写入接管这个 key：之前写失败保留的旧选择不再显示。
  failedOverrides.delete(key)
  if (mode.optimistic) {
    inflight.set(key, [...(inflight.get(key) ?? []), raw])
    notify()
  }
  const removeInflight = (value: string) => {
    const list = inflight.get(key)
    if (!list) return
    const remaining = list.filter(candidate => candidate !== value)
    if (remaining.length) inflight.set(key, remaining)
    else inflight.delete(key)
  }
  try {
    const revision = await persistRawValue(key, raw, legacyKey)
    if (mode.optimistic) removeInflight(raw)
    acceptWrite(key, raw, revision)
  } catch (error) {
    if (mode.optimistic) {
      removeInflight(raw)
      // 只有这笔仍是该 key 最新的本地意图时才保留显示：更老的失败不能盖住之后的选择。
      if (!lastOf(inflight, key)) failedOverrides.set(key, raw)
    }
    throw error
  } finally {
    notify()
  }
}

function migrateLegacyValue(options: ConfigPreferenceOptions<unknown>) {
  if (!initialized || !options.legacyKey || migrations.has(options.key)) return
  if (known.has(options.key)) {
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
 * 远程传输断开期间事件会丢（见 `api/transport.ts` 的 RECONNECTED_EVENT 契约），
 * 重连后主动读一次以纠正丢失的事件。仍有修订号约束：更旧的读取不会覆盖已知的更新状态。
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
