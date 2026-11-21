import { computed, nextTick, type Ref } from "vue"
import type { RevealRequest } from "@/lib/revealScroll"
import { responseTurns, type AssistantTurn } from "@/lib/responseTurns"
import type { TimelineTurn } from "@/lib/conversationTimeline"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"

export interface ChatHistoryHandle {
  stopScroll: () => void
  /**
   * 把消息滚进视口并验证结果（返回是否到位，TZD-138 P2）。
   * `request` 是调用方**发起定位时**取得的视口请求身份（引用定位会传自己那份，
   * 避免在重挂阶段重新领身份而顶掉用户更新的定位）。
   */
  scrollToMessage: (id: number, request?: RevealRequest) => Promise<boolean> | void
  /**
   * 复核并校正上一步的消息定位（TZD-138）：虚拟行重挂/测高会让那一笔滚动停在视口外。
   * 只在调用方需要"真的到位"时使用（时间线跳转、引用定位）。
   */
  settleScrollToMessage?: (id: number, request?: RevealRequest) => Promise<boolean>
  /** 面板 `scrollToMessage` 是否把"复核校正"也做了（由宿主决定，测试替身可省略）。 */
  /** 把视口内任意元素（例如划词引用徽标）滚进视口并验证结果。 */
  revealInViewport?: (target: Element, options?: { animated?: boolean; request?: RevealRequest }) => Promise<boolean>
  /** 在**发起定位的那一刻**取得该视口的请求身份（跨入口竞态的根修复点）。 */
  beginRevealRequest?: () => RevealRequest | null
  /** 在这段流程里抑制虚拟行的行高补偿（历史前插的阅读锚定自己写 `scrollTop`）。 */
  withAnchorLock?: <T>(run: () => Promise<T>) => Promise<T>
  /** 是否有定位正在接管滚动（有的话阅读锚定立刻让位，不去争滚动位置）。 */
  isRevealActive?: () => boolean
  historyViewport: () => HTMLElement | null
}

export function blocksText(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter(b => b.type === "text")
    .map(b => b.text ?? "")
    .join("\n\n")
}

export function hasSummary(entry: AssistantTurn): boolean {
  return entry.complete && !!blocksText(entry.summary).trim()
}

export function isWaitingForReply(session: Pick<SessionStore, "isStreaming" | "partialBlocks" | "runs">): boolean {
  return (
    session.isStreaming &&
    !session.partialBlocks &&
    !Object.values(session.runs).some(run => run.state === "input-streaming" || run.state === "input-available")
  )
}

/**
 * Settled turns fold their process even when interruption leaves no final text.
 * Concise mode hides completed thinking, so a reasoning-only process would
 * expand to nothing and therefore needs no disclosure.
 */
export function hasFoldedProcess(entry: AssistantTurn, concise = false): boolean {
  if (!entry.complete || entry.process.length === 0) return false
  if (!concise) return true
  return entry.process.some(block => block.type === "toolCall" || (block.type === "text" && !!block.text?.trim()))
}

/** 流式 turn 投影与分页锚点恢复；状态与滚动句柄均属于当前窗格。 */
export function useChatTurnList(deps: {
  session: SessionStore
  ui: UiStore
  connecting: () => boolean
  conversation: Ref<ChatHistoryHandle | null>
}) {
  const { session, ui, conversation } = deps
  // Keep committed history independent of partial deltas. Rebuilding it for
  // every chunk also changes every assistant prop's identity in both panes.
  const committedTurns = computed(() => responseTurns(session.entries, session.isStreaming))
  const renderedEntries = computed(() => {
    // Transient blocks cannot reopen a turn once its run has settled.
    const streaming = session.isStreaming
    // Context-edit markers stay in the session data but never surface here:
    // responseTurns already skips them so they cannot split a turn.
    const committed = committedTurns.value
    const partial = streaming ? session.partialBlocks : null
    if (!partial?.length) return committed
    // Only the live tail is replaced; never mutate the cached projection.
    const turns = [...committed]
    if (partial?.length) {
      const last = turns[turns.length - 1]
      if (last?.kind === "assistant") {
        turns[turns.length - 1] = { ...last, blocks: [...last.blocks, ...partial], complete: false }
      } else {
        // Nothing committed yet: render the stream in place under the reserved
        // turn id so completion keeps the same v-for key (no remount flash).
        turns.push({
          kind: "assistant",
          id: session.streamingTurnId ?? -1,
          lastIndex: session.entries.length,
          blocks: [...partial],
          process: [],
          summary: [],
          errors: [],
          failed: false,
          complete: false,
          durationMs: null,
          toolCallCount: 0,
        })
      }
    }
    return turns
  })

  /** 等一帧（没有 rAF 的环境退化成微任务，便于纯单测）。 */
  const waitFrame = () =>
    new Promise<void>(resolve => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve())
      else resolve()
    })

  /**
   * 历史分页会把一整页更早的消息**插到最前面**：即便 `scrollTop` 不动，用户眼前的内容也会
   * 整体下移（QA 实测：引用正文跑到视口顶下 4608px）。
   *
   * 补偿必须**只算真正插在参照行之上的那些布局**。QA 打回过三种偷懒做法：
   * - 跨这段异步等待比较 `scrollHeight`：会把等待期间"展开折叠提问"的高度也算进来；
   * - 求和"所有陌生 `[data-message-id]` 的矩形高度"（再手动补行间距）：会把**流式尾行**算成
   *   前插（它不在已提交 `session.entries` 里，且外壳与内层消息同 id、被算两次），而行间距
   *   又量不稳（虚拟行装卸时相邻间距会抖，实测 ±96px 来回震荡）；
   * - 盯参照行的**视口**位置：用户后来滚动（引用定位）会让它跟着跑。
   *
   * 正确的观测量是参照行在**内容坐标系**里的位置：它只被"插在它上方的行（含行间距）"推动，
   * 与用户滚到哪里、下方是否在流式输出都无关。滚动校正**不会**改变内容内位置，所以按
   * "相对点击那一刻的新增位移"累积（已经补过的不再重复补），逐帧跟随虚拟行的高度落定。
   *
   * 与 `VirtualMessage` 的行高补偿**互斥**（`withAnchorLock`），否则两边都补会互相追高；
   * 用户更晚发起的定位（`isRevealActive`）接管滚动时让位；它刻意**不是导航**
   * （不调用 `stopScroll` / `scrollToMessage`）。
   */
  /** 内容坐标系原点：滚动容器内容层的顶端（`scrollTop` 的零点）。 */
  function contentOrigin(viewport: HTMLElement): number | null {
    const content = viewport.firstElementChild
    return content ? content.getBoundingClientRect().top : null
  }
  function captureReadingAnchor(): { rowId: string; contentOffset: number; scope: string | null } | null {
    const viewport = conversation.value?.historyViewport?.()
    if (!viewport || typeof viewport.getBoundingClientRect !== "function") return null
    const origin = contentOrigin(viewport)
    if (origin === null) return null
    const known = new Set(session.entries.map(entry => entry.id))
    /**
     * 锚点取**最靠上的"分页前就存在"的行**（而不是用户此刻正看着的那条）。
     *
     * 为什么：前插的整页历史只会插在"已有的最上面一行"之上，所以这条行的内容内位置变化量
     * 恰好 = 前插行高度 + 它们的行间距 —— 无论用户在等待期间展开了哪一条（被展开的行在
     * 锚点下方，不改变锚点顶端的位置）、无论用户滚到了哪里、也无论下方是否在流式输出。
     * 反过来拿"用户正看的那条"当锚点，就会把"它上方某条展开"的高度也算进来（QA 复现：
     * 分页中展开长提问并定位后，正文被推出视口，比例 100%→0%）。
     */
    for (const row of Array.from(viewport.querySelectorAll("[data-message-id]"))) {
      const rowId = row.getAttribute("data-message-id")
      if (rowId === null || !known.has(Number(rowId))) continue
      return { rowId, contentOffset: row.getBoundingClientRect().top - origin, scope: session.sessionFile }
    }
    return null
  }
  async function holdReadingAnchor(
    anchor: { rowId: string; contentOffset: number; scope: string | null } | null,
    frames = 16,
  ) {
    if (!anchor || anchor.scope !== session.sessionFile) return
    const handle = conversation.value
    // 测试替身/非 DOM 宿主没有行几何能力：跳过补偿，不影响导航本身。
    if (!handle?.historyViewport) return
    const probe = handle.historyViewport()
    if (!probe || typeof probe.querySelectorAll !== "function") return
    const hold = async () => {
      // 已经补过的前插位移；只对**新增**位移再补一次。
      let applied = 0
      let stable = 0
      for (let frame = 0; frame < frames && stable < 4; frame++) {
        await nextTick()
        await waitFrame()
        // 有更新的定位正在滚动：让位，不去争滚动位置（否则会把用户的意图顶掉）。
        if (conversation.value?.isRevealActive?.()) return
        const viewport = conversation.value?.historyViewport?.()
        if (!viewport || !viewport.isConnected || anchor.scope !== session.sessionFile) return
        const row = viewport.querySelector(`[data-message-id="${anchor.rowId}"]`)
        const origin = contentOrigin(viewport)
        if (!row || origin === null) return
        // 参照行在内容内被往下推了多少 = 前插行 + 行间距之和（下方行与流式尾行不影响它）。
        const growth = row.getBoundingClientRect().top - origin - anchor.contentOffset
        const delta = growth - applied
        if (Math.abs(delta) < 1) {
          stable += 1
          continue
        }
        viewport.scrollTop += delta
        applied = growth
        stable = 0
      }
    }
    if (handle.withAnchorLock) await handle.withAnchorLock(hold)
    else await hold()
  }

  async function navigateToQuestion(turn: TimelineTurn) {
    /**
     * 视口请求身份必须在**点击那一刻**取得（TZD-138 历史分页竞态）：未挂载的时间线节点
     * 要先 `await revealTimelineTurn`（拉历史分页），这个等待可能长达几秒；期间用户完全
     * 可能点了引用定位。如果在等待之后才取身份，"先点击、后恢复"的旧导航就会被当成最新，
     * 反把用户后来点的目标顶掉（QA 三内核复现：旧请求写入 `top: 1980` → `1056`）。
     *
     * 校验点是**导航之前**：分页可以照常返回数据（历史已加载、条目已补上，这些都是
     * 有用的副作用），但已过期的点击**不得再导航**（`stopScroll` / `scrollToMessage` 都不发）。
     */
    const request = conversation.value?.beginRevealRequest?.() ?? null
    // 未挂载的节点会**前插一整页历史**：先记下此刻可见的那条行，提交后按它的内容内新增位移
    // 补偿（只固定阅读内容，不是导航，也不覆盖更新的定位意图）。
    const anchor = turn.entryId == null ? captureReadingAnchor() : null
    // Unmaterialized turns load their history pages first, then scroll.
    const id = turn.entryId ?? (await session.revealTimelineTurn(turn.id))
    // 补偿**无条件执行**：它固定的是"此刻正在读的内容"。即使用户在等待期间点了引用，
    // 那条定位刚把人带到某处，前插仍会把那一处整体下移 —— 不补等于把刚定位的内容推走。
    // 循环内部遇到"定位正在进行"（`isRevealActive`）时让位，不与更新的定位抢滚动。
    await holdReadingAnchor(anchor)
    if (id == null) return
    // 分页期间已有更新的定位：数据照常保留，但这次点击不再抢滚动位置。
    if (request && !request.isCurrent()) return
    conversation.value?.stopScroll()
    // 身份往后传：`Conversation.scrollToMessage` 不能在这里重新领 token。
    // 一笔滚动 + 复核校正都在 `scrollToMessage` 里完成（见 `ChatTurnList` 的转发）。
    await conversation.value?.scrollToMessage(id, request ?? undefined)
  }
  let restoringHistory = false
  async function onHistoryScroll(event: Event) {
    const viewport = event.target as HTMLElement
    // Prefetch before reaching the top; ignore initial positioning and duplicate events.
    if (
      viewport.scrollTop > 600 ||
      session.historyLoading ||
      deps.connecting() ||
      !session.hasOlderHistory ||
      session.olderHistoryLoading ||
      restoringHistory
    )
      return
    restoringHistory = true
    const file = session.sessionFile
    conversation.value?.stopScroll()
    const height = viewport.scrollHeight
    try {
      await session.loadOlderHistory()
      await nextTick()
      if (viewport.isConnected && file === session.sessionFile) viewport.scrollTop += viewport.scrollHeight - height
    } catch (error) {
      ui.pushToast(String(error), "error")
    } finally {
      restoringHistory = false
    }
  }

  function lastAssistantTurn(): AssistantTurn | undefined {
    const turns = renderedEntries.value
    for (let index = turns.length - 1; index >= 0; index--) {
      const entry = turns[index]
      if (entry.kind === "assistant") return entry
    }
    return undefined
  }

  function historyViewport(): HTMLElement | null {
    return conversation.value?.historyViewport() ?? null
  }

  function scrollHistory(direction: -1 | 1) {
    const viewport = historyViewport()
    if (!viewport) return
    conversation.value?.stopScroll()
    viewport.scrollTo({ top: direction < 0 ? 0 : viewport.scrollHeight })
  }

  return { renderedEntries, navigateToQuestion, onHistoryScroll, lastAssistantTurn, scrollHistory }
}
