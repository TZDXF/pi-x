import { computed, onScopeDispose, watch, type Ref } from "vue"
import { MAX_SIDEBAR_TAB_GROUPS, MAX_SIDEBAR_TABS, type SidebarTabItem, type SidebarTabKind } from "@/lib/sidebarTabs"
import { useWorkspaceStore } from "@/stores/workspace"
import {
  activeIdFor,
  addTab,
  closeTab,
  groupKeyFor,
  hasGroup,
  hydrateGroup,
  isHydrated,
  markGroupDetached,
  persistedFor,
  pruneGroups,
  rebindGroup,
  releaseGroup,
  reorderTabs,
  retainGroup,
  setActiveTab,
  tabsFor,
} from "@/stores/sidebarTabs"

/**
 * 把 ChatView 的侧栏 Tab 接到模块级注册表（TZD-95）。
 *
 * 为什么必须出组件：`ChatView` 以 `activeRuntimeId` 为 key 挂载，切会话会整实例
 * 重挂载；设置页往返则是路由级卸载整组面板并销毁 Teleport 目标。组件内 `ref`
 * 两条路径都会丢，所以状态放在 `stores/sidebarTabs.ts`，本 composable 只负责：
 * 会话键计算、异步落盘到达后补 hydrate、文件键出现时迁移、每次变更写回、
 * 卸载时把 terminal Tab 标成 `stale`，以及按实例配平"该组仍被挂载"的持有关系
 * 与组数 LRU 回收的时机。
 */
export function useSidebarTabs(options: {
  runtimeId: string
  sessionFile: Ref<string | null>
  project: () => string
  /** 加第一个 Tab 时展开侧栏（`addSidebarTab` 的既有行为）。 */
  onFirstTabAdded?: () => void
  /** 关掉最后一个 Tab 时收起侧栏。 */
  onLastTabClosed?: () => void
  /** 达到单组上限（新增被拒绝）时给用户明确反馈。 */
  onTabLimitReached?: () => void
  /**
   * 存储替身：E2E 夹具里没有 Tauri transport，无法构造真实 workspace store。
   * 生产调用点不传，走 `useWorkspaceStore()`。
   */
  workspaceStore?: { sidebarTabs: Record<string, unknown>; persistSidebarTabs(key: string, value: unknown): void }
}) {
  const workspace = (options.workspaceStore ?? useWorkspaceStore()) as ReturnType<typeof useWorkspaceStore>
  const tabKey = computed(() => groupKeyFor(options.runtimeId, options.sessionFile.value, options.project()))

  const tabs = computed<SidebarTabItem[]>({
    get: () => tabsFor(tabKey.value),
    set: next => reorder(next),
  })
  const activeId = computed<number | null>({
    get: () => activeIdFor(tabKey.value),
    set: id => {
      setActiveTab(tabKey.value, id)
      // active 也要落盘：否则重启后恢复到错误的 Tab。
      persist()
    },
  })

  /** 把当前 kind 顺序与 active 写进 workspace.json；空列表写入方会删除该条目。 */
  function persist(key = tabKey.value) {
    workspace.persistSidebarTabs(key, persistedFor(key))
  }

  /**
   * 用落盘载荷补 hydrate。
   *
   * 两个约束：
   * - **不能**用一次性监听：`workspace.sidebarTabs` 被别的会话触发更新时也会走到这里，
   *   `once` 会被这一次消耗掉，导致本会话稍后到达的载荷永远不恢复；
   * - **不能**覆盖用户已加的状态：`addTab` 会先 `markHydrated`，这里先看
   *   `isHydrated` 就足够把"等待期间新加的 Tab"保护住。
   */
  function hydrateFromPersisted(key: string) {
    if (isHydrated(key)) return
    const persisted = workspace.sidebarTabs?.[key]
    if (persisted) hydrateGroup(key, persisted)
  }

  hydrateFromPersisted(tabKey.value)
  const stopHydrateWatch = watch(
    () => workspace.sidebarTabs,
    () => hydrateFromPersisted(tabKey.value),
  )
  onScopeDispose(stopHydrateWatch)

  /**
   * 本实例**实际 retain 过**的键。
   *
   * 身份键会在组件仍挂载时变（`runtime:` → 文件键、SSH realpath 回绑都会换键），
   * 所以不能释放时按"当前键"：那会把引用留在旧键、让新键（正在显示的那个）落到
   * LRU 淘汰里，同时旧 alias 键卸载后也永远不被回收。
   */
  let heldKey: string | null = null

  /**
   * 在挂载/换键点做一次组数回收。
   *
   * 键还没有内存组时按"预留 1 个"的口径回收（上限 - 1）：`tabs` 首次被读取时才会
   * 创建该组，按上限回收会让首渲染短暂出现「24 旧组 + 新空组 = 25」。
   */
  function pruneForCurrentGroup() {
    pruneGroups(hasGroup(tabKey.value) ? MAX_SIDEBAR_TAB_GROUPS : MAX_SIDEBAR_TAB_GROUPS - 1)
  }

  // 挂载即持有：此后该组的 LRU 淘汰被挡住（分屏里另一个窗格可能还有活终端）。
  retainGroup(tabKey.value)
  heldKey = tabKey.value
  pruneForCurrentGroup()

  const stopKeyWatch = watch(tabKey, (next, previous) => {
    if (!next || !previous || next === previous) return
    const previousHold = heldKey
    // 新键先受保护：迁移与 hydrate 之间它随时可能成为 LRU 的候选。
    retainGroup(next)
    heldKey = next
    if (previous.startsWith("runtime:")) {
      // 源非空 = 用户已经在草稿会话里加过 Tab。此时必须**立即**用新身份键写回并清掉
      // 旧 `runtime:` 条目，否则磁盘上只有草稿键，完整重启后 Tab 全丢
      // （不能等下一次侧栏操作才顺带写）。
      // 源为空则不写回：文件键可能已有磁盘载荷，写 null 会把它删掉；
      // 也不能把新键标成 hydrated，否则随后到达的落盘记录永远补不进来。
      if (rebindGroup(previous, next)) {
        workspace.persistSidebarTabs(previous, null)
        persist(next)
      }
    }
    // 新键还没有内容时，补一次 hydrate（不从磁盘删任何东西）。
    hydrateFromPersisted(next)
    // 旧键必须等迁移**之后**再释放：提前释放会让旧组在 rebind 之前就被淘汰。
    if (previousHold && previousHold !== next) releaseGroup(previousHold)
    pruneForCurrentGroup()
  })
  onScopeDispose(stopKeyWatch)

  // 组件卸载（切会话/设置页往返）时 shell 存活前提已破（`term_kill`），
  // 该组所有 terminal 必须转 `stale`，否则重挂载会直接挂 `TerminalPanel` 并自动开新 shell。
  // 释放按本实例的记录走，不按"当前键"（见 `heldKey`）。
  onScopeDispose(() => {
    markGroupDetached(tabKey.value)
    if (heldKey) releaseGroup(heldKey)
    heldKey = null
  })

  /**
   * 新增 Tab；到上限时拒绝并回调反馈（返回 `null`）。
   * 不能"先加进去、写盘时再截断"：那会显示成功却在重启后静默丢掉最新一个。
   */
  function add(type: SidebarTabKind) {
    const id = addTab(tabKey.value, type)
    if (id === null) {
      options.onTabLimitReached?.()
      return null
    }
    options.onFirstTabAdded?.()
    persist()
    return id
  }

  /** 关闭 Tab；关掉最后一个时同时收起侧栏（关闭不存在的 id 是幂等的）。 */
  function close(id: number) {
    const before = tabsFor(tabKey.value).length
    closeTab(tabKey.value, id)
    if (tabsFor(tabKey.value).length === before) return
    if (!tabsFor(tabKey.value).length) options.onLastTabClosed?.()
    persist()
  }

  /** 用户显式重开 terminal：清 stale，让面板重新挂载并开新 shell（不落盘）。 */
  function restartTerminal(id: number) {
    const tab = tabsFor(tabKey.value).find(item => item.id === id)
    if (tab) tab.stale = false
  }

  /** 拖拽排序；超限的尾部由注册表丢弃（内存里始终 ≤ `MAX_SIDEBAR_TABS`）。 */
  function reorder(next: SidebarTabItem[]) {
    reorderTabs(tabKey.value, next)
    persist()
  }

  return { tabKey, tabs, activeId, add, close, reorder, restartTerminal, limit: MAX_SIDEBAR_TABS }
}
