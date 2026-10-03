import { computed, nextTick, type Ref } from "vue"
import { responseTurns, type AssistantTurn } from "@/lib/responseTurns"
import type { TimelineTurn } from "@/lib/conversationTimeline"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"

export interface ChatHistoryHandle {
  stopScroll: () => void
  scrollToMessage: (id: number) => void
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

/** 流式 turn 投影与分页锚点恢复；状态与滚动句柄均属于当前窗格。 */
export function useChatTurnList(deps: {
  session: SessionStore
  ui: UiStore
  connecting: () => boolean
  conversation: Ref<ChatHistoryHandle | null>
}) {
  const { session, ui, conversation } = deps
  const renderedEntries = computed(() => {
    const streaming = session.isStreaming || !!session.partialBlocks
    // Context-edit markers stay in the session data but never surface here:
    // responseTurns already skips them so they cannot split a turn.
    const turns = responseTurns(session.entries, streaming)
    const partial = session.partialBlocks
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
          complete: false,
          durationMs: null,
          toolCallCount: 0,
        })
      }
    }
    return turns
  })

  async function navigateToQuestion(turn: TimelineTurn) {
    // Unmaterialized turns load their history pages first, then scroll.
    const id = turn.entryId ?? (await session.revealTimelineTurn(turn.id))
    if (id == null) return
    conversation.value?.stopScroll()
    conversation.value?.scrollToMessage(id)
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
