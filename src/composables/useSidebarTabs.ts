import { computed, watch, type Ref } from "vue"
import type { SidebarTabItem, SidebarTabKind } from "@/lib/sidebarTabs"
import { useWorkspaceStore } from "@/stores/workspace"
import {
  activeIdFor,
  addTab,
  closeTab,
  groupKeyFor,
  hydrateGroup,
  isHydrated,
  persistedFor,
  rebindGroup,
  reorderTabs,
  setActiveTab,
  tabsFor,
} from "@/stores/sidebarTabs"

/**
 * 把 ChatView 的侧栏 Tab 接到模块级注册表（TZD-95）。
 *
 * 为什么必须出组件：`ChatView` 以 `activeRuntimeId` 为 key 挂载，切会话会整实例
 * 重挂载；设置页往返则是路由级卸载整组面板并销毁 Teleport 目标。组件内 `ref`
 * 两条路径都会丢，所以状态放在 `stores/sidebarTabs.ts`，本 composable 只负责：
 * 会话键计算、异步落盘到达后补 hydrate、文件键出现时迁移、以及每次变更写回。
 */
export function useSidebarTabs(options: {
  runtimeId: string
  sessionFile: Ref<string | null>
  project: () => string
  /** 加第一个 Tab 时展开侧栏（`addSidebarTab` 的既有行为）。 */
  onFirstTabAdded?: () => void
  /** 关掉最后一个 Tab 时收起侧栏。 */
  onLastTabClosed?: () => void
}) {
  const workspace = useWorkspaceStore()
  const tabKey = computed(() =>
    groupKeyFor(options.runtimeId, options.sessionFile.value, options.project()),
  )

  const tabs = computed<SidebarTabItem[]>({
    get: () => tabsFor(tabKey.value),
    set: next => reorderTabs(tabKey.value, next),
  })
  const activeId = computed<number | null>({
    get: () => activeIdFor(tabKey.value),
    set: id => setActiveTab(tabKey.value, id),
  })

  /** 把当前 kind 顺序与 active 写进 workspace.json；空列表写入方会删除该条目。 */
  function persist() {
    workspace.persistSidebarTabs(tabKey.value, persistedFor(tabKey.value))
  }

  function hydrateFromPersisted(key: string) {
    if (isHydrated(key)) return
    // 落盘是异步加载的：没有载荷时不能标记"已确定"，否则迟到的条目永远补不进来。
    const persisted = workspace.sidebarTabs?.[key]
    if (persisted) hydrateGroup(key, persisted)
  }

  hydrateFromPersisted(tabKey.value)
  watch(
    () => workspace.sidebarTabs,
    () => hydrateFromPersisted(tabKey.value),
    { once: true },
  )
  watch(tabKey, (next, previous) => {
    if (!next || !previous || next === previous) return
    // 会话首次落盘：把 runtime 键上的 Tab 迁到文件键（同一会话在另一实例也可能开过）。
    if (previous.startsWith("runtime:")) {
      rebindGroup(previous, next)
      persist()
    }
    hydrateFromPersisted(next)
  })

  function add(type: SidebarTabKind) {
    addTab(tabKey.value, type)
    options.onFirstTabAdded?.()
    persist()
  }

  /** 关闭 Tab；关掉最后一个时同时收起侧栏（关闭不存在的 id 是幂等的）。 */
  function close(id: number) {
    const before = tabsFor(tabKey.value).length
    closeTab(tabKey.value, id)
    if (tabsFor(tabKey.value).length === before) return
    if (!tabsFor(tabKey.value).length) options.onLastTabClosed?.()
    persist()
  }

  /** 重启恢复的 terminal Tab：清 stale 让面板重新挂载（瞬时 UI 状态，不落盘）。 */
  function restartTerminal(id: number) {
    const tab = tabsFor(tabKey.value).find(item => item.id === id)
    if (tab) {
      tab.stale = false
      persist()
    }
  }

  function reorder(next: SidebarTabItem[]) {
    reorderTabs(tabKey.value, next)
    persist()
  }

  return { tabKey, tabs, activeId, add, close, reorder, restartTerminal }
}
