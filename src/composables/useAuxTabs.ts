import { computed, onScopeDispose, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { auxParentContext, spawnAuxRuntime, type AuxParentContext } from "@/lib/auxSpawn"
import type { SidebarTabItem, SidebarTabKind } from "@/lib/sidebarTabs"
import type { SessionStore } from "@/stores/session"
import type { useWorkspaceStore } from "@/stores/workspace"
import {
  auxCreationPending,
  auxInstancesFor,
  auxPendingCreation,
  closeAux,
  openAux,
  registerAuxAskRouter,
  setAuxTabId,
  type AuxTab,
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
  workspace: ReturnType<typeof useWorkspaceStore>
  project: () => string
  /** 侧栏注册表的新增/关闭（`useSidebarTabs` 的 `add`/`close`）。 */
  addSidebarTab: (type: SidebarTabKind) => number | null
  closeSidebarTab: (id: number) => void
  /** 新实例就绪后把它切成激活 Tab。 */
  activate: (id: number) => void
  /** 当前槽位快照（构造时核对"存活实例是否还有入口"）。 */
  tabs: () => readonly SidebarTabItem[]
  /** 当前激活槽位 id（划词路由的"有激活的 aux Tab"判据）。 */
  activeTabId: () => number | null
}) {
  const { t } = useI18n()

  /** 父会话的启动上下文（模型/工作区）；懒启动期间模型可能还取不到（面板会报原因）。 */
  const parent = computed<AuxParentContext>(() =>
    auxParentContext(deps.runtimeId, deps.session.cwd || deps.project(), deps.session, deps.workspace),
  )

  /**
   * 添加一个 aux 槽位并启动它的进程。
   *
   * 顺序：先加侧栏槽位（拿到 `tabId`），再 `openAux` —— 后者**同步**入表再 `await`
   * spawn。同一父会话已有在途创建时不叠加槽位（`openAux` 会复用那次创建，先加槽位
   * 只会留下查不到实例的空壳）。实例数量不设辅助对话专属上限。
   */
  async function addAux() {
    if (auxCreationPending(deps.runtimeId)) return
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
      // 创建期间实例已被关闭：只撤那一格仍无主、仍为 `aux` 的临时槽位 —— 既不留查不到
      // 实例的空壳 Tab，也不按旧 id 误删在途换键后顶替它的普通 Tab（TZD-131）。
      dropUnclaimedAuxSlot(tabId)
      return
    }
    if (tab.status === "ready") revealReady(tab)
  }

  /**
   * 数字槽位 id 只在一组侧栏 Tab 内部唯一，**跨类型、跨父会话都不唯一**（TZD-131）：
   * 组被 LRU 淘汰后重挂载时，落盘的普通 Tab 会重新拿到 1..n 的 id，而 aux 实例仍记着
   * 自己的旧 id —— 只比数字会把它错认成自己的槽位；同理，A、B 两个父会话的首个 aux
   * 也都是 `id=1`，按裸 id 查全局表会把 `closeTab` 落到别的会话的实例上。
   * 因此本文件一律按「**本父会话 + 本组槽位**」解析，并确认槽位类型，不查裸 id 全局表
   * （面板显示的联合查找在 `stores/auxChat.ts`，只服务渲染，这里不复用）。
   */
  function slotAt(tabs: readonly SidebarTabItem[], id: number): SidebarTabItem | undefined {
    return tabs.find(tab => tab.id === id)
  }

  /** 本父会话在本组该槽位上的 aux 实例（跨父会话的同号实例不属于本组）。 */
  function auxInstanceAtSlot(id: number): AuxTab | undefined {
    return auxInstancesFor(deps.runtimeId).find(tab => tab.tabId === id)
  }

  /** 关闭槽位：先同步撤槽位，再销毁**已解析**的实例；页面清理与 rpc_kill 不应拖住 Tab 关闭。 */
  async function closeAuxBySidebarId(tabId: number, aux: AuxTab | undefined) {
    deps.closeSidebarTab(tabId)
    if (aux) await closeAux(aux.runtimeId)
  }

  /**
   * 把已就绪的实例切成激活（`reveal` 只做激活，不新开）。
   *
   * 用实例的**当前** `tabId`，不是创建时捕获的旧槽位 id（TZD-131）：创建在途时换键
   * （`runtime:` → 文件键）会重排槽位，旧 id 可能已属于普通 Tab 或已不存在；按旧 id
   * 激活会把焦点切到文件 Tab / 切到不存在的槽位。先验证该槽位仍属于本组、类型为
   * `aux`，且当前确实由这个实例占据。
   */
  function revealReady(tab: AuxTab) {
    const slot = slotAt(deps.tabs(), tab.tabId)
    if (slot?.type !== "aux") return
    if (auxInstanceAtSlot(tab.tabId)?.runtimeId !== tab.runtimeId) return
    deps.activate(tab.tabId)
  }

  /**
   * 撤掉刚加但没能落地的 `aux` 槽位。
   *
   * 同样不看创建时的旧 id（TZD-131）：在途换键后那一格可能已经变成普通 Tab（甚至带着
   * 悬盘布局），按旧 id 撤会误删它；已有实例占用的格也不能撤。只在"仍是 `aux` 类型且
   * 无实例认领"时才撤。
   */
  function dropUnclaimedAuxSlot(tabId: number) {
    const slot = slotAt(deps.tabs(), tabId)
    if (slot?.type !== "aux") return
    if (auxInstanceAtSlot(tabId)) return
    deps.closeSidebarTab(tabId)
  }

  /**
   * 挂载时补齐槽位：aux 实例活在模块级注册表里，但它的**槽位**在侧栏注册表的会话组
   * 里。切走父会话时 `ChatView` 卸载并释放该组，组数紧张的 LRU 可能把它淘汰（槽位
   * 随之消失），而进程与 store 仍在（实例存活是规格要求）。这里按实例补回槽位，
   * 否则实例会变成没有入口的孤儿。
   *
   * `aux` 槽位永不落盘，所以重挂载后它一定不在列表里；而普通 Tab 会带着**重新分配**
   * 的数字 id 回来，可能与实例记着的旧 id 撞号（aux=1、普通 Tab=2 → 重挂载后普通
   * Tab 拿 1）。因此判据是"该 id 上确实是一个 `aux` 槽位，且没被同父会话的另一个实例
   * 认领"，不是"这个数字出现过"。
   */
  function restoreSlots(tabs: readonly SidebarTabItem[]) {
    const auxSlots = tabs.filter(tab => tab.type === "aux").map(tab => tab.id)
    const claimed = new Set<number>()
    const pending: AuxTab[] = []
    for (const instance of auxInstancesFor(deps.runtimeId)) {
      // 两个实例的旧 id 可能同时撞到同一个新槽位（都在组被淘汰前分配）：先到先得，
      // 后来者必须另开一格，否则两格会渲染同一个实例、另一个实例反而没有入口。
      if (auxSlots.includes(instance.tabId) && !claimed.has(instance.tabId)) {
        claimed.add(instance.tabId)
        continue
      }
      pending.push(instance)
    }
    // 没被认领的 aux 槽位（旧 id 已被普通 Tab 顶掉、或换键回滚后本组留着上一身份键的
    // 入口）优先复用：它们本就属于本会话的这些实例。不复用就会多出一格空槽位 ——
    // 原 aux 变成两格，且其中一格没有面板。
    const spare = auxSlots.filter(id => !claimed.has(id))
    for (const instance of pending) {
      const slot = spare.length ? spare.shift()! : deps.addSidebarTab("aux")
      if (slot === null) continue
      setAuxTabId(instance.runtimeId, slot)
      claimed.add(slot)
    }
  }

  /** 侧栏"新增 Tab"的统一入口：`aux` 走注册表，其余四种照旧。 */
  async function addTab(type: SidebarTabKind) {
    if (type === "aux") await addAux()
    else deps.addSidebarTab(type)
  }

  /**
   * 侧栏"关闭 Tab"的统一入口：`aux` 必须先销毁进程，不能只撤槽位。
   *
   * 判据是**本组该 id 上的槽位类型**，不是"这个数字上有没有 aux 实例"（TZD-131）：
   * - 该 id 上没有本组槽位（重复关闭、槽位已随 LRU 淘汰消失）或坐的是普通 Tab
   *   （重挂载后文件 Tab 复用了实例的旧 id）→ 只撤槽位、**不发 kill**。不查裸 id 全局
   *   表：A 组无槽位时 `closeTab(1)` 不得落到 B 组同号的存活实例上。
   * - 坐的是 `aux` 槽位 → 先同步撤槽位（TZD-130：清理与 rpc_kill 不拖住 Tab 关闭），
   *   再按**已解析**实例的 `runtimeId` 关进程。
   */
  async function closeTab(id: number) {
    const slot = slotAt(deps.tabs(), id)
    if (slot?.type !== "aux") {
      deps.closeSidebarTab(id)
      return
    }
    await closeAuxBySidebarId(id, auxInstanceAtSlot(id))
  }

  // 构造即补齐：侧栏组被 LRU 淘汰只丢槽位（进程与 store 仍在），这里按存活实例补回。
  restoreSlots(deps.tabs())

  /**
   * 侧栏组**获准且完成载入后**再幂等补齐一次（TZD-131 收尾）。
   *
   * 构造期补不上不该是终态：组数满时 `addSidebarTab` 返回 `null`，组可能稍后才被
   * 延迟准入（`useSidebarTabs` 的排队回调），那时普通 Tab 已恢复、aux 却仍无槽位 ——
   * 实例活着但没入口也关不掉。本函数可重复调用：已有 aux 槽位的实例会被 `restoreSlots`
   * 的"类型 + 未认领"判据跳过，不会多补。
   */
  function restoreSlotsNow() {
    restoreSlots(deps.tabs())
  }

  /**
   * 划词入口（会话正文 / 代码预览）的路由能力（TZD-103）。
   *
   * `active` 只看**侧栏 active 槽位**：分屏时两个 `ChatView` 各有自己的注册表路由，
   * 用"最近一个实例"会让隐藏窗格抢到落到本窗格的划词手势。
   */
  function activeAuxTab() {
    const id = deps.activeTabId()
    if (id === null) return null
    // 同 `closeTab`：激活的槽位必须**属于本组且类型为 aux**，否则不路由。
    // 这里要求槽位确实在：active 指向的槽位不存在就无 aux 可用。
    if (slotAt(deps.tabs(), id)?.type !== "aux") return null
    return auxInstanceAtSlot(id) ?? null
  }

  /** 复用/新建之后把该实例的槽位切成激活（`reveal` 只做激活，不新开）。 */
  function reveal(tab: AuxTab) {
    revealReady(tab)
  }

  /**
   * 划词入口的新建：与 `addAux` 同一条创建规则（同一父会话的在途创建复用，
   * 不叠加槽位），差别是**返回实例**而不是 `void`。
   */
  async function openForAsk() {
    const pending = auxPendingCreation(deps.runtimeId)
    if (pending) return (await pending) ?? null
    const tabId = deps.addSidebarTab("aux")
    if (tabId === null) return null
    const tab = await openAux(deps.runtimeId, {
      tabId,
      titlePrefix: t("auxChat.title"),
      spawn: async created => {
        await spawnAuxRuntime(parent.value, created)
      },
    })
    if (!tab) {
      dropUnclaimedAuxSlot(tabId)
      return null
    }
    if (tab.status === "ready") revealReady(tab)
    return tab
  }

  registerAuxAskRouter(deps.runtimeId, { active: activeAuxTab, open: openForAsk, reveal })
  onScopeDispose(() => registerAuxAskRouter(deps.runtimeId, null))

  return {
    parent: parent as ComputedRef<AuxParentContext>,
    addTab,
    closeTab,
    addAux,
    restoreSlotsNow,
  }
}
