import { ALL_THINKING_LEVELS, supportedThinkingLevels, clampThinkingLevel } from "@/lib/thinkingLevels"
import { defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import { i18n, tBackendError } from "@/i18n"
import { useWorkspaceStore } from "@/stores/workspace"
import { setSessionRunStatus } from "@/stores/sessionRunStatus"
import { generateSessionTitle, getModelsConfig, getPiSettings, pixLog, rpcRequest as requestForRuntime, sessionHistory, sessionLastError, sessionMtime, type SessionLastError } from "@/api/piClient"
import { buildTimelineTurns, type TimelineTurn } from "@/lib/conversationTimeline"
import { notifyTurnComplete } from "@/lib/notifications"
import { sessionChanges } from "@/lib/sessionChanges"
import { annotateCompactionEstimates } from "@/lib/contextBreakdown"
import { contentText } from "@/lib/content"
import type {
  AssistantMessageEvent,
  CommandInfo,
  Model,
  SessionState,
  SessionStats,
  ThinkingLevel,
  Usage,
} from "@/api/protocol"

// ---- render model ----

export interface ToolRun {
  id: string
  name: string
  argsText: string
  outputText: string
  state: "input-streaming" | "input-available" | "output-available" | "output-error"
  /** Execution start (tool_execution_start); drives the elapsed-time display. */
  startedAt?: number
  completedAt?: number
}

export interface TextBlock { type: "text", text: string }
export interface ThinkingBlock { type: "thinking", text: string, streaming: boolean }
export interface ToolCallBlock { type: "toolCall", callId: string, name: string, argsText: string }
export type Block = TextBlock | ThinkingBlock | ToolCallBlock

export interface QueuedPrompt {
  id: number
  text: string
  images?: { data: string, mimeType: string }[]
  expandedText?: string
  sendAt?: number
}

export interface UserEntry { kind: "user", id: number, text: string, modelChange?: { from: string, to: string }, images?: { url: string }[], live?: true, timestamp?: number }
export interface AssistantEntry { kind: "assistant", id: number, blocks: Block[], live?: true, startedAt?: number, completedAt?: number, timestamp?: number }
/** Marks where a compaction collapsed earlier history; summary stays expandable. */
export interface CompactionEntry { kind: "compaction", id: number, summary: string, tokensBefore?: number, tokensAfter?: number, timestamp?: number, live?: true }
export type Entry = UserEntry | AssistantEntry | CompactionEntry

export interface RetryInfo {
  attempt: number
  maxAttempts: number
  errorMessage: string
}

/** Keep the status code but unwrap JSON error payloads emitted by providers. */
function formatRetryError(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return ""
  const match = raw.match(/^(\d{3})\s*:\s*(\{[\s\S]*\})$/)
  const status = match?.[1]
  const json = match?.[2] ?? raw
  try {
    const parsed = JSON.parse(json)
    const inner = typeof parsed?.error?.message === "string" ? parsed.error.message : parsed?.message
    if (typeof inner === "string" && inner.trim())
      return status ? `${status} · ${inner.trim()}` : inner.trim()
  } catch { /* keep the original provider error */ }
  return raw
}

/** Shared phrasing between the live settle entry and history rendering. */
function errorBlockText(message: string): string {
  return `**${i18n.global.t("chat.errorLabel")}:** ${formatRetryError(message)}`
}

// ---- thinking levels (mirror pi-ai/models.js for offline use) ----

/** pi's DEFAULT_THINKING_LEVEL (core/defaults.js). */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium"

const SELECTION_KEY = "pix.conversationSelection"
interface RememberedSelection { model?: Model; thinking?: ThinkingLevel; levels?: ThinkingLevel[] }
// Cache display metadata only, never provider headers or credentials from RPC models.
function selectionModel(model: Model): Model {
  return { id: model.id, provider: model.provider, name: model.name || model.id,
    reasoning: model.reasoning === true, api: "", baseUrl: "", input: [],
    contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
}
function readSelection(): RememberedSelection {
  try {
    const value = JSON.parse(localStorage.getItem(SELECTION_KEY) || "{}")
    if (!value || typeof value !== "object") return {}
    return {
      model: typeof value.model?.provider === "string" && typeof value.model?.id === "string" ? selectionModel(value.model) : undefined,
      thinking: ALL_THINKING_LEVELS.includes(value.thinking) ? value.thinking : undefined,
      levels: Array.isArray(value.levels) ? value.levels.filter((v: ThinkingLevel) => ALL_THINKING_LEVELS.includes(v)) : undefined,
    }
  } catch { return {} }
}

let entrySeq = 0
const nextId = () => ++entrySeq

export const createSessionStore = (runtimeId = "default") => defineStore(`session:${runtimeId}`, () => {
  const rpcRequest: typeof requestForRuntime = (command) => requestForRuntime(command, runtimeId)
  const started = ref(false)

  // ---- state ----
  const entries = ref<Entry[]>([])
  const runs = ref<Record<string, ToolRun>>({})
  /** In-progress assistant message being assembled from streaming deltas. */
  const partialBlocks = ref<Block[] | null>(null)
  const isStreaming = ref(false)
  let turnFailed = false
  let turnAborted = false
  /** errorMessage of the last failed assistant message; surfaced at settle. */
  let lastErrorMessage: string | null = null
  const isCompacting = ref(false)
  const retryInfo = ref<RetryInfo | null>(null)
  const promptQueue = ref<QueuedPrompt[]>([])
  const isResending = ref(false)
  let resendVersion = 0
  let stopping = false
  let queuePaused = false
  const steering = ref<string[]>([])
  const followUp = ref<string[]>([])
  const state = ref<SessionState | null>(null)
  /** File path of the active pi session (null until persisted). */
  const sessionFile = ref<string | null>(null)
  /** On-disk mtime at the last time our own view of the file was synced;
   *  a watcher event reporting a different value means an external edit. */
  const syncedSessionMtime = ref<number | null>(null)
  let mtimeSyncSeq = 0
  /** Re-read the session file's mtime from disk after loading our own history
   *  or after one of our own runs settles. */
  async function syncSessionFile() {
    const seq = ++mtimeSyncSeq
    const file = sessionFile.value
    if (!file) return
    try {
      const mtime = await sessionMtime(file)
      if (seq === mtimeSyncSeq && sessionFile.value === file)
        syncedSessionMtime.value = mtime
    } catch { /* file missing or unreadable; keep previous value */ }
  }
  /** Record a known mtime without hitting disk (e.g. after a rename via us). */
  function syncSessionMtime(mtime: number) {
    ++mtimeSyncSeq
    syncedSessionMtime.value = mtime
  }
  const stats = ref<SessionStats | null>(null)
  const lastUsage = ref<Usage | null>(null)
  const commands = ref<CommandInfo[]>([])
  const models = ref<Model[]>([])
  /** Explicit pre-start model choice, consumed once by init. */
  const remembered = ref<RememberedSelection>(readSelection())
  const desiredModelKey = ref<string | null>(null)
  let pendingModelChange: { from: string, to: string } | null = null
  const piDefaultModelKey = ref<string | null>(null)
  const offlineDefaultModelKey = computed(() => remembered.value.model
    ? `${remembered.value.model.provider}/${remembered.value.model.id}` : piDefaultModelKey.value)
  const offlineDefaultThinking = ref<ThinkingLevel | null>(null)
  const rpcThinkingLevels = ref<ThinkingLevel[]>(["off"])
  /** Per-model thinking levels derived from models.json while pi is down. */
  const offlineThinkingLevels = ref<Record<string, ThinkingLevel[]>>({})
  /** Explicit pre-start thinking choice, consumed once by init. */
  const desiredThinkingLevel = ref<ThinkingLevel | null>(null)
  const cwd = ref("")

  if (remembered.value.model) models.value = [remembered.value.model]
  let offlineLoadVersion = 0

  function remember(model?: Model, thinking?: ThinkingLevel, levels?: ThinkingLevel[]) {
    remembered.value = { ...remembered.value, ...(model ? { model: selectionModel(model) } : {}),
      ...(thinking ? { thinking } : {}), ...(levels ? { levels } : {}) }
    try { localStorage.setItem(SELECTION_KEY, JSON.stringify(remembered.value)) } catch { /* Optional UI preference. */ }
  }

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
    historyMessages.value = []
    pendingHistoryError.value = null
    historyCursor.value = 0
    historyLoading.value = false
    olderHistoryLoading.value = false
  }

  // streaming assembly

  const currentModel = computed(() => state.value?.model ?? null)
  /** RPC levels once pi runs; config-derived levels (of the desired model) before. */
  const availableThinking = computed<ThinkingLevel[]>(() => {
    if (state.value) return rpcThinkingLevels.value
    const key = desiredModelKey.value ?? offlineDefaultModelKey.value
    const saved = remembered.value.model
    if (saved && key === `${saved.provider}/${saved.id}` && remembered.value.levels?.length) return remembered.value.levels
    return (key && offlineThinkingLevels.value[key]) || ["off"]
  })
  const thinkingLevel = computed<ThinkingLevel>(() => {
    if (state.value) return clampThinkingLevel(state.value.thinkingLevel ?? remembered.value.thinking ?? DEFAULT_THINKING_LEVEL, availableThinking.value)
    return clampThinkingLevel(desiredThinkingLevel.value ?? remembered.value.thinking ?? offlineDefaultThinking.value ?? DEFAULT_THINKING_LEVEL, availableThinking.value)
  })
  const pendingCount = computed(() => promptQueue.value.length + steering.value.length + followUp.value.length)

  // A dispatched prompt reserves the next run before its agent_start arrives.
  let awaitingAgentStart = false
  let agentStartedAt: number | undefined
  /** Reserved entry id for the in-flight assistant turn. Assigned at the
   *  first assistant message_start and reused when the entry is committed, so
   *  the UI can key the streaming turn stably across completion. */
  const streamingTurnId = ref<number | null>(null)

  // ---- event ingestion ----
  function handleEvent(ev: Record<string, any>) {
    switch (ev.type) {
      case "scheduled_session_created":
        // This prompt is submitted by PiX's scheduler rather than the composer.
        entries.value.push({ kind: "user", id: nextId(), text: ev.prompt, timestamp: Date.now() })
        isStreaming.value = true
        awaitingAgentStart = true
        setSessionRunStatus(sessionFile.value, "running")
        break

      case "scheduled_session_failed":
        // Preflight can reject a prompt without ever emitting agent_start/settled.
        if (awaitingAgentStart) {
          awaitingAgentStart = false
          turnFailed = true
          lastErrorMessage = ev.error
          handleEvent({ type: "agent_settled" })
        }
        break

      case "agent_start":
        awaitingAgentStart = false
        agentStartedAt = Date.now()
        streamingTurnId.value = null
        isStreaming.value = true
        turnFailed = false
        turnAborted = false
        lastErrorMessage = null
        setSessionRunStatus(sessionFile.value, "running")
        break

      case "agent_end":
        // agent_end only ends one low-level run; auto-retry, overflow
        // compaction and queued continuations may still follow (pi flags
        // willRetry on the event). pi always emits agent_settled once it will
        // not continue on its own — finalize there, never here. Treating
        // agent_end as final also flips isStreaming off mid-run, which lets
        // the session-file watcher rebuild (kill) the still-working process.
        break

      case "agent_settled": {
        // A dispatched prompt reserves the next run; this settled belongs to
        // the previous one and must not drain another queued prompt.
        if (awaitingAgentStart && !stopping) break
        // A duplicate settled (pi emits one per prompt, pi-x used to
        // synthesize more) must not notify or drain the queue a second time.
        if (!isStreaming.value && !stopping) {
          pixLog("settled: ignored (not streaming)", runtimeId)
          break
        }
        retryInfo.value = null
        awaitingAgentStart = false
        isStreaming.value = false
        const finalStatus = turnAborted || stopping ? null : turnFailed ? "error" : "completed"
        pixLog(`settled: finalize status=${finalStatus ?? "none"} notify=${!turnAborted && !stopping} failed=${turnFailed} aborted=${turnAborted}`, runtimeId)
        setSessionRunStatus(sessionFile.value, finalStatus)
        // Error messages carry an empty content array, so a finally-failed run
        // would otherwise leave no trace in the conversation. Transient errors
        // that a retry recovered from never reach this point.
        if (finalStatus === "error" && lastErrorMessage) {
          entries.value.push({
            kind: "assistant",
            id: nextId(),
            blocks: [{ type: "text", text: errorBlockText(lastErrorMessage) }],
            live: true,
          })
        }
        if (!turnAborted && !stopping) {
          const workspace = useWorkspaceStore()
          const file = sessionFile.value
          const row = file ? workspace.histories[cwd.value]?.find(s => s.file === file) : undefined
          const project = cwd.value ? workspace.projectName(cwd.value) : ""
          const name = row?.title || row?.preview || ""
          notifyTurnComplete(name ? `${project} · ${name}` : project, turnFailed)
        }
        void refreshStats()
        void refreshState()
        // Our own worker just flushed the file; sync so watcher events for
        // this write are not mistaken for external edits.
        void syncSessionFile()
        if (!stopping && !queuePaused) dispatchQueuedPrompt()
        break
      }

      case "message_start": {
        const msg = ev.message
        if (msg?.role === "assistant") {
          streamingTurnId.value ??= nextId()
          partialBlocks.value = []
        }
        break
      }

      case "message_update": {
        const usage = ev.usage
        if (usage && usage.totalTokens)
          lastUsage.value = usage
        const delta = ev.assistantMessageEvent as AssistantMessageEvent | undefined
        if (!delta || !partialBlocks.value)
          break
        applyDelta(partialBlocks.value, delta)
        break
      }

      case "message_end": {
        const msg = ev.message
        if (msg?.role === "assistant") {
          // A successful response means the retried request recovered, even if
          // the runtime's matching auto_retry_end event is delayed.
          if (msg.stopReason !== "error" && msg.stopReason !== "aborted")
            retryInfo.value = null
          if (msg.stopReason === "error") { turnFailed = true; lastErrorMessage = msg.errorMessage ?? null }
          if (msg.stopReason === "aborted") turnAborted = true
          // authoritative replace
          const blocks = blocksFromMessage(msg)
          entries.value.push({ kind: "assistant", id: streamingTurnId.value ?? nextId(), blocks, live: true, startedAt: agentStartedAt, completedAt: Date.now() })
          if (msg.usage)
            lastUsage.value = msg.usage
        }
        // user / toolResult messages are rendered from local state + tool runs
        partialBlocks.value = null
        streamingTurnId.value = null
        break
      }

      case "tool_execution_start": {
        runs.value[ev.toolCallId] = {
          id: ev.toolCallId,
          name: ev.toolName,
          argsText: safeJson(ev.args),
          outputText: "",
          state: "input-available",
          startedAt: Date.now(),
        }
        break
      }

      case "tool_execution_update": {
        const run = runs.value[ev.toolCallId]
        if (run && ev.partialResult) {
          // partialResult is the accumulated output so far (per rpc.md)
          run.outputText = contentText(ev.partialResult.content)
        }
        break
      }

      case "tool_execution_end": {
        const run = runs.value[ev.toolCallId]
        if (run) {
          run.outputText = ev.result ? contentText(ev.result.content) : run.outputText
          run.state = ev.isError ? "output-error" : "output-available"
          run.completedAt = Date.now()
        }
        break
      }

      case "queue_update":
        steering.value = ev.steering ?? []
        followUp.value = ev.followUp ?? []
        break

      case "compaction_start":
        isCompacting.value = true
        break

      case "compaction_end": {
        isCompacting.value = false
        // Keep a visible marker at the position where history was collapsed.
        if (ev.result?.summary)
          entries.value.push({ kind: "compaction", id: nextId(), summary: String(ev.result.summary),
            tokensBefore: Number(ev.result.tokensBefore) || undefined,
            tokensAfter: Number(ev.result.estimatedTokensAfter) || undefined,
            timestamp: Date.now(), live: true })
        void refreshStats()
        // Pi flushed the compaction entry to the session file; sync our mtime
        // so the watcher does not mistake it for an external edit and rebuild.
        void syncSessionFile()
        if (!stopping && !queuePaused) dispatchQueuedPrompt()
        break
      }

      case "auto_retry_start":
        isStreaming.value = true
        setSessionRunStatus(sessionFile.value, "running")
        retryInfo.value = {
          attempt: Number(ev.attempt) || 1,
          maxAttempts: Number(ev.maxAttempts) || Number(ev.attempt) || 1,
          errorMessage: formatRetryError(ev.errorMessage),
        }
        break

      case "auto_retry_end": {
        if (ev.success) retryInfo.value = null
        else if (retryInfo.value) {
          retryInfo.value = {
            ...retryInfo.value,
            errorMessage: formatRetryError(ev.finalError ?? retryInfo.value.errorMessage),
          }
        }
        // A recovered provider error must not leave the turn marked failed.
        turnFailed = !ev.success
        if (!ev.success)
          void refreshState()
        // Do NOT synthesize agent_settled here: pi emits auto_retry_end at
        // the first healthy assistant message, which is usually mid-run, and
        // always follows with the real agent_settled when the run is done.
        break
      }

      case "extension_error":
        console.warn("[pi] extension error:", ev.extensionPath, ev.error)
        break
    }
  }

  function applyDelta(blocks: Block[], delta: AssistantMessageEvent) {
    const i = delta.contentIndex
    switch (delta.type) {
      case "text_start":
        blocks[i] = { type: "text", text: "" }
        break
      case "text_delta": {
        const b = ensure(blocks, i, "text") as TextBlock
        b.text += delta.delta
        break
      }
      case "text_end":
        if (delta.content !== undefined)
          blocks[i] = { type: "text", text: delta.content }
        break
      case "thinking_start":
        blocks[i] = { type: "thinking", text: "", streaming: true }
        break
      case "thinking_delta": {
        const b = ensure(blocks, i, "thinking") as ThinkingBlock
        b.text += delta.delta
        break
      }
      case "thinking_end": {
        const b = ensure(blocks, i, "thinking") as ThinkingBlock
        if (delta.thinking !== undefined)
          b.text = delta.thinking
        b.streaming = false
        break
      }
      case "toolcall_start":
        blocks[i] = { type: "toolCall", callId: delta.id, name: delta.toolName, argsText: "" }
        break
      case "toolcall_delta": {
        const b = ensure(blocks, i, "toolCall") as ToolCallBlock
        b.argsText += delta.delta
        break
      }
      case "toolcall_end": {
        const call = delta.toolCall
        blocks[i] = {
          type: "toolCall",
          callId: call.id,
          name: call.name,
          argsText: typeof call.arguments === "string"
            ? call.arguments
            : JSON.stringify(call.arguments ?? {}, null, 2),
        }
        break
      }
    }
  }

  function ensure(blocks: Block[], i: number, type: Block["type"]): Block {
    if (!blocks[i] || blocks[i].type !== type) {
      blocks[i] = type === "text"
        ? { type: "text", text: "" }
        : type === "thinking"
          ? { type: "thinking", text: "", streaming: true }
          : { type: "toolCall", callId: "unknown", name: "unknown", argsText: "" }
    }
    return blocks[i]
  }

  function blocksFromMessage(msg: any): Block[] {
    const out: Block[] = []
    for (const c of msg.content ?? []) {
      if (c.type === "text" && c.text)
        out.push({ type: "text", text: c.text })
      else if (c.type === "thinking" && c.thinking)
        out.push({ type: "thinking", text: c.thinking, streaming: false })
      else if (c.type === "toolCall")
        out.push({
          type: "toolCall",
          callId: c.id,
          name: c.name,
          argsText: typeof c.arguments === "string"
            ? c.arguments
            : JSON.stringify(c.arguments ?? {}, null, 2),
        })
    }
    return out
  }

  function safeJson(v: unknown): string {
    try {
      return JSON.stringify(v ?? {}, null, 2)
    }
    catch {
      return String(v)
    }
  }

  // ---- actions ----
  let conversationVersion = 0

  let queueTimer: ReturnType<typeof setTimeout> | undefined
  function armQueueTimer() {
    if (queueTimer !== undefined) clearTimeout(queueTimer)
    queueTimer = undefined
    const times = promptQueue.value.flatMap(item => item.sendAt && (!queuePaused || item.sendAt > Date.now()) ? [item.sendAt] : [])
    if (!times.length) return
    queueTimer = setTimeout(() => {
      queueTimer = undefined
      if (!queuePaused) dispatchQueuedPrompt()
      armQueueTimer()
    }, Math.min(Math.max(100, Math.min(...times) - Date.now()), 2_147_483_647))
  }

  function schedulePrompt(text: string, delayMs: number, images?: QueuedPrompt["images"], expandedText?: string) {
    if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > 365 * 24 * 60 * 60 * 1000)
      throw new Error(i18n.global.t("chat.invalidSendDelay"))
    if (!text.trim() && !images?.length) return
    promptQueue.value.push({ id: nextId(), text: text.trim(), images, expandedText, sendAt: Date.now() + delayMs })
    armQueueTimer()
  }

  function removeQueuedPrompt(id: number) {
    const index = promptQueue.value.findIndex(item => item.id === id)
    if (index < 0) return
    const item = promptQueue.value.splice(index, 1)[0]
    armQueueTimer()
    return item
  }

  function moveQueuedPrompt(id: number, targetId: number) {
    const from = promptQueue.value.findIndex(item => item.id === id)
    const to = promptQueue.value.findIndex(item => item.id === targetId)
    if (from < 0 || to < 0 || from === to) return
    promptQueue.value.splice(to, 0, promptQueue.value.splice(from, 1)[0])
  }

  function executeQueuedPrompt(id: number) {
    if (stopping || isResending.value || isCompacting.value) return
    const item = removeQueuedPrompt(id)
    if (item) void send(item.text, item.images, item.expandedText, "steer")
  }

  function dispatchQueuedPrompt() {
    if (isStreaming.value || stopping || isResending.value || isCompacting.value) return
    queuePaused = false
    const index = promptQueue.value.findIndex(item => !item.sendAt || item.sendAt <= Date.now())
    const next = index < 0 ? undefined : removeQueuedPrompt(promptQueue.value[index].id)
    if (next) void send(next.text, next.images, next.expandedText)
  }

  async function send(text: string, images?: { data: string, mimeType: string }[], expandedText?: string, behavior: "queue" | "steer" = "steer", replacement?: UserEntry) {
    const trimmed = text.trim()
    if (!trimmed && !images?.length)
      return
    // The desktop /compact command runs locally between runs; it can never be
    // steered into an active run, so queue it behind one instead.
    const compactMatch = /^\/compact(?:\s+([\s\S]*))?$/.exec(trimmed)
    if (compactMatch && !images?.length && !commands.value.some(command => command.name === "compact")) {
      if (isStreaming.value || stopping || isResending.value || isCompacting.value) {
        promptQueue.value.push({ id: nextId(), text: trimmed })
        return
      }
      try {
        await compact(compactMatch[1]?.trim() || undefined)
      }
      catch (e) {
        entries.value.push({ kind: "assistant", id: nextId(), blocks: [{ type: "text", text: `**${i18n.global.t("chat.errorLabel")}:** ${tBackendError(e)}` }], live: true })
      }
      // compaction_end also drains the queue; cover RPC failures that emit none.
      if (!stopping && !queuePaused) dispatchQueuedPrompt()
      return
    }
    if (isStreaming.value && behavior === "queue") {
      promptQueue.value.push({ id: nextId(), text: trimmed, images, expandedText })
      return
    }
    queuePaused = false
    const wasStreaming = isStreaming.value
    isStreaming.value = true
    if (!wasStreaming) { awaitingAgentStart = true; turnFailed = false; turnAborted = false }
    setSessionRunStatus(sessionFile.value, "running")
    const version = conversationVersion
    const firstMessage = !entries.value.some(entry => entry.kind === "user") && !(state.value?.messageCount)
    // Capture identity now: completion must never name a subsequently selected session.
    const titleFile = sessionFile.value
    const titleProject = cwd.value
    const titleSessionId = state.value?.sessionId
    const promptText = expandedText || trimmed || "(see attached image)"
    // Only a real question consumes the notice; queued prompts consume it when
    // dispatched, and slash commands leave it for the next question.
    const modelChange = trimmed.startsWith("/") ? undefined : pendingModelChange ?? undefined
    if (modelChange) pendingModelChange = null
    entries.value.push({ kind: "user", id: replacement?.id ?? nextId(), timestamp: Date.now(), text: trimmed, modelChange: modelChange ?? replacement?.modelChange, images: images?.map(im => ({ url: `data:${im.mimeType};base64,${im.data}` })), live: true })
    const command: Record<string, unknown> = { type: "prompt", message: promptText }
    if (images?.length)
      command.images = images.map(im => ({ type: "image", data: im.data, mimeType: im.mimeType }))
    if (wasStreaming)
      command.streamingBehavior = "steer"
    // resolves after the full run finishes; events drive the UI meanwhile
    rpcRequest(command)
      .then(async (res) => {
        if (!res.success) throw new Error(res.error ?? i18n.global.t("chat.promptRejected"))
      })
      .catch((e) => {
        if (version !== conversationVersion) return
        turnFailed = true
        setSessionRunStatus(sessionFile.value, "error")
        if (!wasStreaming) { awaitingAgentStart = false; isStreaming.value = false }
        entries.value.push({
          kind: "assistant",
          id: nextId(),
          blocks: [{ type: "text", text: `**${i18n.global.t("chat.errorLabel")}:** ${tBackendError(e)}` }],
          live: true,
        })
      })
      .finally(() => {
        if (version !== conversationVersion) return
        void refreshState()
        void refreshStats()
      })
    if (firstMessage && titleFile && titleSessionId) {
      const workspace = useWorkspaceStore()
      workspace.preview({ file: titleFile, id: titleSessionId, cwd: titleProject,
        mtimeMs: Date.now(), timestamp: new Date().toISOString(), preview: promptText.replace(/\s+/g, " ").slice(0, 120) })
      // Independent IPC call: do not await it or switch the active model.
      void generateSessionTitle(titleFile, promptText).then(async title => {
        if (title) workspace.generatedTitle(titleFile, title)
        await workspace.refresh(titleProject)
      }).catch(error => console.warn("[pi] title generation failed; keeping preview:", error))
    }
  }

  /** Replace the last question at its original position, without creating a session fork. */
  async function resendPrompt(text: string, images?: { data: string, mimeType: string }[], expandedText?: string) {
    if ((!text.trim() && !images?.length) || isResending.value) return
    let promptIndex = entries.value.length - 1
    while (promptIndex >= 0 && entries.value[promptIndex]?.kind !== "user") promptIndex--
    const original = entries.value[promptIndex] as UserEntry | undefined
    if (!original) return
    const operation = ++resendVersion
    let version = conversationVersion
    const file = sessionFile.value
    const assertCurrent = () => {
      if (version !== conversationVersion || file !== sessionFile.value)
        throw new Error(i18n.global.t("chat.editSessionChanged"))
    }
    isResending.value = true
    stopping = true
    queuePaused = true
    try {
      if (isStreaming.value || isCompacting.value || pendingCount.value > 0) {
        // Stop Pi's pending continuations from racing with the replacement question.
        // Keep them in the local queue rather than dropping the user's work.
        const queued = await rpcRequest<{ steering?: string[], followUp?: string[] }>({ type: "clear_queue" })
        assertCurrent()
        if (!queued.success) throw new Error(queued.error ?? i18n.global.t("chat.editStopFailed"))
        promptQueue.value.unshift(...[...(queued.data?.steering ?? []), ...(queued.data?.followUp ?? [])]
          .map(text => ({ id: nextId(), text })))
        steering.value = []
        followUp.value = []
        const aborted = await rpcRequest({ type: "abort" })
        assertCurrent()
        if (!aborted.success) throw new Error(aborted.error ?? i18n.global.t("chat.editStopFailed"))
      }
      // An abort response alone must not be treated as an idle event. Confirm it
      // before send(), otherwise the edited question could become steering text.
      const idle = await rpcRequest<SessionState>({ type: "get_state" })
      assertCurrent()
      if (!idle.success) throw new Error(idle.error ?? i18n.global.t("chat.editStopFailed"))
      if (!idle.data || idle.data.isStreaming || idle.data.isCompacting || idle.data.pendingMessageCount > 0)
        throw new Error(i18n.global.t("chat.editStopFailed"))
      if (idle.data.sessionFile !== file)
        throw new Error(i18n.global.t("chat.editSessionChanged"))
      const rewound = await rpcRequest({ type: "rewind_prompt", sessionFile: file })
      assertCurrent()
      if (!rewound.success) throw new Error(rewound.error ?? i18n.global.t("chat.editStopFailed"))
      const replaceIndex = entries.value.findIndex(entry => entry.id === original.id)
      if (replaceIndex < 0) throw new Error(i18n.global.t("chat.editSessionChanged"))
      entries.value.splice(replaceIndex)
      // Cached history also feeds the file-change summary; omit the old turn.
      let historyEnd = historyMessages.value.length - 1
      while (historyEnd >= 0 && historyMessages.value[historyEnd]?.role !== "user") historyEnd--
      if (!original.live && historyEnd >= historyCursor.value) historyMessages.value = historyMessages.value.slice(0, historyEnd)
      // Late completion/rejection of the interrupted prompt cannot mark the new
      // run failed or clear its streaming state.
      version = ++conversationVersion
      state.value = idle.data
      isStreaming.value = false
      isCompacting.value = false
      partialBlocks.value = null
      streamingTurnId.value = null
      retryInfo.value = null
      await send(text, images, expandedText, "steer", original)
    } finally {
      if (operation === resendVersion) {
        stopping = false
        isResending.value = false
      }
    }
  }

  /** Esc: take back queued messages, then abort. Returns text to restore. */
  async function abortAndRestore(): Promise<string> {
    stopping = true
    queuePaused = true
    const restored: string[] = []
    try {
      const res = await rpcRequest<{ steering?: string[], followUp?: string[] }>({ type: "clear_queue" })
      restored.push(...(res.data?.steering ?? []), ...(res.data?.followUp ?? []))
    }
    catch {
      // ignore
    }
    try {
      await rpcRequest({ type: "abort" })
    }
    catch {
      // ignore
    }
    try {
      await refreshState()
    } finally {
      turnAborted = true
      isStreaming.value = false
      setSessionRunStatus(sessionFile.value, null)
      stopping = false
    }
    return restored.join("\n")
  }

  async function newSession() {
    const result = await rpcRequest<{ cancelled?: boolean }>({ type: "new_session" })
    if (!result.success) throw new Error(result.error || i18n.global.t("chat.errors.newSession"))
    if (result.data?.cancelled) return
    ++conversationVersion
    invalidateHistory()
    pendingModelChange = null
    entries.value = []
    runs.value = {}
    partialBlocks.value = null
    streamingTurnId.value = null
    await refreshState()
    await applyRememberedSelection()
    await refreshStats()
  }

  async function compact(customInstructions?: string) {
    isCompacting.value = true
    try {
      const command: Record<string, unknown> = { type: "compact" }
      if (customInstructions)
        command.customInstructions = customInstructions
      const result = await rpcRequest(command)
      if (!result.success) throw new Error(result.error ?? i18n.global.t("chat.errors.compaction"))
    }
    finally {
      isCompacting.value = false
      await refreshStats()
    }
  }

  async function setModel(provider: string, modelId: string, recordChange = true) {
    const previous = pendingModelChange?.from ?? (state.value?.model && `${state.value.model.provider}/${state.value.model.id}`)
    const result = await rpcRequest({ type: "set_model", provider, modelId })
    if (!result.success) throw new Error(result.error || i18n.global.t("chat.errors.modelSwitch"))
    desiredModelKey.value = null
    // Pi appends a model_change entry to the session file. Mark this as our
    // own write before the file watcher can mistake it for an external edit
    // and restart the worker while the picker is still refreshing.
    await syncSessionFile()
    await refreshState()
    await refreshThinkingLevels()
    if (state.value?.model) {
      const current = `${state.value.model.provider}/${state.value.model.id}`
      if (recordChange && started.value && previous)
        pendingModelChange = previous === current ? null : { from: previous, to: current }
      remember(state.value.model, state.value.thinkingLevel, rpcThinkingLevels.value)
    }
  }

  /** Record a model choice made while pi is not running; applied on init. */
  function setDesiredModel(key: string | null) {
    desiredModelKey.value = key
    const model = models.value.find(m => `${m.provider}/${m.id}` === key)
    if (model) remember(model, undefined, supportedThinkingLevels(model))
  }

  async function setThinkingLevel(level: ThinkingLevel) {
    const result = await rpcRequest({ type: "set_thinking_level", level })
    if (!result.success) throw new Error(result.error || i18n.global.t("chat.errors.thinkingSwitch"))
    desiredThinkingLevel.value = null
    // Changing thinking level also appends to the session log.
    await syncSessionFile()
    await refreshState()
    await refreshThinkingLevels()
    remember(state.value?.model ?? undefined, state.value?.thinkingLevel ?? level, rpcThinkingLevels.value)
  }

  /** Record a thinking level picked while pi is not running; applied on init. */
  function setDesiredThinkingLevel(level: ThinkingLevel) {
    desiredThinkingLevel.value = level
    remember(undefined, level)
  }

  // ---- queries ----
  async function refreshState() {
    const res = await rpcRequest<SessionState & { sessionFile?: string }>({ type: "get_state" })
    if (res.success && res.data) {
      state.value = res.data
      sessionFile.value = res.data.sessionFile ?? null
    }
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
      const page: Entry[] = []
      const pageRuns: Record<string, ToolRun> = {}
      for (let i = start; i < end; i++) {
        if (version !== historyVersion) return
        const msg = source[i]
        if (msg.role === "user") {
          const text = contentText(msg.content)
          const images = Array.isArray(msg.content)
            ? msg.content.filter((c: any) => c.type === "image" && c.data && c.mimeType)
              .map((c: any) => ({ url: `data:${c.mimeType};base64,${c.data}` }))
            : []
          if (text.trim() || images.length)
            page.push({ kind: "user", id: nextId(), text, images, timestamp: msg.timestamp })
        }
        else if (msg.role === "assistant") {
          // Failed responses persist with empty content and are dropped here;
          // loadHistory surfaces the final turn's failure separately at the end.
          const blocks = blocksFromMessage(msg)
          if (blocks.length) page.push({ kind: "assistant", id: nextId(), blocks, timestamp: msg.timestamp })
        }
        else if (msg.role === "compactionSummary" && typeof msg.summary === "string")
          page.push({ kind: "compaction", id: nextId(), summary: msg.summary,
            tokensBefore: typeof msg.tokensBefore === "number" ? msg.tokensBefore : undefined,
            tokensAfter: typeof msg.estimatedTokensAfter === "number" ? msg.estimatedTokensAfter : undefined,
            timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined })
        else if (msg.role === "toolResult") {
          const callId = String(msg.toolCallId ?? msg.id ?? "")
          if (callId) pageRuns[callId] = {
            id: callId, name: "tool", argsText: "",
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
    }
    finally {
      if (version === historyVersion) olderHistoryLoading.value = false
    }
  }

  /** Append the file-recorded stop reason after the loaded conversation. */
  function placePendingHistoryError() {
    const pending = pendingHistoryError.value
    if (!pending) return
    pendingHistoryError.value = null
    entries.value = [...entries.value, {
      kind: "assistant",
      id: nextId(),
      blocks: [{ type: "text", text: errorBlockText(pending.errorMessage) }],
      timestamp: typeof pending.timestamp === "number" ? pending.timestamp : undefined,
    }]
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
    try { last = await sessionLastError(file) }
    catch { return } // file unreadable (e.g. browser preview); history still works
    if (version !== historyVersion || !last?.errorMessage) return
    // Only a failure at the end of the current transcript counts as the stop
    // reason. A later message means the retry recovered and the turn continued
    // (or the user prompted again), so the failure is historical.
    const ts = last.timestamp
    if (typeof ts === "number" && historyMessages.value.some(m =>
      typeof m?.timestamp === "number" && m.timestamp > ts)) return
    pendingHistoryError.value = last
  }

  async function loadMessages(msgs: any[]) {
    ++conversationVersion
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
        }
        catch { /* fall back to the RPC projection below */ }
      }
      if (version !== historyVersion) return
      if (!msgs) {
        const res = await rpcRequest<{ messages: any[] }>({ type: "get_messages" })
        if (version !== historyVersion) return
        if (!res.success) throw new Error(res.error || "Failed to load history")
        msgs = res.data?.messages ?? []
      }
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
    }
    finally {
      if (version === historyVersion) historyLoading.value = false
    }
  }

  async function refreshStats() {
    const res = await rpcRequest<SessionStats>({ type: "get_session_stats" })
    if (res.success && res.data)
      stats.value = res.data
  }

  let commandRequestVersion = 0
  async function refreshCommands() {
    const version = ++commandRequestVersion
    const res = await rpcRequest<{ commands: Array<CommandInfo & {
      sourceInfo?: { path?: string, scope?: "user" | "project" | "temporary" }
    }> }>({ type: "get_commands" })
    if (version !== commandRequestVersion) return
    if (!res.success) throw new Error(res.error ?? "Failed to load commands")
    // Pi nests the resource file path in `sourceInfo` instead of a top-level
    // `path`; flatten it so the loaded-skills list and "import loaded" work.
    commands.value = (res.data?.commands ?? []).map(({ sourceInfo, ...command }) => ({
      ...command,
      path: command.path ?? sourceInfo?.path,
      location: command.location
        ?? (sourceInfo?.scope === "user" || sourceInfo?.scope === "project" ? sourceInfo.scope : undefined),
    }))
  }

  async function refreshModels() {
    const res = await rpcRequest<{ models: Model[] }>({ type: "get_available_models" })
    if (res.success && res.data)
      models.value = res.data.models ?? []
  }

  async function refreshThinkingLevels() {
    const res = await rpcRequest<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" })
    if (res.success && res.data)
      rpcThinkingLevels.value = res.data.levels ?? ["off"]
  }

  /** Fill the model picker from ~/.pi/agent/models.json while pi is down. */
  async function loadOfflineModels() {
    const version = ++offlineLoadVersion
    try {
      const [config, settings] = await Promise.all([getModelsConfig(), getPiSettings()])
      const offline: Model[] = []
      const levels: Record<string, ThinkingLevel[]> = {}
      for (const [provider, entry] of Object.entries(config.providers ?? {})) {
        for (const m of entry.models ?? []) {
          offline.push({
            id: m.id,
            name: m.name ?? m.id,
            api: m.api ?? entry.api ?? "",
            provider,
            baseUrl: entry.baseUrl ?? "",
            reasoning: m.reasoning ?? false,
            input: m.input ?? ["text"],
            contextWindow: m.contextWindow ?? 0,
            maxTokens: m.maxTokens ?? 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })
          levels[`${provider}/${m.id}`] = supportedThinkingLevels(m)
        }
      }
      if (version !== offlineLoadVersion || state.value) return
      const saved = remembered.value.model
      if (saved && !offline.some(m => m.provider === saved.provider && m.id === saved.id)) offline.unshift(saved)
      models.value = offline
      offlineThinkingLevels.value = levels
      piDefaultModelKey.value = settings.defaultProvider && settings.defaultModel
        ? `${settings.defaultProvider}/${settings.defaultModel}` : offline[0] ? `${offline[0].provider}/${offline[0].id}` : null
      const key = desiredModelKey.value ?? offlineDefaultModelKey.value
      offlineDefaultThinking.value = (key && settings.modelThinkingLevels?.[key]) || settings.defaultThinkingLevel || null
    } catch (e) {
      console.warn("[pi] failed to load offline models:", e)
    }
  }

  async function applyRememberedSelection() {
    // Snapshot both choices: setModel may update Pi's effective thinking level.
    const savedModel = remembered.value.model
    const modelKey = desiredModelKey.value ?? (savedModel ? `${savedModel.provider}/${savedModel.id}` : null)
    const level = desiredThinkingLevel.value ?? remembered.value.thinking
    desiredModelKey.value = null
    desiredThinkingLevel.value = null
    if (modelKey && `${state.value?.model?.provider}/${state.value?.model?.id}` !== modelKey) {
      const [provider, ...rest] = modelKey.split("/")
      await setModel(provider, rest.join("/"), false).catch(e => console.warn("[pi] remembered model unavailable:", e))
    }
    await refreshThinkingLevels()
    if (level) {
      const supported = clampThinkingLevel(level, availableThinking.value)
      if (supported !== state.value?.thinkingLevel) await setThinkingLevel(supported)
    }
    if (state.value?.model) remember(state.value.model, state.value.thinkingLevel, rpcThinkingLevels.value)
  }

  async function init(project: string, fresh = false) {
    ++offlineLoadVersion
    cwd.value = project
    await Promise.all([refreshState(), refreshCommands(), refreshModels(), refreshStats()])
    await refreshThinkingLevels()
    if (fresh) await applyRememberedSelection()
    else {
      // A restored session is authoritative, even when an offline draft had choices.
      desiredModelKey.value = null
      desiredThinkingLevel.value = null
    }
  }

  function clear() {
    pendingModelChange = null
    agentStartedAt = undefined
    turnFailed = false
    turnAborted = false
    lastErrorMessage = null
    awaitingAgentStart = false
    promptQueue.value = []
    if (queueTimer !== undefined) clearTimeout(queueTimer)
    queueTimer = undefined
    stopping = false
    ++resendVersion
    isResending.value = false
    queuePaused = false
    isStreaming.value = false
    isCompacting.value = false
    retryInfo.value = null
    sessionFile.value = null
    syncedSessionMtime.value = null
    ++mtimeSyncSeq
    ++offlineLoadVersion
    ++conversationVersion
    invalidateHistory()
    entries.value = []
    runs.value = {}
    partialBlocks.value = null
    streamingTurnId.value = null
    steering.value = []
    followUp.value = []
    state.value = null
    stats.value = null
    lastUsage.value = null
    ++commandRequestVersion
    commands.value = []
  }

  /** Timeline turns across the whole session, including turns whose history
   * pages are not materialized yet (they carry a synthetic negative id). */
  const timelineTurns = computed<TimelineTurn[]>(() =>
    buildTimelineTurns(historyMessages.value, historyCursor.value, entries.value))

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
    const resolved = loaded[loaded.length - 1 - fromEnd]
      ?? [...loaded].reverse().find(t => t.entryId != null && t.question === turns[index].question)
    return resolved?.entryId ?? null
  }

  return {
    runtimeId,
    started,
    entries,
    fileChanges: computed(() => sessionChanges(historyMessages.value, entries.value, partialBlocks.value, runs.value)),
    timelineTurns,
    revealTimelineTurn,
    runs,
    partialBlocks,
    streamingTurnId,
    isStreaming,
    markInterrupted: () => {
      pixLog(`interrupted: streaming=${isStreaming.value}`, runtimeId)
      if (!isStreaming.value) return
      setSessionRunStatus(sessionFile.value, "error")
      // The sidebar badge alone does not explain what happened; leave a
      // visible note in the conversation itself.
      entries.value.push({
        kind: "assistant",
        id: nextId(),
        blocks: [{ type: "text", text: i18n.global.t("chat.processExited") }],
        live: true,
      })
    },
    markRunning: () => setSessionRunStatus(sessionFile.value, "running"),
    isCompacting,
    retryInfo,
    steering,
    followUp,
    state,
    stats,
    lastUsage,
    commands,
    models,
    desiredModelKey,
    offlineDefaultModelKey,
    desiredThinkingLevel,
    availableThinking,
    cwd,
    sessionFile,
    syncedSessionMtime,
    syncSessionFile,
    syncSessionMtime,
    currentModel,
    thinkingLevel,
    pendingCount,
    promptQueue,
    schedulePrompt,
    removeQueuedPrompt,
    moveQueuedPrompt,
    executeQueuedPrompt,
    dispatchQueuedPrompt,
    handleEvent,
    send,
    abortAndRestore,
    resendPrompt,
    isResending,
    newSession,
    compact,
    setModel,
    setDesiredModel,
    setThinkingLevel,
    setDesiredThinkingLevel,
    refreshState,
    refreshStats,
    refreshModels,
    refreshCommands,
    loadOfflineModels,
    historyLoading,
    olderHistoryLoading,
    hasOlderHistory,
    loadOlderHistory,
    loadHistory,
    loadMessages,
    init,
    clear,
  }
})
