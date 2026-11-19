import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import type { AuxAskPayload, AuxAskTarget } from "@/lib/auxSelection"
import { askAuxSelection } from "@/lib/auxAsk"
import { MAX_SIDEBAR_TABS, type SidebarTabItem, type SidebarTabKind } from "@/lib/sidebarTabs"
import type { AuxParentContext } from "@/lib/auxSpawn"
import { useAuxTabs } from "@/composables/useAuxTabs"
import { useSidebarTabs } from "@/composables/useSidebarTabs"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { auxInstancesFor } from "@/stores/auxChat"

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
    workspace,
    project: deps.project,
    addSidebarTab: sidebar.add,
    closeSidebarTab: sidebar.close,
    activate: (id: number) => (sidebar.activeId.value = id),
    tabs: () => sidebar.tabs.value,
    // 划词入口的路由判据："有激活的 aux Tab"就是侧栏当前激活槽位。
    activeTabId: () => sidebar.activeId.value,
  })

  /**
   * 会话正文划词的"在辅助对话中提问"（TZD-103）。
   *
   * 视图只把事件转过来：多实例时携带用户选择的目标，路由与失败文案分别在注册表、
   * `lib/auxAsk.ts`；展开侧栏在这一层（视图不新增业务分支）。
   */
  async function askAux(payload: AuxAskPayload, target?: AuxAskTarget) {
    const outcome = await askAuxSelection({
      parentRuntimeId: deps.runtimeId,
      target,
      // 消息 id 属于发起手势的这个会话：aux 面板据此判断"能不能在本面板就近定位"。
      payload: { ...payload, sourceRuntimeId: deps.runtimeId },
      t,
      toast: (message, kind) => deps.ui.pushToast(message, kind),
    })
    // 复用与新建都要让面板可见，否则引用进了桶但用户看不到它。
    if (outcome.ok) deps.onFirstTabAdded()
    return outcome
  }

  const auxTargets = computed(() => auxInstancesFor(deps.runtimeId))

  return {
    askAux,
    auxTargets,
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
  }
}
