import { getActivePinia } from "pinia"
import { reactive } from "vue"
import { createAuxRuntimeId, nextAuxOrdinal } from "@/lib/auxRuntime"
import type { AuxEventSink } from "@/lib/auxEventSink"
import { registerAuxEventSink } from "@/lib/auxEventSink"
import type { AuxAskPayload, AuxAskTarget } from "@/lib/auxSelection"
import type { ConversationSelectionLimitReason } from "@/lib/conversationSelections"
import {
  AUX_LEASE_HEARTBEAT_MS,
  AUX_LEASE_TTL_MS,
  isAuxLeaseConflict,
  isAuxLeaseReaping,
  ownAuxLeases,
  parseAuxLeaseEntries,
  shouldHeartbeat,
} from "@/lib/auxLease"
import { clearAuxDraft } from "@/stores/auxDrafts"
import { addAuxSelection, clearAuxSelectionBucket } from "@/stores/auxSelections"
import { clearAuxParentContext, resetAuxParentContextForTest } from "@/stores/auxContext"
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
  /**
   * 侧栏 Tab 槽位 id（`stores/sidebarTabs.ts` 的 `SidebarTabItem.id`）。
   *
   * `null` = **本组没有入口**：槽位随 LRU 淘汰消失、或补槽位时本组已满 20 格（TZD-131）。
   * 这种实例仍活着（进程与 store 都在，缺槽不 kill），但不参与按槽位的显示/关闭查找 ——
   * 否则它会用旧号继续被命中，与后来分到同一个号的实例撞在一起。
   */
  tabId: number | null
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
  /**
   * 登记/续期租约（`aux_claim`），返回**服务端签发的 lease token**。
   *
   * clientId 只是标识（`aux_list` 会公开它），不能当凭证：`release` 必须出示这个
   * token，因此"抄别人的 clientId 去释放"必然失败（复审 P1-2）。
   */
  claim?: (runtimeId: string, clientId: string, leaseToken?: string) => Promise<string>
  /** 释放租约（`aux_release`）：只认 token。 */
  release?: (runtimeId: string, leaseToken: string) => Promise<void>
  /** 列出租约（`aux_list`；重连归属过滤用）。 */
  list?: () => Promise<unknown>
}

let bridge: AuxRuntimeBridge | null = null

export function registerAuxRuntimeBridge(next: AuxRuntimeBridge | null) {
  bridge = next
}

/**
 * 每个实例的 lease token（服务端在 `aux_claim` 时签发，只在本页面内存里）。
 *
 * 为什么不落盘：它是**凭证**，页面重载后旧 token 就没意义了（重载会拿到新的
 * clientId，旧租约交给 TTL 过期兜底，见 `docs/aux-chat-spec.md` §11）。
 */
const leaseTokens = new Map<string, string>()

/** 本实例当前持有的 lease token（诊断与测试用）。 */
export function auxLeaseToken(runtimeId: string): string | undefined {
  return leaseTokens.get(runtimeId)
}

/**
 * 续租被拒后的静默窗口：到期前**不再发 claim**（两种原因各自处理，见下）。
 *
 * 1. **`auxLeaseConflict`（页面重载丢了 token）**：`aux_claim` 对已有条目要求出示原
 *    token。不重试、不停用 Tab（实例与进程都还活着）—— 等旧条目 TTL（90s）过期后自动
 *    恢复。**注意**：这期间**不保证**"不会被回收"。回收门槛看的是**用户活动**，原 Tab
 *    在重载前可能已经累计闲置接近/超过 30 分钟；那种情况下心跳停掉、`claims` 归零后
 *    回收器要是先于心跳跑一轮，该实例就会被正常回收（规格 §5 的预期结果，见 §11
 *    已知边界）。
 * 2. **`auxLeaseReaping`（该实例已被回收器接管）**：墓碑是**永久**的，再打永远是同一个
 *    错误 —— 同样进退避窗口，避免每 20s 刷一次无效请求（每分钟 3 次）。
 */
const leaseQuietUntil = new Map<string, number>()

/**
 * 已被回收器接管的实例（永久墓碑 ⇒ 永不再续租）。
 *
 * 与 `leaseQuietUntil` 分开：`Conflict` 是**暂时**的（TTL 后会恢复），`Reaping` 是
 * **永久**的 —— 那个 runtimeId 已经进了回收墓碑，再 claim 只会一直报同一个错。
 */
const leaseReaping = new Set<string>()

/** 续租一次（心跳与"实例就绪"共用）。返回新/当前 token；被拒或静默窗口内返回 undefined。 */
async function claimAuxLease(runtimeId: string) {
  if (!bridge?.claim) return undefined
  if (leaseReaping.has(runtimeId)) return undefined
  const quietUntil = leaseQuietUntil.get(runtimeId)
  if (quietUntil !== undefined && Date.now() < quietUntil) return undefined
  const token = leaseTokens.get(runtimeId)
  try {
    // 首次不带 token（服务端签发）；续租必须带原 token，否则 `auxLeaseConflict`。
    const issued = await bridge.claim(runtimeId, auxClientId(), token)
    if (issued) {
      leaseTokens.set(runtimeId, issued)
      leaseQuietUntil.delete(runtimeId)
    }
    return issued
  } catch (error) {
    if (isAuxLeaseReaping(error)) {
      // 永久墓碑：这个实例不会再接受任何租约，直接停掉续租（不再重试）。
      leaseReaping.add(runtimeId)
    } else if (isAuxLeaseConflict(error)) {
      // 暂时性：等旧条目 TTL 过期后自动恢复（不发、不停用 Tab、不循环重试）。
      leaseQuietUntil.set(runtimeId, Date.now() + AUX_LEASE_TTL_MS)
    }
    return undefined
  }
}

/**
 * 释放本机对该实例的租约（关闭路径）。
 *
 * 只认 token：没有 token（例如页面重载后旧租约还在 TTL 内）就**不动**它 ——
 * 后端会在 TTL（90s）之后惰性清理，不会永久挡住回收。
 */
async function releaseAuxLease(runtimeId: string) {
  const token = leaseTokens.get(runtimeId)
  if (!token) return
  await bridge?.release?.(runtimeId, token).catch(() => undefined)
  leaseTokens.delete(runtimeId)
  leaseQuietUntil.delete(runtimeId)
}

/**
 * 模块级心跳定时器（**不在 pane 上**）：切父会话时 Pane 会卸载，但实例与进程还活着，
 * 心跳必须继续 —— 否则回收器会在 30 分钟后把一个"用户随时会切回去"的 Tab 当成孤儿。
 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

/** 心跳是否在跑（诊断与测试用）。 */
export function auxHeartbeatRunning() {
  return heartbeatTimer !== null
}

/**
 * 对所有 `aux:` 实例续租一次。没有 aux 条目时**自动停表**：
 * 无实例还每秒空转的定时器会一直吊着事件循环（单测/退出时都难受）。
 */
export async function tickAuxLeases(): Promise<void> {
  const runtimeIds = tabs.map(tab => tab.runtimeId)
  if (!shouldHeartbeat(runtimeIds)) {
    stopAuxLeaseHeartbeat()
    return
  }
  for (const runtimeId of runtimeIds) await claimAuxLease(runtimeId)
}

/** 启动心跳（幂等；间隔默认 20s，见 `AUX_LEASE_HEARTBEAT_MS`）。 */
export function startAuxLeaseHeartbeat(intervalMs = AUX_LEASE_HEARTBEAT_MS): void {
  if (heartbeatTimer !== null) return
  heartbeatTimer = setInterval(() => {
    void tickAuxLeases()
  }, intervalMs)
  // Node 单测：别让一个定时器把进程吊住（浏览器里没有 unref）。
  ;(heartbeatTimer as unknown as { unref?: () => void }).unref?.()
}

/** 停心跳（关闭最后一个实例、测试重置、应用退出）。 */
export function stopAuxLeaseHeartbeat(): void {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

/**
 * 重连后按 `aux_list` 重新对齐租约（规格 §5 第 4 条）。
 *
 * 只认两类条目：**本机 clientId** 且 **parentRuntimeId 在本地注册表里**。其余条目
 * （别的窗口/别的机器开的、父会话已不在本地）一律**不动** —— 不 kill、不改状态，
 * 交给回收器按三条件兜底。这就是"重连不把全部 aux 当孤儿"的落点。
 *
 * 本机条目里，实例已在本地表上的继续由心跳续租；实例已不在表（已关闭或本页从未拥有）
 * 则**释放残租约**，让回收器可以回收那个进程。
 */
export async function reconcileAuxLeases(): Promise<string[]> {
  const raw = await bridge?.list?.().catch(() => null)
  const entries = parseAuxLeaseEntries(raw)
  const knownParents = new Set(tabs.map(tab => tab.parentRuntimeId))
  const own = ownAuxLeases(entries, auxClientId(), parent => knownParents.has(parent))
  for (const entry of own) {
    if (auxTabByRuntime(entry.runtimeId)) continue
    // 本机条目但实例已不在表：能出示 token 就立即释放；拿不到 token（页面重载后
    // 旧租约）就交给 TTL 惰性过期 —— 它不会永久挡住回收。
    await releaseAuxLease(entry.runtimeId)
  }
  // 心跳恢复：重连期间实例的租约可能已过期（对方判定 `claims` 为空就会回收）。
  if (tabs.length > 0) {
    startAuxLeaseHeartbeat()
    await tickAuxLeases()
  }
  // 返回"本机应当在重连里恢复的 runtimeId"：调用方（`workspaceRuntime`）只对这批
  // 条目做 pending UI 恢复，其余 aux runtime 一律不动（等回收器）。
  return own.map(entry => entry.runtimeId)
}

/**
 * 划词入口（会话正文 / 代码预览）的 aux 路由能力，由 `useAuxTabs` 注入。
 *
 * 为什么放在这里而不是让两个入口各自拼：`askInAux` 必须先判断"这个父会话有没有
 * 激活中的 aux"再决定复用还是新建；新建要动侧栏槽位与 spawn，那是 `useAuxTabs`
 * 的职责，注册表只知道实例。路由放在注册表里，两个入口就只剩 emit。
 */
export interface AuxAskRouter {
  /** 该父会话当前**激活**的 aux（侧栏 active 槽位指向它）；没有则 `null`。 */
  active: (parentRuntimeId: string) => AuxTab | null
  /**
   * 该实例此刻**在本组侧栏里有没有入口**（槽位存在、类型为 `aux`、且由它占据）。
   *
   * 只有接线层（`useAuxTabs`）能回答这个问题：实例表里的 `tabId` 是"上一次分配到的号"，
   * 组被淘汰/排队/换键后可能与当前组完全脱节（TZD-131）。所有"能不能投递"的判据都走它。
   */
  entry?: (tab: AuxTab) => boolean
  /** 新建一个 aux（加槽位 + spawn）；槽位不可用或创建期间关闭时返回 `null`。 */
  open: (parentRuntimeId: string) => Promise<AuxTab | null>
  /** 把该实例的槽位切成激活并展开侧栏（复用与新建后都要做）。 */
  reveal: (tab: AuxTab) => void
}

/**
 * 按**父会话**登记路由：分屏时同一页面里有多个 `ChatView`，各父会话的路由互不
 * 覆盖（用单个全局变量会让先挂载的那个永远收不到自己的划词手势）。
 */
const askRouters = new Map<string, AuxAskRouter>()

export function registerAuxAskRouter(parentRuntimeId: string, next: AuxAskRouter | null) {
  if (next) askRouters.set(parentRuntimeId, next)
  else askRouters.delete(parentRuntimeId)
}

export function auxAskRouter(parentRuntimeId: string): AuxAskRouter | null {
  return askRouters.get(parentRuntimeId) ?? null
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

registerAuxEventSink({ ...auxChatEventSink, reconcileLeases: () => reconcileAuxLeases() })

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
  stopAuxLeaseHeartbeat()
  leaseTokens.clear()
  leaseQuietUntil.clear()
  leaseReaping.clear()
  tabs.splice(0)
  closedAuxIds.clear()
  sweptStores.clear()
  pendingCreations.clear()
  auxSessions.clear()
  auxUis.clear()
  askRouters.clear()
  bridge = null
  resetAuxParentContextForTest()
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

/**
 * 按父会话 + 侧栏槽位 id 查实例（`RightSidebar` 渲染面板用）。
 * 槽位 id 由各父会话的侧栏组分别从 1 分配，裸 id 不是全局键。
 * 没有槽位的实例（`tabId === null`）不参与匹配：它们不该再被任何格命中（TZD-131）。
 */
export function auxTabBySidebarId(parentRuntimeId: string, tabId: number): AuxTab | undefined {
  if (tabId === null) return undefined
  return tabs.find(tab => tab.parentRuntimeId === parentRuntimeId && tab.tabId === tabId)
}

/** 墓碑是否命中（迟到 `pi://exit` / 事件的丢弃判据）。 */
export function isClosedAux(runtimeId: string): boolean {
  return closedAuxIds.has(runtimeId)
}

/** 存活中的实例数（**创建中的实例同样计入**，所以直接用数组长度）。 */
export function auxLiveCount() {
  return tabs.length
}

/** 某个父会话的全部实例（挂载时补槽位、④ 的回收都用它）。 */
export function auxInstancesFor(parentRuntimeId: string): AuxTab[] {
  return tabs.filter(tab => tab.parentRuntimeId === parentRuntimeId)
}

/**
 * 把实例的槽位 id 改成新的（侧栏组被淘汰后补槽位时用）。
 *
 * `null` 表示**收回**槽位：本组已满/补不上时不能用旧号继续参与查找（TZD-131）。
 */
export function setAuxTabId(runtimeId: string, tabId: number | null) {
  const tab = auxTabByRuntime(runtimeId)
  if (tab) tab.tabId = tabId
}

/** 本会话里**没有槽位**的实例（名额空出后优先给它们补槽，见 `restoreSlots`）。 */
export function auxSlotlessFor(parentRuntimeId: string): AuxTab[] {
  return tabs.filter(tab => tab.parentRuntimeId === parentRuntimeId && tab.tabId === null)
}

/**
 * 该实例当前**有没有入口**（本组槽位确实属于它）。
 *
 * 没有槽位的实例（`tabId === null`：补格时组满被收回号）仍在跑，但用户打不开它的面板，
 * 因此不能作为划词目标或自动路由候选 —— 否则引用会被写进一个看不见的待发送桶（TZD-131）。
 */
export function auxHasEntry(tab: AuxTab): boolean {
  return tab.tabId !== null && auxTabBySidebarId(tab.parentRuntimeId, tab.tabId)?.runtimeId === tab.runtimeId
}

/**
 * 该实例此刻有没有**当前组**的入口。
 *
 * 优先问接线层（`router.entry` 读的是当前侧栏组的真实槽位），没有 router 时才退回
 * 实例表自查 —— 后者只说明"上一次分配到的号还在自己名下"，组被淘汰/排队时并不成立。
 */
function hasLiveEntry(parentRuntimeId: string, tab: AuxTab): boolean {
  const router = askRouters.get(parentRuntimeId)
  return router?.entry ? router.entry(tab) : auxHasEntry(tab)
}

/** 该父会话里**可以当作划词目标**的实例（当前组有入口、且未关闭）。 */
export function auxDeliverableFor(parentRuntimeId: string): AuxTab[] {
  return auxInstancesFor(parentRuntimeId).filter(
    tab => !isClosedAux(tab.runtimeId) && hasLiveEntry(parentRuntimeId, tab),
  )
}

/** 某个父会话最后一个实例（切回父会话时恢复它的面板）。 */
export function activeAuxFor(parentRuntimeId: string): AuxTab | undefined {
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i]
    if (tab?.parentRuntimeId === parentRuntimeId) return tab
  }
  return undefined
}

/**
 * aux 的 session store —— **只查不建**。
 *
 * 迟到路径（`spawnAuxPi` 已返回、`init` 之前）必须用它：此时实例可能已被关闭，
 * 用 `auxSessionFor` 会"缺席即创建"，把刚被 `closeAux` 释放的 store 又重建出来
 * （幽灵 store + 对已 kill 的 runtime 继续发 RPC）。
 */
export function auxSessionExisting(runtimeId: string): SessionStore | undefined {
  return auxSessions.get(runtimeId)
}

/** aux 的 session store（缺席时创建）。**只允许在实例活着且已登记时调用**。 */
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
export function auxTitleForSidebarId(parentRuntimeId: string, tabId: number): string | null {
  return auxTabBySidebarId(parentRuntimeId, tabId)?.title ?? null
}

/** 该父会话的 aux 槽位是否有未答的扩展询问（Tab 标题出标记用）。 */
export function auxHasPendingQuestion(parentRuntimeId: string, tabId: number): boolean {
  const tab = auxTabBySidebarId(parentRuntimeId, tabId)
  if (!tab) return false
  return (auxUis.get(tab.runtimeId)?.dialogs.length ?? 0) > 0
}

/**
 * 打开一个 aux 实例。
 *
 * 顺序固定：**同步**入表（`status: "creating"`）再 `await` spawn，让事件分发与
 * 并发手势立刻看到创建中的实例。实例数量不设辅助对话专属上限；同一父会话的并发
 * 手势复用同一次创建结果。
 *
 * 返回 `null` 表示实例在创建期间已关闭（调用方应回滚刚加的侧栏槽位）。
 */
export async function openAux(
  parentRuntimeId: string,
  options: { tabId: number; titlePrefix: string; spawn: (tab: AuxTab) => Promise<void> },
): Promise<AuxTab | null> {
  const pending = pendingCreations.get(parentRuntimeId)
  if (pending) return pending

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
  // 先入表：实例查询与事件分发都要立刻看到它（事件可能在 spawn 握手期间到达）。
  tabs.push(tab)
  // 先建 store：spawn 期间的 `pi://event` / `extension_ui_request` 要有落点。
  auxSessionFor(runtimeId)
  auxUiFor(runtimeId)
  // 心跳立即起（模块级）：实例一入表就开始续租，创建中的那几次失败由下一拍补上。
  startAuxLeaseHeartbeat()
  void claimAuxLease(runtimeId)

  const creation = (async () => {
    try {
      await options.spawn(tab)
      // 创建期间被关闭（spawn 成功、init 之前或之后）：统一收尾，不复活、不写状态。
      if (await settleLateAux(runtimeId)) return null
      const current = auxTabByRuntime(runtimeId)
      if (!current) return null
      current.status = "ready"
      delete current.error
      // 进程就绪：租约此时一定能登记成功（入口校验要求 runtime 存活）。
      await claimAuxLease(runtimeId)
      return current
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 失败也要先判"是否已关闭"：关闭后不能落在"留在表里带 error"那条路径上。
      if (await settleLateAux(runtimeId)) return null
      const current = auxTabByRuntime(runtimeId)
      if (!current) return null
      // 失败留在表里并带原因：面板要显示为什么失败，由用户决定关掉它。
      current.status = "error"
      current.error = message
      return current
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

/** 该父会话在途创建的 promise（同一手势复用，不再叠加进程/槽位）。 */
export function auxPendingCreation(parentRuntimeId: string): Promise<AuxTab | null> | undefined {
  return pendingCreations.get(parentRuntimeId)
}

/** 失败态重试前清掉错误（不复用旧进程，重试仍走 spawn）。 */
export function markAuxRetrying(runtimeId: string) {
  const tab = auxTabByRuntime(runtimeId)
  if (!tab) return
  tab.status = "creating"
  delete tab.error
}

/**
 * 已经为某个 runtime **拆过** store 的标记。
 *
 * 只幂等"拆 store"这一半 —— `$dispose()` 重复调用、重复 `_s.delete` 没有意义，
 * 而且要防止同一份 store 被两处收尾各自 dispose 一次。
 *
 * **kill 不参与这个幂等**：`rpc_kill` 对一个已不存在的 runtime 是无害的，而漏一次
 * 就留下一个活进程。所以每次 `settleLateAux` 命中都真调一次 kill，只有拆 store
 * 按 `sweptStores` 记一次。
 */
const sweptStores = new Set<string>()

/**
 * **唯一**的"迟到进程收尾"出口。
 *
 * 判据只有一个：该实例是"已关闭（墓碑命中）"或"已不在表里"。命中时收掉进程并丢弃
 * 可能残留的 store —— **不建 store、不写实例状态、不推 UI**。返回是否发生了收尾。
 *
 * 为什么必须集中：判据散在各调用点就会出现"某个出口忘了 kill"的漏杀窗口（
 * `spawnAuxPi` 迟到返回、`init` 抛错、面板重试各有一次），而且无法用测试统一覆盖。
 *
 * 为什么 kill **不**幂等：迟到的 spawn 可能在第一次收尾之后才真正把进程拉起来
 * （`spawnAuxPi` 的 resolve 与后端起进程之间没有同步点）。若 kill 也"只做一次"，
 * 那一次收尾就把额度用光了，后面真正落地的进程再也杀不到 —— 这正是上一版
 * `lateSettled` 的语义错误（实测 kill 次数不变、进程仍活）。
 */
export async function settleLateAux(runtimeId: string): Promise<boolean> {
  const gone = closedAuxIds.has(runtimeId) || !tabs.some(tab => tab.runtimeId === runtimeId)
  if (!gone) return false
  // 0) 租约：迟到的实例同样要释放，否则残租约把回收判据卡死。
  await releaseAuxLease(runtimeId)
  // 1) 进程：**每次命中都杀**。`rpc_kill` 幂等且对不存在的 runtime 无害。
  await bridge?.kill(runtimeId).catch(() => {})
  // 2) store：只拆一次（重复 dispose 会踩到已释放的实例）。
  if (!sweptStores.has(runtimeId)) {
    sweptStores.add(runtimeId)
    // 迟到收尾同样是"实例消失"：引用桶不走墓碑就会永远留在内存里。
    clearAuxSelectionBucket(runtimeId)
    dropAuxUiStore(runtimeId)
    const session = auxSessions.get(runtimeId)
    const ui = auxUis.get(runtimeId)
    auxSessions.delete(runtimeId)
    auxUis.delete(runtimeId)
    const pinia = getActivePinia() as unknown as { _s?: Map<string, unknown> } | null
    pinia?._s?.delete(`session:${runtimeId}`)
    pinia?._s?.delete(`ui:${runtimeId}`)
    session?.$dispose?.()
    ui?.$dispose?.()
  }
  return true
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
  // 关掉最后一个实例就停表（不必等下一拍自己发现"没有 aux 条目"）。
  if (tabs.length === 0) stopAuxLeaseHeartbeat()

  const session = auxSessions.get(runtimeId)
  const ui = auxUis.get(runtimeId)
  // 0) 未答的扩展询问：**没有 timeout 的**要在关掉进程前先发 `cancelled`
  //    （§5 对话框段）。有 timeout 的由后端 `activity` 过期，不必抢答。
  if (ui) await cancelPendingDialogs(ui)
  // 1) session store：清对话状态（aux 没有 session 文件，不存在保留历史的场景）。
  session?.clear()
  // 2) ui store：对话框/widget/状态栏/stderr + toasts/计时器/待插文本/在途询问。
  ui?.clear()
  // 3) 草稿（仅内存）与**本实例**的划词引用桶（TZD-103：关闭即销毁，不落盘）。
  clearAuxDraft(runtimeId)
  clearAuxSelectionBucket(runtimeId)
  // 3b) 父上下文“只注入首轮”的记账：关闭即清（同一 runtimeId 不会再被复用）。
  clearAuxParentContext(runtimeId)
  // 3c) 租约：**先释放再 kill**（规格 §5 销毁段的顺序）。反过来的话，回收器在
  //     进程消失、租约还在的空档里会把这条残租约一直留在 `aux_list` 里。
  await releaseAuxLease(runtimeId)
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

/**
 * 划词入口的路由结果。`ok: false` 的两类原因对应三种用户可见反馈：
 *
 * - `noParent` / `unavailable`：没有可投递的 aux（父会话不可用、入口未接线或新建
 *   未完成），调用方给一句通用失败提示；
 * - `append`：引用本身被上限/总长拒绝（`appendReason` 复用主会话的三种文案）。
 */
export type AuxAskOutcome =
  | { ok: true; tab: AuxTab; duplicate: boolean }
  | {
      ok: false
      reason: "noParent" | "unavailable" | "append"
      appendReason?: ConversationSelectionLimitReason
    }

/**
 * **划词入口的统一投递**（TZD-103）：会话正文与代码预览两个入口都走这里。
 *
 * 路由规则（`docs/aux-chat-spec.md` §10）：
 * 1. 显式 target 为已有 runtimeId → 只投该实例；失效或其他父会话的 id 返回 unavailable；
 * 2. 显式 target 为 null → 新建 aux 再投递（多实例选择器的"新建"入口）；
 * 3. 未传 target → 保留兼容路径：激活实例 → 最近实例 → 新建。共用浮层在多个实例时
 *    一定会先让用户选择，因此不会把多实例手势交给这条隐式路由。
 * 辅助对话没有专属实例上限，新建失败（例如通用侧栏容量不足或创建期间被关闭）返回
 * `unavailable`。
 *
 * 同一手势去重：连点时第一次就把实例同步登记进表（`openAux` 先入表再 `await` spawn），
 * 第二次直接命中"存活实例"分支；同一段文字再进桶时 `appendConversationSelection`
 * 判重，因此**只建一个实例、引用不重复**。
 *
 * **入口优先**（TZD-103 P2-2，成员裁定）：先确认该父会话的 router 存在，再谈复用或
 * 新建。父 `ChatView` 卸载后 router 注销、`reveal` 也无人接，此时即便实例还活着也
 * 返回 `unavailable` 并且**不写任何桶** —— 否则会留下一条投不进也看不到的引用。
 */
export async function askInAux(
  parentRuntimeId: string,
  payload: AuxAskPayload,
  target: AuxAskTarget | undefined = undefined,
): Promise<AuxAskOutcome> {
  if (!parentRuntimeId) return { ok: false, reason: "noParent" }
  const router = auxAskRouter(parentRuntimeId)
  if (!router) return { ok: false, reason: "unavailable" }
  if (typeof target === "string") {
    // 多实例选择器给出的目标必须仍属于这个父会话；关闭/切换后的旧选项不得落到别的实例。
    const selected = auxTabByRuntime(target)
    if (!selected || selected.parentRuntimeId !== parentRuntimeId) return { ok: false, reason: "unavailable" }
    // 目标还必须**真的有入口**：等槽位（`tabId === null`）的实例打不开面板，收下引用
    // 只会落进一个看不见的待发送桶（TZD-131）。此时沿用"没有可用入口"的失败文案。
    if (!hasLiveEntry(parentRuntimeId, selected)) return { ok: false, reason: "unavailable" }
    return deliverToAux(selected, payload)
  }
  if (target !== null) {
    // 未显式选择时保留原有自动路由；多实例浮层会传入已有 id 或 null（新建）。
    // 自动路由只挑**可打开**的实例：激活的排在前面，其次该父会话最近的可用实例。
    const active = router.active(parentRuntimeId)
    if (active && hasLiveEntry(parentRuntimeId, active)) return deliverToAux(active, payload)
    const deliverable = auxDeliverableFor(parentRuntimeId)
    const recent = deliverable[deliverable.length - 1]
    // 没有可打开的实例时落到下面的"新建"分支（新建能拿到槽位才可投递）。
    if (recent) return deliverToAux(recent, payload)
  }
  const created = await router.open(parentRuntimeId)
  if (!created) return { ok: false, reason: "unavailable" }
  // 新建的实例可能在 spawn 期间就被关闭：墓碑命中时不再往它的桶里塞引用。
  if (isClosedAux(created.runtimeId)) return { ok: false, reason: "unavailable" }
  // 也必须**在写桶之前重新确认当前组入口**：等待期间可能换键/被淘汰/组满，实例变成
  // 没有槽位（`tabId === null`）的状态；此时收下引用只会落进一个打不开的桶（TZD-131）。
  if (!hasLiveEntry(parentRuntimeId, created)) return { ok: false, reason: "unavailable" }
  return deliverToAux(created, payload)
}

function deliverToAux(tab: AuxTab, payload: AuxAskPayload): AuxAskOutcome {
  const result = addAuxSelection(tab.runtimeId, payload)
  if (!result.ok) return { ok: false, reason: "append", appendReason: result.reason }
  auxAskRouter(tab.parentRuntimeId)?.reveal(tab)
  return { ok: true, tab, duplicate: result.duplicate }
}

/** 关闭某父会话的全部实例（父会话关闭/被淘汰时用）。 */
export async function closeAllFor(parentRuntimeId: string): Promise<void> {
  const ids = tabs.filter(tab => tab.parentRuntimeId === parentRuntimeId).map(tab => tab.runtimeId)
  for (const id of ids) await closeAux(id)
}
