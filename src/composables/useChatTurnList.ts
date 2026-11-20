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
    // Unmaterialized turns load their history pages first, then scroll.
    const id = turn.entryId ?? (await session.revealTimelineTurn(turn.id))
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
