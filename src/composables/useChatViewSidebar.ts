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
import { auxDeliverableFor } from "@/stores/auxChat"

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
  /**
   * 组"获准且完成载入"后补存活 aux 槽位的回调。
   *
   * 晚绑定：`useSidebarTabs` 构造期就可能直接准入（那时 `aux` 还没建，且它自己的
   * 构造函数会先补一次），但**延迟准入**（组满排队 → 名额空出）发生在挂载之后，
   * 必须回到 `aux` 那里幂等补一次，否则存活实例没有入口也关不掉（TZD-131）。
   */
  let onGroupAdopted: () => void = () => {}
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
    onGroupAdopted: () => onGroupAdopted(),
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
  // 组晚到的准入（组满排队 → 名额空出）：普通 Tab 由 `useSidebarTabs` 补，存活 aux
  // 槽位由这里幂等补回；缺槽不撤实例（下次挂载还会再补），也不按裸 id 关闭。
  onGroupAdopted = aux.restoreSlotsNow

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

  // 划词菜单只列**可打开**的实例：没有侧栏槽位的等位实例（`tabId === null`）不能被选中，
  // 否则引用会写进一个用户打不开的待发送桶（TZD-131）。
  const auxTargets = computed(() => auxDeliverableFor(deps.runtimeId))

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
