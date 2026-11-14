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
 * 卸载时把 terminal Tab 标成 `stale`，以及组数超限时的 LRU 淘汰。
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
   * 持有关系：本实例**实际 retain 过的键**（可能是多个）。
   *
   * 不能只记一个布尔、再"按当前键释放"：身份键会在组件仍挂载时变化——
   * `sessionFile` 首次出现、以及 `workspaceRuntime` 的 `onSshPathBound` 在 realpath
   * 回绑后更新 `cwd`。按当前键释放会造成"新键没 retain（被 prune 掉）、旧 alias 键
   * retain 了却没人放"的失配。所以逐键记录，释放时按记录逐个释放。
   */
  const retainedKeys = new Set<string>()
  function hold(key: string) {
    if (retainedKeys.has(key)) return
    // 按"预留 1 个"的口径回收：先腾位置、再建组，组数在创建这一刻也不会瞬时到 25。
    // （若先建后 prune，24 个旧组 + 刚建的新组会短暂被观察到 25 个。）
    if (!hasGroup(key)) pruneGroups(MAX_SIDEBAR_TAB_GROUPS - 1)
    // `tabsFor` 同时保证该组真的存在于注册表（首次渲染也走这条）。
    tabsFor(key)
    retainGroup(key)
    retainedKeys.add(key)
  }
  function releaseAll() {
    for (const key of retainedKeys) releaseGroup(key)
    retainedKeys.clear()
  }

  const stopKeyWatch = watch(tabKey, (next, previous) => {
    if (!next || !previous || next === previous) return
    // 会话首次落盘：把 runtime 键上的 Tab 迁到文件键。
    if (previous.startsWith("runtime:")) {
      // 非空源 = 用户已经在草稿会话里加过 Tab。此时必须**立即**用新身份键写回并清掉
      // 旧 runtime 键：只搬内存不写盘的话，磁盘上只剩 `runtime:` 条目，完整刷新后
      // 文件键为空、Tab 全丢（不能等下一次侧栏操作才顺带写）。
      // 空源不写回：文件键可能已有磁盘载荷，写 null 会把它删掉。
      if (rebindGroup(previous, next)) {
        workspace.persistSidebarTabs(previous, null)
        persist(next)
      }
    }
    // 任意身份变化都把持有关系挪到新键（不只是 runtime→文件迁移：SSH realpath 回绑
    // 同样会在挂载期间改 cwd）。先 retain 新键再释放旧键，切换过程中不会出现
    // "两组都不受保护"的窗口。
    hold(next)
    releaseGroup(previous)
    retainedKeys.delete(previous)
    // 新键还没有内容时，补一次 hydrate（不从磁盘删任何东西）。
    hydrateFromPersisted(next)
  })
  onScopeDispose(stopKeyWatch)

  // 组件卸载（切会话/设置页往返）时 shell 存活前提已破（`term_kill`），
  // 该组所有 terminal 必须转 `stale`，否则重挂载会直接挂 `TerminalPanel` 并自动开新 shell。
  onScopeDispose(() => {
    markGroupDetached(tabKey.value)
  })

  hold(tabKey.value)
  pruneGroups()

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

  function reorder(next: SidebarTabItem[]) {
    reorderTabs(tabKey.value, next)
    persist()
  }

  onScopeDispose(releaseAll)

  return { tabKey, tabs, activeId, add, close, reorder, restartTerminal, limit: MAX_SIDEBAR_TABS }
}
