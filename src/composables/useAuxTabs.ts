import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { AUX_MAX_TABS } from "@/lib/auxRuntime"
import { auxParentContext, spawnAuxRuntime, type AuxParentContext } from "@/lib/auxSpawn"
import type { SidebarTabItem, SidebarTabKind } from "@/lib/sidebarTabs"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import type { useWorkspaceStore } from "@/stores/workspace"
import {
  auxCanOpen,
  auxCreationPending,
  auxInstancesFor,
  auxTabBySidebarId,
  closeAux,
  openAux,
  setAuxTabId,
} from "@/stores/auxChat"

/**
 * `ChatView` 的 aux 接线：侧栏 `aux` 槽位 ↔ `stores/auxChat.ts` 的实例注册表。
 *
 * 为什么单独成 composable：`ChatView` 已有 480 行，把"加 Tab / 关 Tab / 父上下文"
 * 塞进去会让那个文件继续膨胀（并且 split/board 三个挂载点共用同一份逻辑）。这里
 * 只做接线，实例状态全部在模块级注册表里（活过 `ChatView` 重挂载）。
 */
export function useAuxTabs(deps: {
  runtimeId: string
  session: SessionStore
  ui: UiStore
  workspace: ReturnType<typeof useWorkspaceStore>
  project: () => string
  /** 侧栏注册表的新增/关闭（`useSidebarTabs` 的 `add`/`close`）。 */
  addSidebarTab: (type: SidebarTabKind) => number | null
  closeSidebarTab: (id: number) => void
  /** 新实例就绪后把它切成激活 Tab。 */
  activate: (id: number) => void
  /** 当前槽位快照（构造时核对"存活实例是否还有入口"）。 */
  tabs: () => readonly SidebarTabItem[]
}) {
  const { t } = useI18n()

  /** 父会话的启动上下文（模型/工作区）；懒启动期间模型可能还取不到（面板会报原因）。 */
  const parent = computed<AuxParentContext>(() =>
    auxParentContext(deps.runtimeId, deps.session.cwd || deps.project(), deps.session, deps.workspace),
  )

  function notifyLimit() {
    deps.ui.pushToast(t("auxChat.limitReached", { count: AUX_MAX_TABS }), "warning")
  }

  /**
   * 添加一个 aux 槽位并启动它的进程。
   *
   * 顺序：先加侧栏槽位（拿到 `tabId`），再 `openAux` —— 后者**同步**入表再 `await`
   * spawn，创建中的实例计入上限 5。同一父会话已有在途创建时不叠加槽位（`openAux`
   * 会复用那次创建，先加槽位只会留下查不到实例的空壳）。
   */
  async function addAux() {
    if (auxCreationPending(deps.runtimeId)) return
    if (!auxCanOpen()) {
      notifyLimit()
      return
    }
    const tabId = deps.addSidebarTab("aux")
    if (tabId === null) return
    const tab = await openAux(deps.runtimeId, {
      tabId,
      titlePrefix: t("auxChat.title"),
      spawn: async created => {
        await spawnAuxRuntime(parent.value, created)
      },
    })
    if (!tab) {
      // 注册表拒绝（名额刚被别的会话占满）：撤销刚加的槽位，不留永远创建不出来的 Tab。
      deps.closeSidebarTab(tabId)
      notifyLimit()
      return
    }
    if (tab.status === "ready") deps.activate(tabId)
  }

  /** 关闭槽位：先销毁实例（墓碑 + rpc_kill + store 拆除），再撤槽位。 */
  async function closeAuxBySidebarId(tabId: number) {
    const aux = auxTabBySidebarId(tabId)
    if (aux) await closeAux(aux.runtimeId)
    deps.closeSidebarTab(tabId)
  }

  /**
   * 挂载时补齐槽位：aux 实例活在模块级注册表里，但它的**槽位**在侧栏注册表的会话组
   * 里。切走父会话时 `ChatView` 卸载并释放该组，组数紧张的 LRU 可能把它淘汰（槽位
   * 随之消失），而进程与 store 仍在（实例存活是规格要求）。这里按实例补回槽位，
   * 否则实例会变成没有入口的孤儿。
   */
  function restoreSlots(tabs: readonly SidebarTabItem[]) {
    const present = new Set(tabs.map(tab => tab.id))
    for (const instance of auxInstancesFor(deps.runtimeId)) {
      if (present.has(instance.tabId)) continue
      const slot = deps.addSidebarTab("aux")
      if (slot === null) continue
      setAuxTabId(instance.runtimeId, slot)
      present.add(slot)
    }
  }

  /** 侧栏"新增 Tab"的统一入口：`aux` 走注册表，其余四种照旧。 */
  async function addTab(type: SidebarTabKind) {
    if (type === "aux") await addAux()
    else deps.addSidebarTab(type)
  }

  /** 侧栏"关闭 Tab"的统一入口：`aux` 必须先销毁进程，不能只撤槽位。 */
  async function closeTab(id: number) {
    if (auxTabBySidebarId(id)) {
      await closeAuxBySidebarId(id)
      return
    }
    deps.closeSidebarTab(id)
  }

  // 构造即补齐：侧栏组被 LRU 淘汰只丢槽位（进程与 store 仍在），这里按存活实例补回。
  restoreSlots(deps.tabs())

  return { parent: parent as ComputedRef<AuxParentContext>, addTab, closeTab, addAux, notifyLimit }
}
