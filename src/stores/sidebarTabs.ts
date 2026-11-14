import { reactive } from "vue"
import {
  MAX_SIDEBAR_TABS,
  mergePersisted,
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
}

export const sidebarTabRegistry = reactive(new Map<string, GroupState>())

/**
 * 已经从"落盘 or 用户操作"确定过内容的键。
 *
 * 不能用 `sidebarTabRegistry.has(key)` 做这个判断：读取 `tabsFor()` 会创建空状态，
 * 于是"空"与"尚未 hydrate"无法区分，异步到达的落盘条目就永远补不进来。
 */
const hydratedKeys = new Set<string>()

/** 会话身份键（落盘分组键）：已落盘用文件身份，尚未落盘用 runtime 键。 */
export function groupKeyFor(runtimeId: string, sessionFile: string | null | undefined, project: string) {
  return sidebarTabGroupKey(runtimeId, sessionFile, project)
}

function stateFor(key: string): GroupState {
  let state = sidebarTabRegistry.get(key)
  if (!state) {
    state = { tabs: [], activeId: null, nextId: 1 }
    sidebarTabRegistry.set(key, state)
  }
  return state
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

export function addTab(key: string, type: SidebarTabKind): number {
  hydratedKeys.add(key)
  const state = stateFor(key)
  const id = state.nextId++
  state.tabs.push({ id, type })
  state.activeId = id
  return id
}

export function closeTab(key: string, id: number) {
  const state = stateFor(key)
  const index = state.tabs.findIndex(tab => tab.id === id)
  if (index < 0) return
  state.tabs.splice(index, 1)
  if (state.activeId === id)
    state.activeId = state.tabs[Math.min(index, state.tabs.length - 1)]?.id ?? null
}

export function reorderTabs(key: string, tabs: SidebarTabItem[]) {
  stateFor(key).tabs = tabs
}

export function setActiveTab(key: string, id: number | null) {
  stateFor(key).activeId = id
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
 * 只在"内存里还没有这个会话"时调用（`hydrate` 传 `onlyIfAbsent`），因此
 * "下次打开还在别的会话里"不会被旧载荷覆盖。
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
  return true
}

/**
 * 会话文件首次出现时把 `runtime:<id>` 组的 Tab 迁到文件键（`rebind`）。
 *
 * 两种情形都要处理：
 * - 目标键没有内容 → 直接搬过去；
 * - 目标键已有内容（同一会话在另一实例里也被打开过）→ 以当前内存为准覆盖。
 */
export function rebindGroup(fromKey: string, toKey: string) {
  if (fromKey === toKey) return
  hydratedKeys.delete(fromKey)
  const source = sidebarTabRegistry.get(fromKey)
  const target = sidebarTabRegistry.get(toKey)
  if (!source) {
    // 源没有状态：目标保留原位（可能是更早的实例留下的）。
    return
  }
  const merged = mergePersisted(
    target ? persistedFromTabs(target.tabs, target.activeId) : null,
    persistedFromTabs(source.tabs, source.activeId),
  )
  sidebarTabRegistry.delete(fromKey)
  if (merged) hydrateGroup(toKey, merged)
  else sidebarTabRegistry.delete(toKey)
}

/** 会话关闭/被淘汰时丢弃该组状态（不做落盘删除，落盘条目由调用方决定）。 */
export function dropGroup(key: string) {
  sidebarTabRegistry.delete(key)
  hydratedKeys.delete(key)
}

/** 判断某个 runtime 是否已经在注册表里（供 `ChatView` 挂载时决定是否 hydrate）。 */
export function groupKeyForRuntime(runtimeId: string, sessionFile: string | null | undefined, project: string) {
  const fileKey = sessionFile ? groupKeyFor("", sessionFile, project) : null
  if (fileKey && sidebarTabRegistry.has(fileKey)) return fileKey
  const runtimeKey = groupKeyFor(runtimeId, null, project)
  if (sidebarTabRegistry.has(runtimeKey)) return runtimeKey
  return null
}

export { MAX_SIDEBAR_TABS }
