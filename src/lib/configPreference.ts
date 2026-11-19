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

let preferences: Record<string, string> = {}
let initialized = false
let listening = false
/**
 * 本客户端最近写入的各偏好值（key → 值序列，最新在末尾）。
 *
 * 写入是排队的：连点「关→开」会先后写 `0`、`1`，而主机事件可能乱序到达（例如
 * 第一笔的 `0` 回执晚于第二笔写入）。整表应用这样的旧回执照会把 UI 从刚选的 `1`
 * 短暂扳回 `0`，所以：
 * - 快照值等于最新一次本地写入 → 这是它的回执，应用并清除记录；
 * - 快照值是本地写过的旧值但不等于最新 → 迟到的旧回执，跳过这个 key；
 * - 其余值 → 其它客户端 / 主机侧的真实变更，正常应用。
 * 这样既能拦住延迟旧事件，也不会永久屏蔽外部修改（有界记录，最多 4 个）。
 */
const RECENT_WRITE_LIMIT = 4
const recentWrites = new Map<string, string[]>()
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

function applyRawValue(key: string, raw: string, localWrite = false) {
  // 本地写入先乐观生效，并记下值序列，供迟到回执的判定使用。
  if (localWrite) {
    const writes = recentWrites.get(key) ?? []
    recentWrites.set(key, [...writes, raw].slice(-RECENT_WRITE_LIMIT))
  }
  preferences = { ...preferences, [key]: raw }
  notify()
}

/**
 * 用主机快照替换本地偏好，但不让尚未确认的旧快照反转较新的本地写入。
 * 其余 key 仍按整表替换（快照里没有的 key 会被丢弃），与原有语义一致。
 */
function replacePreferences(next: Record<string, string> | undefined) {
  const incoming = next ?? {}
  const merged: Record<string, string> = {}
  for (const [key, raw] of Object.entries(incoming)) {
    const writes = recentWrites.get(key)
    if (writes?.length) {
      const latest = writes[writes.length - 1]!
      if (raw === latest) recentWrites.delete(key)
      // 迟到的旧回执：跳过这个 key，保留用户最后的选择。
      else if (writes.includes(raw)) continue
      // 其它值视为真实的外部变更，正常应用。
    }
    merged[key] = raw
  }
  // 快照没提到的 key：本地写入还没收到回执时不能被快照抹掉，否则会闪回默认值。
  for (const [key, raw] of Object.entries(preferences)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key) && recentWrites.has(key)) merged[key] = raw
  }
  preferences = merged
  initialized = true
  notify()
  for (const migrate of migrationCallbacks) migrate()
}

/** Serialize writes within this client; the backend merges each key into the latest config. */
function persistRawValue(key: string, raw: string, legacyKey?: string): Promise<void> {
  const write = writeQueue
    .catch(() => {})
    .then(async () => {
      const { saveConfigPreference } = await import("@/api/client/config")
      await saveConfigPreference(key, raw)
      removeLegacyValue(legacyKey)
    })
  writeQueue = write
  return write
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
  void persistRawValue(options.key, raw, options.legacyKey)
    .then(() => applyRawValue(options.key, raw, true))
    .catch(error => console.warn(`[pi] failed to migrate preference ${options.key}:`, error))
    .finally(() => migrations.delete(options.key))
}

function startConfigListener() {
  if (listening) return
  listening = true
  void import("@/api/client/config")
    .then(({ onAppConfigChanged }) => onAppConfigChanged(config => replacePreferences(config.preferences)))
    .catch(() => {
      listening = false
    })
}

/** Load host-owned preferences. Safe to retry after remote authentication. */
export async function initializeConfigPreferences(config?: AppConfig): Promise<boolean> {
  try {
    const loaded = config ?? (await (await import("@/api/client/config")).getConfig())
    replacePreferences(loaded.preferences)
    startConfigListener()
    return true
  } catch {
    return false
  }
}

/** A validated config.json ref with optimistic UI updates and legacy migration. */
export function createConfigPreference<T>(options: ConfigPreferenceOptions<T>) {
  const fallback = () =>
    typeof options.defaultValue === "function" ? (options.defaultValue as () => T)() : options.defaultValue

  function read(): T {
    const raw = hasConfigValue(options.key) ? preferences[options.key]! : legacyValue(options.legacyKey)
    try {
      if (options.read) return options.read(raw)
      if (raw === null) return fallback()
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
      await persistRawValue(options.key, raw, options.legacyKey)
      applyRawValue(options.key, raw, true)
      return
    }
    applyRawValue(options.key, raw, true)
    try {
      await persistRawValue(options.key, raw, options.legacyKey)
    } catch (error) {
      // 写失败：这台机器上没有待确认的本地值了，后续快照应当照常应用。
      recentWrites.delete(options.key)
      console.warn(`[pi] failed to save preference ${options.key}:`, error)
    }
  }

  return { value: readonly(state), set, read }
}
