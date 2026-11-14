import { computed, onScopeDispose, watch, type Ref } from "vue"
import { MAX_SIDEBAR_TAB_GROUPS, MAX_SIDEBAR_TABS, type SidebarTabItem, type SidebarTabKind } from "@/lib/sidebarTabs"
import { useWorkspaceStore } from "@/stores/workspace"
import {
  activeIdFor,
  dropPendingRetain,
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
   * 达到内存组数上限、腾不出名额（全部组都被挂载持有）时回调：此时不建组，
   * 调用方应提示"侧栏暂不可用/请先关闭其他会话"之类的可执行动作。
   */
  onGroupLimitReached?: () => void
  /**
   * 存储替身：E2E 夹具里没有 Tauri transport，无法构造真实 workspace store。
   * 生产调用点不传，走 `useWorkspaceStore()`。
   */
  workspaceStore?: { sidebarTabs: Record<string, unknown>; persistSidebarTabs(key: string, value: unknown): void }
}) {
  const workspace = (options.workspaceStore ?? useWorkspaceStore()) as ReturnType<typeof useWorkspaceStore>
  const tabKey = computed(() => groupKeyFor(options.runtimeId, options.sessionFile.value, options.project()))

  const tabs = computed<SidebarTabItem[]>({
    // 读取不建组：组由 `retainGroup` 的容量准入创建，否则首渲染会超限。
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
   * 本挂载实例的稳定标识（生命周期内不变）。
   *
   * 排队中的挂载请求按它归属：身份键会变（`runtime:` → 文件键、SSH realpath 回绑），
   * 卸载时必须按**实例**撤销该实例排队过的**所有键**，只撤当前键会留下已卸载实例的
   * 请求 —— 名额一空出就给它建组、retain=1 且无人释放，永久占名额。
   */
  const owner = `${options.runtimeId}:${Math.random().toString(36).slice(2)}`

  /**
   * 在挂载/换键点做一次组数回收。
   *
   * 容量准入已经在**建组前**做了（`retainGroup` 会先腾名额、腾不出就拒绝建组），
   * 因此这里只需常规回收，不再用"预留 1 个"的技巧去救首渲染 25 组的中间态。
   */
  function pruneForCurrentGroup() {
    pruneGroups(MAX_SIDEBAR_TAB_GROUPS)
  }

  /**
   * 把"本实例获得了某个键"这件事记下来，并补齐该键应有的状态。
   *
   * 既在挂载时直接调用，也作为 `retainGroup` 的排队回调 —— 名额空出后由注册表
   * 原地回调，用户不必切走再切回。
   */
  function adoptKey(key: string) {
    heldKey = key
    hydrateFromPersisted(key)
    // 组刚建出来时可能还没被读取过：读一次让响应式 `tabs` 立刻有内容。
    if (!tabsFor(key).length) tabsFor(key)
  }

  /**
   * 身份键变化的**唯一实现**（立即路径与延迟准入路径都调它，不许第二份）。
   *
   * 语义来自 `1eefeda`：源非空 → 搬内存 + 立即用新身份键写回 + 清旧 `runtime:` 条目；
   * 源为空 → 不写回、也不把新键标 hydrated（否则会删掉/挡住磁盘上已有的载荷）。
   * 活 terminal 不标 stale（`rebindGroup` 直接搬内存状态，不经落盘载荷重建）。
   */
  function applyRebind(previous: string, next: string) {
    if (!previous || !next || previous === next) return
    if (previous.startsWith("runtime:") && rebindGroup(previous, next)) {
      workspace.persistSidebarTabs(previous, null)
      persist(next)
    }
    hydrateFromPersisted(next)
  }

  // 挂载即持有：容量准入先腾名额再建组；腾不出（全部组都被挂载持有）时**排队**，
  // 名额空出后自动准入（`adoptKey` 作为回调），因此这不是终态失败。
  if (retainGroup(tabKey.value, () => adoptKey(tabKey.value), owner)) {
    adoptKey(tabKey.value)
  } else {
    options.onGroupLimitReached?.()
  }
  pruneForCurrentGroup()

  const stopKeyWatch = watch(tabKey, (next, previous) => {
    if (!next || !previous || next === previous) return
    const previousHold = heldKey
    // 新键先受保护：迁移与 hydrate 之间它随时可能成为 LRU 的候选。
    // 准入失败时排队；回调里必须**重跑同一份 rebind 逻辑**（立即路径与延迟路径
    // 不许有第二份实现），否则"runtime 源已有 Tab → 排队 → 名额空出"这条路径上
    // 新身份键 tabs=[]、落盘 undefined、旧 runtime 载荷未清。
    const admitted = retainGroup(
      next,
      () => {
        adoptKey(next)
        // 写回只由 `applyRebind` 内部按"源非空"决定：这里不能再无条件 `persist(next)`，
        // 否则空 runtime 源 + 名额空出这条路径会写出 null，把磁盘上已有的文件键载荷删掉。
        applyRebind(previous, next)
        if (previousHold && previousHold !== next) releaseGroup(previousHold)
        pruneForCurrentGroup()
      },
      owner,
    )
    if (!admitted) {
      options.onGroupLimitReached?.()
      return
    }
    heldKey = next
    applyRebind(previous, next)
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
    // **顺序不可颠倒**：`releaseGroup` 会同步 flush 排队队列，若先 release 再撤销，
    // 本实例刚让出名额的那一次 flush 会把自己排队中的新身份键准入进去 ——
    // 已卸载实例于是留下 retain=1 的幽灵组（无人释放，永久占名额）。
    // 先声明"本实例不再要了"（撤销它排队过的所有键），再让出名额。
    // 按**实例**撤销：身份键可能变过，只撤当前键会留下旧键请求。
    dropPendingRetain(owner)
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
      if (hasGroup(tabKey.value)) options.onTabLimitReached?.()
      else options.onGroupLimitReached?.()
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
