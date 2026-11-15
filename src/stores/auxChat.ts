import { getActivePinia } from "pinia"
import { reactive } from "vue"
import { AUX_MAX_TABS, createAuxRuntimeId, nextAuxOrdinal } from "@/lib/auxRuntime"
import type { AuxEventSink } from "@/lib/auxEventSink"
import { registerAuxEventSink } from "@/lib/auxEventSink"
import { clearAuxDraft } from "@/stores/auxDrafts"
import { dropAuxUiStore, registerAuxUiStore } from "@/stores/conversations"
import { createSessionStore, type SessionStore } from "@/stores/session"
import { createUiStore, type UiStore } from "@/stores/ui"

/**
 * aux（辅助对话）Tab 注册表 —— **模块级**，活过 `ChatView` 重挂载（对齐
 * `stores/sidebarTabs.ts` 的既有做法；`docs/aux-chat-spec.md` §5）。
 *
 * 职责边界：只记录"有哪些 aux 实例、属于哪个父会话、标题序号与状态"，以及关闭时的
 * 销毁顺序。进程的启动/取消由宿主提供（`lib/auxSpawn.ts` 里的 bridge）。
 *
 * 与侧栏注册表的关系：侧栏的 `aux` Tab 只是**槽位**（顺序/active/槽位 id），本注册表
 * 才是实例的权威来源。侧栏那份永不落盘（`persistedFromTabs` 的白名单丢弃 `aux`），
 * 关闭即销毁。
 *
 * 与 `stores/conversations.ts` 的关系：aux 的 session store **不进** `sessions` 表，
 * 因此 `allConversations()`（左侧会话列表、项目"运行中"、看板）看不见它。ui store
 * 只额外登记进 `uiFor` 的查找表，好让 `ExtensionDialog`/`StatusBar` 凭 `:session-id`
 * 拿到 **aux 的** ui（否则扩展询问会落到主会话、回答发错进程）。
 */

export type AuxTabStatus = "creating" | "ready" | "error"

export interface AuxTab {
  /** 侧栏 Tab 槽位 id（`stores/sidebarTabs.ts` 的 `SidebarTabItem.id`）。 */
  tabId: number
  /** aux 运行时 id，`aux:` 前缀；同时是 session/ui store 的键。 */
  runtimeId: string
  /** 父（主）会话 runtimeId。 */
  parentRuntimeId: string
  /**
   * 本机客户端标识（`docs/aux-chat-spec.md` §5）：④ 的重连恢复只恢复本机 clientId
   * 的条目、`aux_claim/aux_release` 的租约也按它归属。这里先生成并随实例存活，
   * 生命周期回收本身不在本事项范围内。
   */
  clientId: string
  /** 面板标题（同一父会话内按 `ordinal` 编号）。 */
  title: string
  ordinal: number
  status: AuxTabStatus
  /** `status === "error"` 时面板要显示的失败原因（coded error 原样保留）。 */
  error?: string
}

const tabs = reactive<AuxTab[]>([])

/**
 * 已关闭实例的墓碑。
 *
 * 关闭是异步的（`rpc_kill` 要等后端），而 `pi://exit` / 迟到事件可能随后才到。
 * 墓碑让它们被**丢弃**，而不是被当成活实例重新建 store —— 后者会留下一个无人管、
 * 永不回收的孤儿 store（§5 销毁段）。
 */
const closedAuxIds = new Set<string>()

/** 同一父会话的在途创建（同一手势去重，防双击开出两个进程）。 */
const pendingCreations = new Map<string, Promise<AuxTab | null>>()

/** aux 自己的 session / ui store 表（不进 conversations 的 `sessions`）。 */
const auxSessions = new Map<string, SessionStore>()
const auxUis = new Map<string, UiStore>()

/** 宿主注入的运行时能力（`lib/auxSpawn.ts` 装配；测试可替换）。 */
export interface AuxRuntimeBridge {
  /** 取消进程（关闭顺序里的 `rpc_kill`）。 */
  kill: (runtimeId: string) => Promise<void>
}

let bridge: AuxRuntimeBridge | null = null

export function registerAuxRuntimeBridge(next: AuxRuntimeBridge | null) {
  bridge = next
}

/**
 * 事件入口（`lib/workspaceRuntime.ts` 通过 `lib/auxEventSink` 调到）。
 *
 * 关键约束：**绝不** `sessionFor` 重建 store —— 墓碑命中直接丢弃，store 不存在
 * 也直接丢弃（那是关闭后的迟到事件，或一个不属于本进程的旧 id）。
 */
export const auxChatEventSink: AuxEventSink = {
  isClosed: runtimeId => closedAuxIds.has(runtimeId),
  hasSession: runtimeId => auxSessions.has(runtimeId),
  handleEvent: (runtimeId, event) => auxSessions.get(runtimeId)?.handleEvent(event),
  resolveRequest: (runtimeId, id) => auxUis.get(runtimeId)?.resolveRequest(id),
  handleRequest: (runtimeId, request) => auxUis.get(runtimeId)?.handleRequest(request as never),
  restoreRequests: (runtimeId, requests) => auxUis.get(runtimeId)?.restoreRequests(requests as never),
  pushStderr: (runtimeId, line) => auxUis.get(runtimeId)?.pushStderr(line),
  onExit: (runtimeId, activity) => {
    const session = auxSessions.get(runtimeId)
    if (!session) return
    if (!activity || activity.status === "error") session.markInterrupted()
    session.started = false
    session.isStreaming = false
    session.isCompacting = false
    session.partialBlocks = null
    auxUis.get(runtimeId)?.restoreRequests([])
  },
}

registerAuxEventSink(auxChatEventSink)

/**
 * 本机客户端标识：同一页面会话内稳定（④ 的租约与重连恢复按它筛选）。
 * 不落盘、不带出进程 —— 它只用于区分"哪个客户端开的 aux"。
 */
let cachedClientId: string | null = null
function auxClientId() {
  cachedClientId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return cachedClientId
}

/** 当前客户端的标识（诊断与④使用）。 */
export function currentAuxClientId() {
  return auxClientId()
}

/** 仅测试用：清空注册表、墓碑、在途创建与 store 表（用例之间隔离）。 */
export function resetAuxChatForTest() {
  tabs.splice(0)
  closedAuxIds.clear()
  pendingCreations.clear()
  auxSessions.clear()
  auxUis.clear()
  bridge = null
}

/** 只读快照（响应式数组本身）。 */
export function auxTabs(): AuxTab[] {
  return tabs
}

/** 按 runtimeId 查实例；墓碑命中一律返回 `undefined`（迟到事件不得复活）。 */
export function auxTabByRuntime(runtimeId: string): AuxTab | undefined {
  if (closedAuxIds.has(runtimeId)) return undefined
  return tabs.find(tab => tab.runtimeId === runtimeId)
}

/** 按侧栏槽位 id 查实例（`RightSidebar` 渲染面板用）。 */
export function auxTabBySidebarId(tabId: number): AuxTab | undefined {
  return tabs.find(tab => tab.tabId === tabId)
}

/** 墓碑是否命中（迟到 `pi://exit` / 事件的丢弃判据）。 */
export function isClosedAux(runtimeId: string): boolean {
  return closedAuxIds.has(runtimeId)
}

/** 存活中的实例数（**创建中的实例同样计入**，所以直接用数组长度）。 */
export function auxLiveCount() {
  return tabs.length
}

/** 是否还有名额（上限 5；与侧栏 20/24 无关）。 */
export function auxCanOpen() {
  return tabs.length < AUX_MAX_TABS
}

/** 某个父会话的全部实例（挂载时补槽位、④ 的回收都用它）。 */
export function auxInstancesFor(parentRuntimeId: string): AuxTab[] {
  return tabs.filter(tab => tab.parentRuntimeId === parentRuntimeId)
}

/** 把实例的槽位 id 改成新的（侧栏组被淘汰后补槽位时用）。 */
export function setAuxTabId(runtimeId: string, tabId: number) {
  const tab = auxTabByRuntime(runtimeId)
  if (tab) tab.tabId = tabId
}

/** 某个父会话最后一个实例（切回父会话时恢复它的面板）。 */
export function activeAuxFor(parentRuntimeId: string): AuxTab | undefined {
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i]
    if (tab?.parentRuntimeId === parentRuntimeId) return tab
  }
  return undefined
}

/** aux 的 session store（缺席时创建）。 */
export function auxSessionFor(runtimeId: string): SessionStore {
  let store = auxSessions.get(runtimeId)
  if (!store) {
    store = createSessionStore(runtimeId)()
    auxSessions.set(runtimeId, store)
  }
  return store
}

/** aux 的 ui store；同时登记进 `uiFor` 查找表，供 `ExtensionDialog`/`StatusBar` 解析。 */
export function auxUiFor(runtimeId: string): UiStore {
  let store = auxUis.get(runtimeId)
  if (!store) {
    // aux 的通知一律静默（§5：`notifyQuestion`/`notifyTurnComplete`/`setTitle` 不生效）。
    store = createUiStore(runtimeId, undefined, { silent: true })()
    auxUis.set(runtimeId, store)
    registerAuxUiStore(runtimeId, store)
  }
  return store
}

/** 侧栏 Tab 标题：实例标题（`RightSidebar.titleFor` 使用）。 */
export function auxTitleForSidebarId(tabId: number): string | null {
  return auxTabBySidebarId(tabId)?.title ?? null
}

/** 该 aux 槽位是否有未答的扩展询问（Tab 标题出标记用）。 */
export function auxHasPendingQuestion(tabId: number): boolean {
  const tab = auxTabBySidebarId(tabId)
  if (!tab) return false
  return (auxUis.get(tab.runtimeId)?.dialogs.length ?? 0) > 0
}

/**
 * 打开一个 aux 实例。
 *
 * 顺序固定：**同步**入表（`status: "creating"`）再 `await` spawn —— 创建中的实例
 * 计入上限，否则连点几次就能开出超过 5 个进程。同一父会话的并发手势复用同一次
 * 创建结果。
 *
 * 返回 `null` 表示没有名额（调用方应提示并回滚刚加的侧栏槽位）。
 */
export async function openAux(
  parentRuntimeId: string,
  options: { tabId: number; titlePrefix: string; spawn: (tab: AuxTab) => Promise<void> },
): Promise<AuxTab | null> {
  const pending = pendingCreations.get(parentRuntimeId)
  if (pending) return pending
  if (!auxCanOpen()) return null

  const runtimeId = createAuxRuntimeId()
  const ordinal = nextAuxOrdinal(tabs.filter(tab => tab.parentRuntimeId === parentRuntimeId).map(tab => tab.ordinal))
  const tab: AuxTab = {
    tabId: options.tabId,
    runtimeId,
    parentRuntimeId,
    clientId: auxClientId(),
    title: `${options.titlePrefix} ${ordinal}`,
    ordinal,
    status: "creating",
  }
  // 先入表：上限计数与事件分发都要立刻看到它（事件可能在 spawn 握手期间到达）。
  tabs.push(tab)
  // 先建 store：spawn 期间的 `pi://event` / `extension_ui_request` 要有落点。
  auxSessionFor(runtimeId)
  auxUiFor(runtimeId)

  const creation = (async () => {
    try {
      await options.spawn(tab)
      const current = auxTabByRuntime(runtimeId)
      if (!current) {
        // 创建期间被关闭：spawn 成功也不复活，直接收掉进程。
        await bridge?.kill(runtimeId).catch(() => {})
        return null
      }
      current.status = "ready"
      delete current.error
      return current
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const current = auxTabByRuntime(runtimeId)
      if (current) {
        // 失败留在表里并带原因：面板要显示为什么失败，由用户决定关掉它。
        current.status = "error"
        current.error = message
      }
      return current ?? null
    } finally {
      pendingCreations.delete(parentRuntimeId)
    }
  })()

  pendingCreations.set(parentRuntimeId, creation)
  return creation
}

/**
 * 该父会话是否有在途创建。
 *
 * 调用方（`ChatView.addAuxTab`）必须先查它再决定要不要加侧栏槽位：`openAux` 会为
 * 同一父会话复用同一次创建（双击去重），若先加了第二个槽位就会留下一个查不到实例
 * 的空壳 Tab。
 */
export function auxCreationPending(parentRuntimeId: string) {
  return pendingCreations.has(parentRuntimeId)
}

/** 失败态重试前清掉错误（不复用旧进程，重试仍走 spawn）。 */
export function markAuxRetrying(runtimeId: string) {
  const tab = auxTabByRuntime(runtimeId)
  if (!tab) return
  tab.status = "creating"
  delete tab.error
}

/**
 * 关闭一个实例 —— **销毁顺序固定**（§5 销毁段）：
 *
 * 墓碑 → 取消计时器（`session.clear()`/`ui.clear()` 内部各自清掉）→ `session.clear()` →
 * `ui.clear()` + 补 `toasts`/`toastTimers`/`pendingEditorText`/`responding` →
 * `auxDrafts.clear` → `rpc_kill` → 移除 store + `pinia._s.delete` + `$dispose()`。
 *
 * 墓碑必须**最先**写：`rpc_kill` 之后的后端 `pi://exit` 可能立刻到达（远程传输在同
 * 一 tick 内派发），那时若还没有墓碑就会被当成活实例重建。
 */
export async function closeAux(runtimeId: string): Promise<void> {
  if (closedAuxIds.has(runtimeId)) return
  closedAuxIds.add(runtimeId)
  const index = tabs.findIndex(tab => tab.runtimeId === runtimeId)
  if (index >= 0) tabs.splice(index, 1)

  const session = auxSessions.get(runtimeId)
  const ui = auxUis.get(runtimeId)
  // 0) 未答的扩展询问：**没有 timeout 的**要在关掉进程前先发 `cancelled`
  //    （§5 对话框段）。有 timeout 的由后端 `activity` 过期，不必抢答。
  if (ui) await cancelPendingDialogs(ui)
  // 1) session store：清对话状态（aux 没有 session 文件，不存在保留历史的场景）。
  session?.clear()
  // 2) ui store：对话框/widget/状态栏/stderr + toasts/计时器/待插文本/在途询问。
  ui?.clear()
  // 3) 草稿（仅内存）。
  clearAuxDraft(runtimeId)
  // 4) 进程：先杀，再拆 store —— 顺序反过来会让迟到事件找到仍有 store 的 id。
  await bridge?.kill(runtimeId).catch(() => {})
  // 5) 会话表与 Pinia 实例表。
  dropAuxUiStore(runtimeId)
  auxSessions.delete(runtimeId)
  auxUis.delete(runtimeId)
  const pinia = getActivePinia() as unknown as { _s?: Map<string, unknown> } | null
  pinia?._s?.delete(`session:${runtimeId}`)
  pinia?._s?.delete(`ui:${runtimeId}`)
  session?.$dispose?.()
  ui?.$dispose?.()
}

/**
 * 关闭前把"不会有 timeout 自然过期"的询问回答成 `cancelled`。
 *
 * 顺序在 `session.clear()`/`ui.clear()` 之前：`ui.respond` 依赖 ui store 还在，
 * 而它发的 `extension_ui_response` 必须赶在 `rpc_kill` 之前（关掉进程就没人读了）。
 */
async function cancelPendingDialogs(ui: UiStore) {
  for (const dialog of [...ui.dialogs]) {
    if (dialog.timeout !== undefined) continue
    await ui.respond(dialog, { cancelled: true }).catch(() => {})
  }
}

/** 关闭某父会话的全部实例（父会话关闭/被淘汰时用）。 */
export async function closeAllFor(parentRuntimeId: string): Promise<void> {
  const ids = tabs.filter(tab => tab.parentRuntimeId === parentRuntimeId).map(tab => tab.runtimeId)
  for (const id of ids) await closeAux(id)
}
