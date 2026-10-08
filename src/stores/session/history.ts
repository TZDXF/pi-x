import { computed, ref, shallowRef, type Ref } from "vue"
import { sessionHistory, sessionLastError, type SessionLastError, type rpcRequest } from "@/api/piClient"
import { buildTimelineTurns, type TimelineTurn } from "@/lib/conversationTimeline"
import { annotateCompactionEstimates } from "@/lib/contextBreakdown"
import { contentText } from "@/lib/content"
import { blocksFromMessage, errorBlockText } from "./events"
import type { Block, Entry, ToolRun } from "./types"

interface HistoryContext {
  entries: Ref<Entry[]>
  runs: Ref<Record<string, ToolRun>>
  partialBlocks: Ref<Block[] | null>
  streamingTurnId: Ref<number | null>
  sessionFile: Ref<string | null>
  isStreaming: Ref<boolean>
  rpcRequest: typeof rpcRequest
  nextId(): number
  syncSessionFile(): Promise<void>
  refreshFileRewindState(file: string | null): Promise<void>
  mergeFileChangeArtifact(entry: unknown): void
  resetArtifacts(): void
  invalidateConversation(): void
}

/** Owns raw transcript paging and restoration, independently of prompt scheduling. */
export function createSessionHistory(context: HistoryContext) {
  const {
    entries,
    runs,
    partialBlocks,
    streamingTurnId,
    sessionFile,
    isStreaming,
    rpcRequest,
    nextId,
    syncSessionFile,
    refreshFileRewindState,
    mergeFileChangeArtifact,
    resetArtifacts,
    invalidateConversation,
  } = context
  // Raw history snapshot outside Vue's deep reactive graph; emptied once fully materialized.
  const historyMessages = shallowRef<any[]>([])
  /** Stop reason of the session's final turn, appended after history loads. */
  const pendingHistoryError = shallowRef<SessionLastError | null>(null)
  let historyVersion = 0
  const historyCursor = ref(0)
  const historyLoading = ref(false)
  const olderHistoryLoading = ref(false)
  const hasOlderHistory = computed(() => historyCursor.value > 0)
  const yieldHistory = () => new Promise<void>(resolve => setTimeout(resolve, 0))

  function invalidateHistory() {
    historyVersion++
    resetArtifacts()
    historyMessages.value = []
    pendingHistoryError.value = null
    historyCursor.value = 0
    historyLoading.value = false
    olderHistoryLoading.value = false
  }

  /** Materialize only one page, yielding during large tool-heavy histories. */
  async function loadOlderHistory() {
    if (olderHistoryLoading.value || !historyCursor.value) return
    const version = historyVersion
    const source = historyMessages.value
    const end = historyCursor.value
    olderHistoryLoading.value = true
    try {
      await yieldHistory()
      let start = end
      let count = 0
      while (start > 0 && count < 30) {
        const msg = source[--start]
        if (msg.role === "user" || msg.role === "assistant") count++
        if ((end - start) % 100 === 0) {
          await yieldHistory()
          if (version !== historyVersion) return
        }
      }
      // A long tool run (or repeated empty provider failures) may exceed a
      // page by itself. Include its question so the first page is navigable
      // without relying on the timeline to fetch older history.
      while (start > 0 && source[start].role !== "user") {
        start--
        if ((end - start) % 100 === 0) {
          await yieldHistory()
          if (version !== historyVersion) return
        }
      }
      const page: Entry[] = []
      const pageRuns: Record<string, ToolRun> = {}
      for (let i = start; i < end; i++) {
        if (version !== historyVersion) return
        const msg = source[i]
        if (msg.role === "custom") {
          mergeFileChangeArtifact(msg)
          continue
        }
        if (msg.type === "model_change") {
          // Passthrough session-file entry (timestamp is RFC3339 there);
          // renders as a conversation divider.
          page.push({
            kind: "model_change",
            id: nextId(),
            provider: typeof msg.provider === "string" ? msg.provider : "",
            modelId: typeof msg.modelId === "string" ? msg.modelId : "",
            timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.parse(msg.timestamp) || undefined,
          })
          continue
        }
        if (msg.role === "user") {
          const text = contentText(msg.content)
          const images = Array.isArray(msg.content)
            ? msg.content
                .filter((c: any) => c.type === "image" && c.data && c.mimeType)
                .map((c: any) => ({ url: `data:${c.mimeType};base64,${c.data}` }))
            : []
          if (text.trim() || images.length)
            page.push({ kind: "user", id: nextId(), text, images, timestamp: msg.timestamp })
        } else if (msg.role === "assistant") {
          // Failed responses persist with empty content and are dropped here;
          // loadHistory surfaces the final turn's failure separately at the end.
          const blocks = blocksFromMessage(msg)
          if (blocks.length) page.push({ kind: "assistant", id: nextId(), blocks, timestamp: msg.timestamp })
        } else if (msg.role === "compactionSummary" && typeof msg.summary === "string")
          page.push({
            kind: "compaction",
            id: nextId(),
            summary: msg.summary,
            tokensBefore: typeof msg.tokensBefore === "number" ? msg.tokensBefore : undefined,
            tokensAfter: typeof msg.estimatedTokensAfter === "number" ? msg.estimatedTokensAfter : undefined,
            timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
          })
        else if (msg.role === "toolResult") {
          const callId = String(msg.toolCallId ?? msg.id ?? "")
          if (callId)
            pageRuns[callId] = {
              id: callId,
              name: "tool",
              argsText: "",
              outputText: contentText(msg.content),
              state: msg.isError ? "output-error" : "output-available",
            }
        }
        if ((i - start + 1) % 20 === 0) await yieldHistory()
      }
      if (version !== historyVersion) return
      // Keep newer/live results authoritative when prepending an older page.
      runs.value = { ...pageRuns, ...runs.value }
      entries.value = [...page, ...entries.value]
      historyCursor.value = start
      if (!start) historyMessages.value = []
    } finally {
      if (version === historyVersion) olderHistoryLoading.value = false
    }
  }

  /** Append the file-recorded stop reason after the loaded conversation. */
  function placePendingHistoryError() {
    const pending = pendingHistoryError.value
    if (!pending) return
    pendingHistoryError.value = null
    entries.value = [
      ...entries.value,
      {
        kind: "assistant",
        id: nextId(),
        blocks: [{ type: "text", text: errorBlockText(pending.errorMessage) }],
        timestamp: typeof pending.timestamp === "number" ? pending.timestamp : undefined,
      },
    ]
  }

  /**
   * Supplement history with the last provider error from the session file.
   * pi removes retried failures from the RPC message projection, so a session
   * whose run was interrupted would otherwise show no trace of the failure.
   */
  async function fetchLastSessionError(version: number) {
    const file = sessionFile.value
    // A running turn may still recover from its latest failure; the settle
    // path reports a final failure live. Supplement only idle sessions.
    if (!file || isStreaming.value) return
    let last: SessionLastError | null
    try {
      last = await sessionLastError(file)
    } catch {
      return
    } // file unreadable (e.g. browser preview); history still works
    if (version !== historyVersion || !last?.errorMessage) return
    // Only a failure at the end of the current transcript counts as the stop
    // reason. A later message means the retry recovered and the turn continued
    // (or the user prompted again), so the failure is historical.
    const ts = last.timestamp
    if (typeof ts === "number" && historyMessages.value.some(m => typeof m?.timestamp === "number" && m.timestamp > ts))
      return
    pendingHistoryError.value = last
  }

  async function loadMessages(msgs: any[]) {
    invalidateConversation()
    invalidateHistory()
    entries.value = []
    runs.value = {}
    partialBlocks.value = null
    streamingTurnId.value = null
    historyMessages.value = msgs
    historyCursor.value = msgs.length
    await loadOlderHistory()
  }

  /** Fetch asynchronously; stale responses must never replace another session. */
  async function loadHistory() {
    invalidateHistory()
    const version = historyVersion
    historyLoading.value = true
    try {
      // Read the raw session file when available: pi's get_messages returns
      // the projected post-compaction context, which would hide earlier turns.
      let msgs: any[] | null = null
      const file = sessionFile.value
      if (file) {
        try {
          const raw = await sessionHistory(file)
          if (Array.isArray(raw)) msgs = raw
        } catch {
          /* fall back to the RPC projection below */
        }
      }
      if (version !== historyVersion) return
      if (!msgs) {
        const res = await rpcRequest<{ messages: any[] }>({ type: "get_messages" })
        if (version !== historyVersion) return
        if (!res.success) throw new Error(res.error || "Failed to load history")
        msgs = res.data?.messages ?? []
      }
      void refreshFileRewindState(file)
      // History markers only know tokensBefore; estimate the after size.
      annotateCompactionEstimates(msgs)
      entries.value = []
      runs.value = {}
      partialBlocks.value = null
      streamingTurnId.value = null
      historyMessages.value = msgs
      historyCursor.value = msgs.length
      // Fetch before paging: loadOlderHistory releases historyMessages once the
      // oldest page is reached, and the final-turn check needs the full list.
      await fetchLastSessionError(version)
      await loadOlderHistory()
      placePendingHistoryError()
      void syncSessionFile()
    } finally {
      if (version === historyVersion) historyLoading.value = false
    }
  }

  /** Timeline turns across the whole session, including turns whose history
   * pages are not materialized yet (they carry a synthetic negative id). */
  const timelineTurns = computed<TimelineTurn[]>(() =>
    buildTimelineTurns(historyMessages.value, historyCursor.value, entries.value),
  )

  /** Load older history until the turn materializes; returns its user entry id. */
  async function revealTimelineTurn(turnId: number): Promise<number | null> {
    const turns = timelineTurns.value
    const index = turns.findIndex(t => t.id === turnId)
    if (index < 0) return null
    if (turns[index].entryId != null) return turns[index].entryId
    const fromEnd = turns.length - 1 - index
    while (historyCursor.value > 0) {
      const cursorBefore = historyCursor.value
      await loadOlderHistory()
      if (historyCursor.value === cursorBefore) break
    }
    const loaded = timelineTurns.value
    const resolved =
      loaded[loaded.length - 1 - fromEnd] ??
      [...loaded].reverse().find(t => t.entryId != null && t.question === turns[index].question)
    return resolved?.entryId ?? null
  }

  return {
    historyMessages,
    historyCursor,
    historyLoading,
    olderHistoryLoading,
    hasOlderHistory,
    invalidateHistory,
    loadOlderHistory,
    loadMessages,
    loadHistory,
    timelineTurns,
    revealTimelineTurn,
  }
}
