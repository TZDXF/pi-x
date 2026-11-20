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
 * 模型分三层，互不替代：
 * 1. `known` / `coverage`：**主机状态**。`known` 按 key 记录「在哪一修订上得知这个值」；
 *    `coverage` 记住最新一份完整快照的修订与它包含的 key 集合，因此「该修订上主机确实
 *    没有某个 key」（包括本端从未见过的 key）同样有水位，更旧的快照无法把它复活。
 * 2. `inflight` / `unseen` / `failedOverrides`：**显示遮挡**，只决定此刻的显示值，
 *    不参与「主机状态」的判断。因此慢连接下收到的更新快照照样被记录，命令一完成就
 *    让位给更高修订的外部值。
 * 3. `seenRevision`：仅用于识别「缺字段的旧格式快照」（新后端始终输出该字段），
 *    不用来判断整表是否过时 —— 那是逐 key 的事。
 *
 * 之所以按 key 记录修订：单键写成功只证明这一个 key 在 rN 上是我们的值，不能把
 * 「完整快照」的水位推到 rN，否则仍带其它 key 新信息的 r(N-1) 全量事件会被整份丢弃。
 */
interface KnownValue {
  raw: string
  /** 得知这个值的修订号；null 表示来自「不带修订号」的旧后端快照。 */
  revision: number | null
}

/** 一笔命令尚未返回的本地写入。按对象身份逐笔清理，避免按值误删后续同值写入。 */
interface InflightWrite {
  raw: string
  /** 旧后端：这笔写入的回执快照是否已经途经本端。 */
  echoed: boolean
  /** 命令是否已经真正发出（写入在本端是按顺序排队的，队首才是正在执行的那一笔）。 */
  dispatched: boolean
}

/** 我们已知的主机 preferences（按 key 带上得知时的修订号）。**不是**显示值。 */
const known = new Map<string, KnownValue>()
/**
 * 最新一份完整快照的修订号与它列出的 key 集合。
 * 快照永远是「整表 preferences」，所以「在 rN 上主机没有某个 key」是一份合法证据 ——
 * 包括本端从未见过的 key（`known` 里没有它的记录）。更旧的快照不能把这类 key 复活。
 */
let coverage: { revision: number; keys: Set<string> } | null = null
/** 命令尚未返回的写入（key → 队列，末尾是最新意图）：只影响显示。 */
const inflight = new Map<string, InflightWrite[]>()
/**
 * 旧后端专用：命令已成功、但回执快照还没到的写入（key → raw 队列，末尾是最新一笔）。
 *
 * 旧后端按序执行写入、每笔先广播完整快照再返回，所以早到的回执只对应「已经发出的
 * 队首请求」（见 `inflight` 的 dispatched 标志）；这里的队列只负责在推送到达时按 FIFO
 * 认领回执，显示只用末尾那一笔（最新一笔尚未确认的本地写入）。
 */
const unseen = new Map<string, string[]>()
/**
 * 本端为该 key 写过的原始值历史（有界）。旧协议里「别的键写入」也会广播整表，
 * 于是我们会收到携带自己旧值的重复快照 —— 值能在历史里找到就说明它是重复广播，
 * 而不是别的客户端把该键改回某个我们从未写过的值。
 */
const RECENT_LOCAL_WRITES_LIMIT = 8
const localWrites = new Map<string, string[]>()
/** 宽松写入失败后仍保留在界面上的本地选择；被采纳的主机快照会清掉它。 */
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
 * - 不带，但本端已经见过修订号 → 这是旧格式快照（新后端始终输出该字段），按 R0 处理；
 * - 不带且从未见过修订号 → 旧后端，走 FIFO 降级。
 */
function effectiveRevision(revision: number | undefined): number | null {
  if (typeof revision === "number") return revision
  return seenRevision >= 0 ? 0 : null
}

function lastOf<T>(map: Map<string, T[]>, key: string): T | undefined {
  const list = map.get(key)
  return list?.[list.length - 1]
}

/**
 * 显示用的 raw：在途写入 > 旧后端待回执写入 > 写失败保留值 > 主机状态。
 * `unseen` 只保存「已成功但回执还没到」的那一笔（acceptWrite 会整组替换），
 * 因此它不会盖住之后被确认的更新写入。
 */
function effectiveRaw(key: string): string | undefined {
  const pending = lastOf(inflight, key)
  if (pending) return pending.raw
  const unseenRaw = lastOf(unseen, key)
  if (unseenRaw !== undefined) return unseenRaw
  const failed = failedOverrides.get(key)
  if (failed !== undefined) return failed
  return known.get(key)?.raw
}

/**
 * 采用快照里的一个 key（写入**主机状态**层）。
 * 只有比我们已知的更新（或同级）才写；若已知「该修订上主机没有这个 key」，更旧的快照不能复活它。
 */
function adopt(key: string, raw: string, revision: number) {
  const knownRev = known.get(key)?.revision
  // 我们已知的修订更新 → 旧快照不能回退它。
  if (knownRev != null && typeof revision === "number" && knownRev > revision) return
  // 更旧的快照里没有这个 key，而更新的完整快照里也没有：说明主机那里它已不存在。
  if (typeof revision === "number" && coverage && revision < coverage.revision && !coverage.keys.has(key)) return
  known.set(key, { raw, revision })
}

/** 记录一份完整快照的覆盖范围（修订 + 它列出的 key）。 */
function recordCoverage(revision: number, keys: Set<string>) {
  if (coverage && revision < coverage.revision) return
  coverage = { revision, keys }
  // 该修订上不存在的 key，其已知值一律作废。
  for (const key of [...known.keys()]) {
    if (keys.has(key)) continue
    const knownValue = known.get(key)!
    if (knownValue.revision !== null && knownValue.revision <= revision) known.delete(key)
  }
}

function rememberLocalWrite(key: string, raw: string) {
  const previous = localWrites.get(key) ?? []
  localWrites.set(key, [...previous, raw].slice(-RECENT_LOCAL_WRITES_LIMIT))
}

/** 这个值是本端自己写过的（因此这份快照很可能是重复整表广播，而不是主机的更新）。 */
function isOwnEarlierWrite(key: string, value: string): boolean {
  return localWrites.get(key)?.includes(value) ?? false
}

/**
 * 一次歧义引发的权威读取：把「无法认领的旧协议快照」交给主机真值裁决。
 * 只保留一个在途请求，避免多次歧义快照堆叠成读取风暴。
 */
let resolving = false
function requestAuthoritativeResolution() {
  if (resolving) return
  resolving = true
  void refreshFromHost().finally(() => {
    resolving = false
  })
}

function clearFailedOverrides() {
  for (const key of [...failedOverrides.keys()]) if (!inflight.has(key)) failedOverrides.delete(key)
}

/**
 * 应用一份主机快照（推送事件或主动读取）到**主机状态**层。
 *
 * 数字修订：按 key 合并 —— 单键回执只推进该 key，不会让其它 key 的新信息被丢弃；
 * 缺 key 时记录「该修订上确实没有它」，更旧的快照因此不能让它复活。
 * 无修订号（旧后端）：`authoritative`（主动读取）以整表为准；否则按 key FIFO 确认回执。
 *
 * 在途写入不阻止这里更新主机状态（否则慢连接下收到的更新快照会被丢掉），它只通过
 * `effectiveRaw` 暂时遮住显示。
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
      adopt(key, incoming[key]!, revision)
      // 数字快照已覆盖这笔写入的更早阶段，之后不再需要 FIFO 确认。
      unseen.delete(key)
    }
    recordCoverage(revision, new Set(keys))
  } else if (snapshot.authoritative) {
    // 旧后端主动读取：整表即主机真值。命令已返回的旧写入不再逐笔确认 —— 否则要读多次，
    // 且键被外部删掉时也永远不会回落到默认值。
    for (const key of [...unseen.keys()]) if (!inflight.has(key)) unseen.delete(key)
    for (const key of keys) {
      adopt(key, incoming[key]!, -1)
    }
    for (const key of [...known.keys()]) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) continue
      known.delete(key)
    }
  } else {
    // 旧后端推送：可能既是「我们某笔写入的回执」，也可能是别的客户端的真实变更。
    //
    // 旧后端的写入按序执行、每笔先落地再广播，所以回执按我们的写入顺序到达。判定顺序：
    // 1. **先认领已完成的待回执记录**（`unseen`）：命令已返回但回执还没到的那些写入，
    //    它们的回执可能晚于「下一笔已发出的命令」到达 —— 若先比对正在执行的请求，
    //    这些合法回执会被误判成外部状态并整队清空；
    // 2. 再认领当前已发请求（`inflight` 里 dispatched 的那笔），回执先于命令结果到达；
    // 3. 两者都不匹配 → 别的客户端的真实变更：采用并作废旧记录。
    let ambiguous = false
    for (const key of keys) {
      const value = incoming[key]!
      const waiting = unseen.get(key)
      const unacknowledged = waiting ? waiting.indexOf(value) : -1
      if (waiting && unacknowledged >= 0) {
        // 回执按序到达：它以及它之前的记录都已被主机确认。
        const rest = waiting.slice(unacknowledged + 1)
        if (rest.length) unseen.set(key, rest)
        else unseen.delete(key)
        continue
      }
      const executing = inflight.get(key)?.find(entry => entry.dispatched)
      if (executing) {
        // 回执先于命令结果到达：标记它，成功后就不必再等 FIFO 确认。
        if (executing.raw === value) executing.echoed = true
        continue
      }
      // 值与我们已知的主机状态相同 → 这就是「别的键写入时重复广播」的整表快照，
      // 不是新的主机状态：既不改状态，也不能清掉该键的待回执记录。
      if (known.get(key)?.raw === value) continue
      // 值与我们尚未确认的写入集合同源（本端写过的值，且该键仍有多笔待确认 / 在途写入）：
      // 旧协议下无法把它与「重复广播」区分开。保留最新本地意图、不让显示倒退，
      // 其余键照常合入，并交给一次权威读取裁决。
      const pendingCount = (inflight.get(key)?.length ?? 0) + (unseen.get(key)?.length ?? 0)
      if (pendingCount >= 2 && isOwnEarlierWrite(key, value)) {
        ambiguous = true
        continue
      }
      // 其余情况视为别的客户端的真实变更：采用，并作废旧记录。
      unseen.delete(key)
      adopt(key, value, -1)
    }
    if (ambiguous) requestAuthoritativeResolution()
  }

  clearFailedOverrides()
  initialized = true
  notify()
  for (const migrate of migrationCallbacks) migrate()
}

/**
 * Serialize writes within this client; the backend merges each key into the latest config.
 * `onDispatch` 在这笔命令真正发出前触发（排队等待期间还没有发出，旧后端的早到回执不可能对应它）。
 */
function persistRawValue(
  key: string,
  raw: string,
  legacyKey: string | undefined,
  onDispatch: () => void,
): Promise<number | undefined> {
  const write = writeQueue
    .catch(() => {})
    .then(async () => {
      onDispatch()
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
function acceptWrite(key: string, raw: string, revision: number | undefined, echoed: boolean) {
  if (revision === undefined) {
    // 旧后端：命令成功即主机已接受。
    adopt(key, raw, -1)
    if (echoed) {
      // 回执已经途经本端：主机状态已越过这笔写入，之前的「待回执」记录全部作废
      //（否则旧记录会盖住这次已确认的更新）。
      unseen.delete(key)
    } else {
      // 回执还没到：记账等待 FIFO 认领；显示只用末尾那笔（最新意图）。
      unseen.set(key, [...(unseen.get(key) ?? []), raw])
    }
    notify()
    return
  }
  if (revision > seenRevision) seenRevision = revision
  // 带修订号的写入：数字快照已经能表达主机状态，旧后端队列不再需要。
  unseen.delete(key)
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
  rememberLocalWrite(key, raw)
  const entry: InflightWrite | null = mode.optimistic ? { raw, echoed: false, dispatched: false } : null
  if (entry) {
    inflight.set(key, [...(inflight.get(key) ?? []), entry])
    notify()
  }
  /** 按身份移除这一笔：同值但仍在排队的后续写入必须留下。 */
  const dropInflight = () => {
    if (!entry) return
    const list = inflight.get(key)
    if (!list) return
    const remaining = list.filter(candidate => candidate !== entry)
    if (remaining.length) inflight.set(key, remaining)
    else inflight.delete(key)
  }
  try {
    const revision = await persistRawValue(key, raw, legacyKey, () => {
      if (entry) entry.dispatched = true
    })
    acceptWrite(key, raw, revision, entry?.echoed ?? false)
  } catch (error) {
    dropInflight()
    // 只有这笔仍是该 key 最新的本地意图时才保留显示：更老的失败不能盖住之后的选择。
    if (mode.optimistic && !lastOf(inflight, key)) failedOverrides.set(key, raw)
    throw error
  } finally {
    dropInflight()
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
