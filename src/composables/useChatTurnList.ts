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
   * 补偿量必须**只算前插本身**：不能跨这段异步等待去比"列表总高" —— 等待期间用户完全可能
   * 展开了折叠提问、或做完了一次引用定位，这些高度变化都不是前插，按总高差补会把人刚定位
   * 的正文与徽标直接滚出视口（QA 三内核复现：可见比例 100% → 0%）。
   *
   * 做法：点击那一刻记下**已存在的消息 id**，分页落地后新增的 id 全部是前插行，且都在
   * 参照行之上 —— 它们的实际高度之和就是前插高度。新行先是占位估算高度
   * （`VirtualMessage`），随后陆续换成真实高度，所以要逐帧累积"这次新增了多少"，
   * 而不是一次性加总高差。
   *
   * 与 `VirtualMessage` 的行高补偿**互斥**（`withAnchorLock`），否则两边都补会互相追高。
   * 它刻意**不是导航**：只固定"此刻正在读的内容"；用户更晚发起的定位（`isRevealActive`）
   * 接管滚动后这里立刻让位，绝不覆盖更新的意图。
   */
  /** 记录点击那一刻已存在的消息 id（分页新增的 id 就是前插行）。 */
  function captureKnownRows(): { ids: Set<number>; scope: string | null } {
    return { ids: new Set(session.entries.map(entry => entry.id)), scope: session.sessionFile }
  }
  /** 前插行的实际高度之和（含尚未真实测量的占位行）。 */
  function prependHeight(ids: Set<number>, viewport: HTMLElement): number {
    let total = 0
    for (const row of Array.from(viewport.querySelectorAll("[data-message-id]"))) {
      const id = Number(row.getAttribute("data-message-id"))
      if (ids.has(id)) continue
      total += row.getBoundingClientRect().height
    }
    return total
  }
  async function holdReadingContent(known: { ids: Set<number>; scope: string | null } | null, frames = 16) {
    if (!known || known.scope !== session.sessionFile) return
    const handle = conversation.value
    // 测试替身/非 DOM 宿主没有行几何能力：跳过补偿，不影响导航本身。
    if (!handle?.historyViewport) return
    const probe = handle.historyViewport()
    if (!probe || typeof probe.querySelectorAll !== "function") return
    const hold = async () => {
      let knownHeight = 0
      let stable = 0
      for (let frame = 0; frame < frames && stable < 4; frame++) {
        await nextTick()
        await waitFrame()
        // 有更新的定位正在滚动：让位，不去争滚动位置（否则会把用户的意图顶掉）。
        if (conversation.value?.isRevealActive?.()) return
        const viewport = conversation.value?.historyViewport?.()
        if (!viewport || !viewport.isConnected || known.scope !== session.sessionFile) return
        const current = prependHeight(known.ids, viewport)
        const delta = current - knownHeight
        if (Math.abs(delta) < 1) {
          stable += 1
          continue
        }
        viewport.scrollTop += delta
        knownHeight = current
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
    // 未挂载的节点会**前插一整页历史**：先记下此刻已存在的消息，提交后只按前插行的实际
    // 高度补偿（只固定阅读内容，不是导航，也不覆盖更新的定位意图）。
    const known = turn.entryId == null ? captureKnownRows() : null
    // Unmaterialized turns load their history pages first, then scroll.
    const id = turn.entryId ?? (await session.revealTimelineTurn(turn.id))
    await holdReadingContent(known)
    if (id == null) return
    // 分页期间已有更新的定位：数据照常保留，但这次点击不再抢滚动位置。
    if (request && !request.isCurrent()) return
    conversation.value?.stopScroll()
    // 身份往后传：`Conversation.scrollToMessage` 不能在这里重新领 token。
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
