import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { MAX_SIDEBAR_TABS, type SidebarTabItem, type SidebarTabKind } from "@/lib/sidebarTabs"
import type { AuxParentContext } from "@/lib/auxSpawn"
import { useAuxTabs } from "@/composables/useAuxTabs"
import { useSidebarTabs } from "@/composables/useSidebarTabs"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"

/**
 * `ChatView` 的右侧侧栏接线：一次装配两套注册表。
 *
 * - `useSidebarTabs`（TZD-95）：会话级 Tab 槽位（顺序 / active / 落盘 / 组 LRU）；
 * - `useAuxTabs`（TZD-101）：`aux` 实例（进程 / store / 关闭销毁），槽位从前者申请。
 *
 * 合成一个 composable 的原因：aux 的"加/关"入口必须包住非 aux 的"加/关"（只有
 * `aux` 要起进程），两者天然一起装配；而 `ChatView` 的规模护栏要求视图只接线、
 * 逻辑在 composable 里。
 */
export function useChatViewSidebar(deps: {
  runtimeId: string
  session: SessionStore
  ui: UiStore
  /** 父会话 cwd 来源（`session.cwd || props.project`）。 */
  project: () => string
  /** 加第一个 Tab 时展开侧栏；关掉最后一个时收起（`ChatView` 的 `sidebarOpen`）。 */
  onFirstTabAdded: () => void
  onLastTabClosed: () => void
}) {
  const { t } = useI18n()
  const workspace = useWorkspaceStore()
  const sidebar = useSidebarTabs({
    runtimeId: deps.runtimeId,
    sessionFile: computed(() => deps.session.sessionFile),
    project: deps.project,
    onFirstTabAdded: deps.onFirstTabAdded,
    onLastTabClosed: deps.onLastTabClosed,
    // 上限在注册表 `addTab` 上硬拦（不是写盘时截断）：界面显示成功、重启静默丢 Tab 不可接受。
    onTabLimitReached: () => deps.ui.pushToast(t("sidebarTabs.limitReached", { count: MAX_SIDEBAR_TABS }), "warning"),
    // 组数准入排队时必须告知（会自愈，不静默）。
    onGroupLimitReached: () => deps.ui.pushToast(t("sidebarTabs.groupLimitReached"), "warning"),
  })
  const aux = useAuxTabs({
    runtimeId: deps.runtimeId,
    session: deps.session,
    ui: deps.ui,
    workspace,
    project: deps.project,
    addSidebarTab: sidebar.add,
    closeSidebarTab: sidebar.close,
    activate: (id: number) => (sidebar.activeId.value = id),
    tabs: () => sidebar.tabs.value,
  })

  return {
    /** 槽位列表（含 `aux`；`aux` 永不落盘）。 */
    tabs: sidebar.tabs as ComputedRef<SidebarTabItem[]>,
    activeId: sidebar.activeId,
    /** 立即加一个非 `aux` 槽位（快捷键与"打开评审"用）。 */
    addSidebarTab: (type: SidebarTabKind) => sidebar.add(type),
    /** 加/关的统一入口：`aux` 走实例注册表（起/销毁进程），其余四种只动槽位。 */
    addTab: aux.addTab,
    closeTab: aux.closeTab,
    reorder: sidebar.reorder,
    restartTerminal: sidebar.restartTerminal,
    parent: aux.parent as ComputedRef<AuxParentContext>,
    /** 名额满时的可执行提示（侧栏禁用态被点到、注册表拒绝时共用）。 */
    notifyLimit: aux.notifyLimit,
  }
}
