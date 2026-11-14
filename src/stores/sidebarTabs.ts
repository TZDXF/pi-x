import { reactive } from "vue"
import {
  MAX_SIDEBAR_TAB_GROUPS,
  MAX_SIDEBAR_TABS,
  markDetachedTabs,
  normalizePersistedSidebarTabs,
  persistedFromTabs,
  sidebarTabGroupKey,
  tabsFromPersisted,
  type PersistedSidebarTabs,
  type SidebarTabItem,
  type SidebarTabKind,
} from "@/lib/sidebarTabs"

/**
 * 右侧侧栏 Tab 的模块级注册表（TZD-95）。
 *
 * 为什么必须是模块级：`ChatView` 以 `activeRuntimeId` 为 key 挂载（`App.vue`），
 * 切换会话会整实例重挂载，组件内 `ref` 会丢；设置页往返则是路由级卸载整组面板
 * 并销毁 Teleport 目标 `#workspace-main`。把状态放在模块级 `reactive` 里，
 * 两条路径都能原样恢复（与 `stores/splitView.ts` 的既有做法一致）。
 *
 * 职责边界：只负责"每个会话有哪些 Tab、顺序与 active"，不持有任何面板内容
 * （review 选区、files 展开、browser URL、终端进程都不在这里）。
 */

interface GroupState {
  tabs: SidebarTabItem[]
  activeId: number | null
  nextId: number
  /** 最近一次被使用的时间戳，供组数超限时按 LRU 淘汰。 */
  usedAt: number
}

export const sidebarTabRegistry = reactive(new Map<string, GroupState>())

/**
 * 已经从"落盘 or 用户操作"确定过内容的键。
 *
 * 不能用 `sidebarTabRegistry.has(key)` 做这个判断：读取 `tabsFor()` 会创建空状态，
 * 于是"空"与"尚未 hydrate"无法区分，异步到达的落盘条目就永远补不进来。
 */
const hydratedKeys = new Set<string>()

/**
 * 仍被挂载中的 `ChatView` 持有的组（分屏会同时挂多个），淘汰时不能动这些组。
 *
 * 计数由调用方（`useSidebarTabs`）按"本实例实际 retain 过的键"配平：身份键
 * 会在组件仍挂载时变化（`runtime:` → 文件键、SSH realpath 回绑），所以释放
 * 必须按记录，而不是"当前键"。
 */
const liveRefs = new Map<string, number>()

let clock = 0

/** 会话身份键（落盘分组键）：已落盘用文件身份，尚未落盘用 runtime 键。 */
export function groupKeyFor(runtimeId: string, sessionFile: string | null | undefined, project: string) {
  return sidebarTabGroupKey(runtimeId, sessionFile, project)
}

/** 只读：不创建组。读取（`tabsFor`/`activeIdFor`）绝不能让组数超过上限。 */
function stateFor(key: string): GroupState | undefined {
  return sidebarTabRegistry.get(key)
}

/** 建组被拒时暂存的落盘载荷：等腾出名额后自动补 hydrate，不丢 Tab。 */
const pendingHydrate = new Map<string, unknown>()

/**
 * 建组被拒时排队的**挂载请求**（FIFO）。与 `pendingHydrate` 是两份队列：
 *
 * - `pendingRetain`：会话正在挂载、只是没名额建组 —— 名额一空出就要补准入，
 *   让该会话的侧栏**自动**恢复（用户不必切走再切回）；
 * - `pendingHydrate`：载荷到了但没名额建组 —— 名额空出后补 hydrate。
 *
 * 合并成一份会让"没有载荷的挂载"误触发 hydrate，反之也会漏掉挂载的准入。
 */
const pendingRetain = new Map<string, Array<(() => void) | null>>()

/**
 * 新建组的**容量准入**：先尽力腾出一个名额（`limit - 1`），仍然满就打回。
 *
 * 这是组数 ≤ `MAX_SIDEBAR_TAB_GROUPS` 的唯一入口 —— 先建后回收（或"删不掉就放行"）
 * 会让"分屏 + 休眠会话"把内存组数顶到 30 组，超限就不是不变量而是愿望。
 */
function ensureGroup(key: string): GroupState | null {
  const existing = sidebarTabRegistry.get(key)
  if (existing) return existing
  pruneGroups(MAX_SIDEBAR_TAB_GROUPS - 1)
  if (sidebarTabRegistry.size >= MAX_SIDEBAR_TAB_GROUPS) return null
  const state: GroupState = { tabs: [], activeId: null, nextId: 1, usedAt: ++clock }
  sidebarTabRegistry.set(key, state)
  return state
}

/** 当前内存组数（诊断与测试用）。 */
export function groupCount() {
  return sidebarTabRegistry.size
}

function touch(key: string) {
  const state = sidebarTabRegistry.get(key)
  if (state) state.usedAt = ++clock
}

/** 该会话是否已经确定过内容（空列表也是一个有效结论）。 */
export function isHydrated(key: string) {
  return hydratedKeys.has(key)
}

/** 标记为已确定（用户在该会话里加第一个 Tab 时也要调用）。 */
export function markHydrated(key: string) {
  hydratedKeys.add(key)
}

/** 该会话当前是否有内存状态。 */
export function hasGroup(key: string) {
  return sidebarTabRegistry.has(key)
}

/** 供 UI 绑定的只读快照；组不存在时返回同一份空数组（读取不建组）。 */
const EMPTY_TABS: SidebarTabItem[] = []
export function tabsFor(key: string): SidebarTabItem[] {
  return stateFor(key)?.tabs ?? EMPTY_TABS
}

export function activeIdFor(key: string) {
  return stateFor(key)?.activeId ?? null
}

/**
 * 新增 Tab。达到单组上限时**拒绝新增并返回 `null`**：不能"先加进去、写盘时再截断"，
 * 那会显示成功却在重启后静默丢掉最新一个 Tab。
 */
export function addTab(key: string, type: SidebarTabKind): number | null {
  hydratedKeys.add(key)
  const state = ensureGroup(key)
  // 容量准入失败（组数已满且所有组都被挂载持有）：明确拒绝，不超限建组。
  if (!state) return null
  if (state.tabs.length >= MAX_SIDEBAR_TABS) return null
  const id = state.nextId++
  state.tabs.push({ id, type })
  state.activeId = id
  touch(key)
  return id
}

export function closeTab(key: string, id: number) {
  const state = stateFor(key)
  if (!state) return
  const index = state.tabs.findIndex(tab => tab.id === id)
  if (index < 0) return
  state.tabs.splice(index, 1)
  if (state.activeId === id) state.activeId = state.tabs[Math.min(index, state.tabs.length - 1)]?.id ?? null
  touch(key)
}

/**
 * 拖拽排序。超过单组上限的尾部直接丢弃（不是拒绝整次重排），让"内存里 ≤20 条"
 * 的不变量不只依赖 `addTab`：拖拽是唯一可能绕过它把列表变长的入口。
 */
export function reorderTabs(key: string, tabs: SidebarTabItem[]) {
  const state = ensureGroup(key)
  if (!state) return
  state.tabs = tabs.slice(0, MAX_SIDEBAR_TABS)
  if (state.activeId !== null && !state.tabs.some(tab => tab.id === state.activeId))
    state.activeId = state.tabs[0]?.id ?? null
  touch(key)
}

export function setActiveTab(key: string, id: number | null) {
  const state = stateFor(key)
  if (!state) return
  state.activeId = id
  touch(key)
}

/** 当前状态的落盘载荷；空列表返回 `null`（调用方据此删除条目）。 */
export function persistedFor(key: string): PersistedSidebarTabs | null {
  const state = sidebarTabRegistry.get(key)
  if (!state) return null
  return persistedFromTabs(state.tabs, state.activeId)
}

/**
 * 用落盘载荷填充内存状态。
 *
 * 调用方只在"该键还没 hydrate 过"时调用；落盘条目可能晚于用户操作到达，
 * 那种情况由 `isHydrated` 挡住（`addTab` 会先标记 hydrated），
 * 避免把用户在等待期间新加的 Tab 覆盖掉。
 */
export function hydrateGroup(key: string, value: unknown): boolean {
  const persisted = normalizePersistedSidebarTabs(value)
  if (!persisted) {
    hydratedKeys.add(key)
    return false
  }
  const state = ensureGroup(key)
  if (!state) {
    // 容量准入失败：记住这份载荷而不建组，名额空出来后由 `flushPendingHydrate` 补上。
    // 这里**不**标记 hydrated —— 否则随后到达的载荷会被永久挡住。
    pendingHydrate.set(key, value)
    return false
  }
  hydratedKeys.add(key)
  let counter = state.nextId
  const rebuilt = tabsFromPersisted(persisted, () => counter++)
  state.tabs = rebuilt.tabs
  state.activeId = rebuilt.activeId
  state.nextId = rebuilt.nextId
  touch(key)
  // 该键可能正好有排队的挂载请求（迟到载荷）：建组即承认，避免"显示中被淘汰"。
  admitPendingRetain(key)
  return true
}

/**
 * 名额空出来后，把排队中的挂载请求补准入（FIFO，按登记顺序）。
 *
 * 与 `flushPendingHydrate` 分开：这里只处理"会话在挂载但没名额建组"，
 * 不碰任何载荷。腾不出名额的继续排队。
 */
let flushingRetain = false

export function flushPendingRetain(): number {
  // 防重入：`ensureGroup` 会调 `pruneGroups`，后者成功腾位又会回调本函数。
  if (flushingRetain) return 0
  flushingRetain = true
  let admitted = 0
  try {
    for (const [key, waiters] of [...pendingRetain]) {
      if (!waiters.length) {
        pendingRetain.delete(key)
        continue
      }
      if (sidebarTabRegistry.has(key)) {
        pendingRetain.delete(key)
        liveRefs.set(key, (liveRefs.get(key) ?? 0) + waiters.length)
        touch(key)
        for (const waiter of waiters) waiter?.()
        admitted += waiters.length
        continue
      }
      const state = ensureGroup(key)
      if (!state) break
      pendingRetain.delete(key)
      liveRefs.set(key, (liveRefs.get(key) ?? 0) + waiters.length)
      touch(key)
      admitted += waiters.length
      for (const waiter of waiters) waiter?.()
    }
    return admitted
  } finally {
    flushingRetain = false
  }
}

/**
 * 名额空出来后，把因容量准入被拒而暂存的载荷补 hydrate。
 *
 * 只尝试一次、按插入顺序，且每次都要重新走 `ensureGroup` 的准入：
 * 腾不出名额的继续暂存，等下一次释放。
 */
let flushing = false

export function flushPendingHydrate(): number {
  // 防重入：`ensureGroup` 内部会 `pruneGroups`，后者成功腾位又会回调本函数。
  if (flushing) return 0
  flushing = true
  try {
    return flushPendingHydrateOnce()
  } finally {
    flushing = false
  }
}

function flushPendingHydrateOnce(): number {
  let hydrated = 0
  for (const [key, value] of [...pendingHydrate]) {
    if (sidebarTabRegistry.has(key)) {
      pendingHydrate.delete(key)
      continue
    }
    if (!ensureGroup(key)) continue
    pendingHydrate.delete(key)
    const persisted = normalizePersistedSidebarTabs(value)
    const state = sidebarTabRegistry.get(key)
    if (!persisted || !state) continue
    hydratedKeys.add(key)
    let counter = state.nextId
    const rebuilt = tabsFromPersisted(persisted, () => counter++)
    state.tabs = rebuilt.tabs
    state.activeId = rebuilt.activeId
    state.nextId = rebuilt.nextId
    touch(key)
    admitPendingRetain(key)
    hydrated += 1
  }
  return hydrated
}

/**
 * 会话文件首次出现时把 `runtime:<id>` 组的 Tab 迁到文件键（`rebind`）。
 *
 * 返回值 = "是否真的带着 Tab 迁过去了"。调用方据此决定要不要**立即**用新身份键
 * 写回：源非空时不写，磁盘上就只剩 `runtime:` 条目，完整重启后 Tab 全丢
 * （不能等下一次侧栏操作才顺带写）。
 *
 * - 源不存在/为空 → 不动目标，也不把新键标记 hydrated。磁盘条目可能比 sessionFile
 *   先到，把新键标成 hydrated 会让随后到达的落盘记录被永久挡住；此时写 null 也会
 *   把文件键上已有的载荷删掉。
 * - 源非空 → 以源为准搬到目标（用户刚在草稿会话里操作过）。
 *   直接搬内存状态、不经落盘载荷重建：重建会把 terminal 一律标成 `stale`，而这条
 *   路径上 `ChatView` 并没有卸载、shell 还活着，标失联就是伪造死亡。
 *
 * 本函数只搬内存状态；"持有关系"（`liveRefs`）由调用方按自己的记录配平 ——
 * 身份变化不只是 `runtime:` → 文件键这一种（SSH realpath 回绑同样会换键）。
 */
export function rebindGroup(fromKey: string, toKey: string): boolean {
  if (fromKey === toKey) return false
  const source = sidebarTabRegistry.get(fromKey)
  hydratedKeys.delete(fromKey)
  if (!source) return false
  sidebarTabRegistry.delete(fromKey)
  if (!source.tabs.length) return false
  // 迁入目标同样要走容量准入：源先被删掉，所以这里实际是"原地改名"，仍受上限约束。
  const target = ensureGroup(toKey)
  if (!target) {
    // 腾不出名额：把源放回去，调用方据此知道迁移失败（不会写盘、不会丢 Tab）。
    sidebarTabRegistry.set(fromKey, source)
    return false
  }
  const state: GroupState = target
  state.tabs = source.tabs
  state.activeId = source.activeId
  state.nextId = Math.max(state.nextId, source.nextId)
  state.usedAt = Math.max(state.usedAt, source.usedAt, ++clock)
  sidebarTabRegistry.set(toKey, state)
  hydratedKeys.add(toKey)
  return true
}

/**
 * 组件卸载时调用：该组的所有 terminal Tab 置 `stale`。
 *
 * 为什么必须在卸载点做：组件卸载后注册表仍然存活（这正是持久化的目的），重挂载时
 * `isHydrated` 会阻止从落盘重建 —— 如果此时 terminal 还是"非 stale"，它会被当成
 * 活着的 shell 直接挂 `TerminalPanel`，而 `TerminalPanel` 首次可见会自动开一个新
 * shell，冒充"恢复成功"。shell 的存活前提在卸载时已经破了（`term_kill`）。
 */
export function markGroupDetached(key: string): boolean {
  const state = sidebarTabRegistry.get(key)
  return state ? markDetachedTabs(state.tabs) : false
}

/** 会话关闭/被淘汰时丢弃该组状态（不做落盘删除，落盘条目由调用方决定）。 */
export function dropGroup(key: string) {
  sidebarTabRegistry.delete(key)
  hydratedKeys.delete(key)
}

/**
 * 某个 `ChatView` 开始持有该组；配合 `releaseGroup` 让组数淘汰不误伤分屏中
 * 仍在显示的会话（它们的终端 Tab 还有活进程）。
 */
/**
 * 某个 `ChatView` 开始持有该组。
 *
 * 返回值 = "现在是否已经持有"。`false` 表示**已排队**（不是终态失败）：名额全被
 * 挂载持有时不超限建组，而是登记 FIFO 挂载请求，名额一空出就回调 `onAdmit`
 * 让调用方原地自愈（用户不需要切走再切回）。
 */
export function retainGroup(key: string, onAdmit?: () => void): boolean {
  const state = sidebarTabRegistry.has(key) ? sidebarTabRegistry.get(key)! : ensureGroup(key)
  if (!state) {
    const waiters = pendingRetain.get(key) ?? []
    waiters.push(onAdmit ?? null)
    pendingRetain.set(key, waiters)
    return false
  }
  liveRefs.set(key, (liveRefs.get(key) ?? 0) + 1)
  touch(key)
  return true
}

/** 排队中的挂载请求数量（诊断与测试用）。 */
export function pendingRetainCount() {
  return pendingRetain.size
}

/** 仅测试用：清空两份队列（用例之间隔离）。 */
export function resetQueuesForTest(): void {
  pendingHydrate.clear()
  pendingRetain.clear()
}

/** 组件卸载时撤销自己仍在排队的挂载请求（否则名额空出后会为一个已卸载的实例建组）。 */
export function dropPendingRetain(key: string): void {
  pendingRetain.delete(key)
}

/**
 * 某键刚被建出来时，把它排队中的挂载请求一并承认。
 *
 * 这是"迟到载荷建组必须同时 retain"的落点：`hydrateGroup` 成功建组后调用它，
 * 否则该组会处于"正在显示但没人持有"的状态，下一次 LRU 压力就会把它淘汰。
 */
function admitPendingRetain(key: string): void {
  const waiters = pendingRetain.get(key)
  if (!waiters) return
  pendingRetain.delete(key)
  liveRefs.set(key, (liveRefs.get(key) ?? 0) + waiters.length)
  touch(key)
  for (const waiter of waiters) waiter?.()
}

/** 该组当前的持有计数（供诊断与测试核对 retain/release 是否配平）。 */
export function retainedGroupCount(key: string) {
  return liveRefs.get(key) ?? 0
}

/** 释放一次持有。调用方必须释放**自己实际 retain 过的键**，不能按"当前键"。 */
export function releaseGroup(key: string) {
  const count = liveRefs.get(key) ?? 0
  if (count <= 1) liveRefs.delete(key)
  else liveRefs.set(key, count - 1)
  // 释放后组数可能已经能回到上限内：补一次回收，别等下一次挂载才收。
  pruneGroups(MAX_SIDEBAR_TAB_GROUPS)
  // 名额空出来了：排队的挂载请求先补准入（用户不必切走再切回），
  // 再补被挡在门外的落盘载荷（它们自带数据，值得挤掉一个闲置空组）。
  if (pendingRetain.size > 0) flushPendingRetain()
  if (pendingHydrate.size > 0) flushPendingHydrate()
}

/**
 * 组数超限时按 LRU 淘汰内存态（落盘条目保留，重新打开该会话时再 hydrate）。
 * 仍被挂载的组（`liveRefs`）绝不淘汰；全部组都被持有时放弃淘汰而不是误伤。
 */
export function pruneGroups(limit = MAX_SIDEBAR_TAB_GROUPS): number {
  let freed = 0
  while (sidebarTabRegistry.size > limit) {
    let victim: string | null = null
    let oldest = Infinity
    for (const [key, state] of sidebarTabRegistry) {
      if (liveRefs.has(key)) continue
      if (state.usedAt < oldest) {
        oldest = state.usedAt
        victim = key
      }
    }
    // 全部组都被挂载持有：**腾不出名额**，如实返回 0，由调用方拒绝新建，
    // 不再静默 return 让调用方以为已经腾好了（那是 30 组的直接来源）。
    if (!victim) break
    dropGroup(victim)
    freed += 1
  }
  if (freed > 0) {
    flushPendingRetain()
    flushPendingHydrate()
  }
  return freed
}

/** 判断某个 runtime 是否已经在注册表里（供 `ChatView` 挂载时决定是否 hydrate）。 */
export function groupKeyForRuntime(runtimeId: string, sessionFile: string | null | undefined, project: string) {
  const fileKey = sessionFile ? groupKeyFor("", sessionFile, project) : null
  if (fileKey && sidebarTabRegistry.has(fileKey)) return fileKey
  const runtimeKey = groupKeyFor(runtimeId, null, project)
  if (sidebarTabRegistry.has(runtimeKey)) return runtimeKey
  return null
}

export { MAX_SIDEBAR_TAB_GROUPS, MAX_SIDEBAR_TABS }

/** 仅测试用：被容量准入挡下、暂存待 hydrate 的载荷数量。 */
export function pendingHydrateSizeForTest() {
  return pendingHydrate.size
}
