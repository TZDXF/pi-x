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

function stateFor(key: string): GroupState {
  let state = sidebarTabRegistry.get(key)
  if (!state) {
    state = { tabs: [], activeId: null, nextId: 1, usedAt: ++clock }
    sidebarTabRegistry.set(key, state)
  }
  return state
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

/** 供 UI 绑定的只读快照；每次调用都返回同一 reactive 对象，避免重建引用。 */
export function tabsFor(key: string): SidebarTabItem[] {
  return stateFor(key).tabs
}

export function activeIdFor(key: string) {
  return stateFor(key).activeId
}

/**
 * 新增 Tab。达到单组上限时**拒绝新增并返回 `null`**：不能"先加进去、写盘时再截断"，
 * 那会显示成功却在重启后静默丢掉最新一个 Tab。
 */
export function addTab(key: string, type: SidebarTabKind): number | null {
  hydratedKeys.add(key)
  const state = stateFor(key)
  if (state.tabs.length >= MAX_SIDEBAR_TABS) return null
  const id = state.nextId++
  state.tabs.push({ id, type })
  state.activeId = id
  touch(key)
  return id
}

export function closeTab(key: string, id: number) {
  const state = stateFor(key)
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
  const state = stateFor(key)
  state.tabs = tabs.slice(0, MAX_SIDEBAR_TABS)
  if (state.activeId !== null && !state.tabs.some(tab => tab.id === state.activeId))
    state.activeId = state.tabs[0]?.id ?? null
  touch(key)
}

export function setActiveTab(key: string, id: number | null) {
  stateFor(key).activeId = id
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
  hydratedKeys.add(key)
  const persisted = normalizePersistedSidebarTabs(value)
  if (!persisted) return false
  const state = stateFor(key)
  let counter = state.nextId
  const rebuilt = tabsFromPersisted(persisted, () => counter++)
  state.tabs = rebuilt.tabs
  state.activeId = rebuilt.activeId
  state.nextId = rebuilt.nextId
  touch(key)
  return true
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
  const target = sidebarTabRegistry.get(toKey)
  const state: GroupState = target ?? { tabs: [], activeId: null, nextId: 1, usedAt: ++clock }
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
export function retainGroup(key: string) {
  liveRefs.set(key, (liveRefs.get(key) ?? 0) + 1)
  touch(key)
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
}

/**
 * 组数超限时按 LRU 淘汰内存态（落盘条目保留，重新打开该会话时再 hydrate）。
 * 仍被挂载的组（`liveRefs`）绝不淘汰；全部组都被持有时放弃淘汰而不是误伤。
 */
export function pruneGroups(limit = MAX_SIDEBAR_TAB_GROUPS) {
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
    if (!victim) return
    dropGroup(victim)
  }
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
