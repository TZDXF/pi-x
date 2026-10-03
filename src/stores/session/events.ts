import { i18n, tBackendError } from "@/i18n"
import { pixLog } from "@/api/piClient"
import { contentText } from "@/lib/content"
import { builtinExtensionPath } from "@/lib/extensionNames"
import { notifyTurnComplete } from "@/lib/notifications"
import { setSessionRunStatus } from "@/stores/sessionRunStatus"
import { useWorkspaceStore } from "@/stores/workspace"
import type { Ref } from "vue"
import type { AssistantMessageEvent, Usage } from "@/api/protocol"
import type { Block, Entry, RetryInfo, SessionFlow, TextBlock, ThinkingBlock, ToolCallBlock, ToolRun } from "./types"

/** Keep the status code but unwrap JSON error payloads emitted by providers. */
export function formatRetryError(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return ""
  const match = raw.match(/^(\d{3})\s*:\s*(\{[\s\S]*\})$/)
  const status = match?.[1]
  const json = match?.[2] ?? raw
  try {
    const parsed = JSON.parse(json)
    const inner = typeof parsed?.error?.message === "string" ? parsed.error.message : parsed?.message
    if (typeof inner === "string" && inner.trim()) return status ? `${status} · ${inner.trim()}` : inner.trim()
  } catch {
    /* keep the original provider error */
  }
  return raw
}

/** Shared phrasing between the live settle entry and history rendering. */
export function errorBlockText(message: string): string {
  return `**${i18n.global.t("chat.errorLabel")}:** ${formatRetryError(message)}`
}

export function applyDelta(blocks: Block[], delta: AssistantMessageEvent) {
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
      if (delta.content !== undefined) blocks[i] = { type: "text", text: delta.content }
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
      if (delta.thinking !== undefined) b.text = delta.thinking
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
        argsText: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}, null, 2),
      }
      break
    }
  }
}

function ensure(blocks: Block[], i: number, type: Block["type"]): Block {
  if (!blocks[i] || blocks[i].type !== type) {
    blocks[i] =
      type === "text"
        ? { type: "text", text: "" }
        : type === "thinking"
          ? { type: "thinking", text: "", streaming: true }
          : { type: "toolCall", callId: "unknown", name: "unknown", argsText: "" }
  }
  return blocks[i]
}

export function blocksFromMessage(msg: any): Block[] {
  const out: Block[] = []
  for (const c of msg.content ?? []) {
    if (c.type === "text" && c.text) out.push({ type: "text", text: c.text })
    else if (c.type === "thinking" && c.thinking) out.push({ type: "thinking", text: c.thinking, streaming: false })
    else if (c.type === "toolCall")
      out.push({
        type: "toolCall",
        callId: c.id,
        name: c.name,
        argsText: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}, null, 2),
      })
  }
  return out
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {}, null, 2)
  } catch {
    return String(v)
  }
}

// ---- session entry ingestion (entry_appended) ----

/** Entry types pi already reports through dedicated events or that are pure
 *  bookkeeping; they must never surface as conversation noise. */
const IGNORED_ENTRY_TYPES = new Set([
  "session",
  "message",
  "compaction",
  "model_change",
  "thinking_level_change",
  "branch_summary",
  "label",
  "session_info",
  "usage",
  "custom_message",
])
/** Custom entries with their own render path or known-internal state.
 *  `codemode-store` is pi's builtin codemode extension persisting script
 *  `store()` writes; the values are only meaningful to later scripts. */
const IGNORED_CUSTOM_TYPES = new Set(["pi.virtual-model-state", "pix-file-change", "codemode-store"])

/**
 * Map one raw session entry delivered by RPC `entry_appended` to a UI entry;
 * null means "skip silently". `context_edit` becomes a light marker, unknown
 * extension entries (e.g. "pi.bug-report") become low-key placeholders, and
 * everything else is ignored without breaking the conversation flow.
 */
export function uiEntryFromAppendedEntry(raw: any, id: number, timestamp: number): Entry | null {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return null
  if (raw.type === "context_edit")
    return {
      kind: "context_edit",
      id,
      targetId: typeof raw.targetId === "string" ? raw.targetId : "",
      replaced: raw.replacement != null,
      timestamp,
      live: true,
    }
  if (IGNORED_ENTRY_TYPES.has(raw.type)) return null
  if (raw.type === "custom") {
    const customType = typeof raw.customType === "string" ? raw.customType : ""
    if (!customType || IGNORED_CUSTOM_TYPES.has(customType)) return null
    return { kind: "custom", id, customType, timestamp, live: true }
  }
  return { kind: "custom", id, customType: raw.type, timestamp, live: true }
}

/** Reactive state and store callbacks the event handler needs. */
export interface EventContext {
  runtimeId: string
  entries: Ref<Entry[]>
  runs: Ref<Record<string, ToolRun>>
  partialBlocks: Ref<Block[] | null>
  isStreaming: Ref<boolean>
  isCompacting: Ref<boolean>
  retryInfo: Ref<RetryInfo | null>
  steering: Ref<string[]>
  followUp: Ref<string[]>
  lastUsage: Ref<Usage | null>
  streamingTurnId: Ref<number | null>
  sessionFile: Ref<string | null>
  cwd: Ref<string>
  flow: SessionFlow
  nextId: () => number
  refreshStats: () => Promise<void>
  refreshState: () => Promise<void>
  syncSessionFile: () => Promise<void>
  dispatchQueuedPrompt: () => void
  /** 轮次 Git 快照：agent_start 建开始快照，settled 建结束快照并计算差异。 */
  checkpointStart: () => void
  checkpointSettle: () => void
  /** Extension custom entry (e.g. exact file before/after artifact). */
  customEntryAppended: (entry: any) => void
}

// ---- event ingestion ----
export function createEventHandler(ctx: EventContext) {
  const {
    runtimeId,
    entries,
    runs,
    partialBlocks,
    isStreaming,
    isCompacting,
    retryInfo,
    steering,
    followUp,
    lastUsage,
    streamingTurnId,
    sessionFile,
    cwd,
    flow,
    nextId,
    refreshStats,
    refreshState,
    syncSessionFile,
    dispatchQueuedPrompt,
    checkpointStart,
    checkpointSettle,
    customEntryAppended,
  } = ctx

  function handleEvent(ev: Record<string, any>) {
    switch (ev.type) {
      case "scheduled_session_created":
        // This prompt is submitted by PiX's scheduler rather than the composer.
        entries.value.push({ kind: "user", id: nextId(), text: ev.prompt, timestamp: Date.now() })
        isStreaming.value = true
        flow.awaitingAgentStart = true
        setSessionRunStatus(sessionFile.value, "running")
        break

      case "scheduled_session_failed":
        // Preflight can reject a prompt without ever emitting agent_start/settled.
        if (flow.awaitingAgentStart) {
          flow.awaitingAgentStart = false
          flow.turnFailed = true
          flow.lastErrorMessage = tBackendError(ev.error)
          handleEvent({ type: "agent_settled" })
        }
        break

      case "agent_start":
        flow.awaitingAgentStart = false
        flow.agentStartedAt = Date.now()
        streamingTurnId.value = null
        isStreaming.value = true
        flow.turnFailed = false
        flow.turnAborted = false
        flow.lastErrorMessage = null
        setSessionRunStatus(sessionFile.value, "running")
        checkpointStart()
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
        if (flow.awaitingAgentStart && !flow.stopping) break
        // A duplicate settled (pi emits one per prompt, pi-x used to
        // synthesize more) must not notify or drain the queue a second time.
        if (!isStreaming.value && !flow.stopping) {
          pixLog("settled: ignored (not streaming)", runtimeId)
          break
        }
        retryInfo.value = null
        flow.awaitingAgentStart = false
        isStreaming.value = false
        const finalStatus = flow.turnAborted || flow.stopping ? null : flow.turnFailed ? "error" : "completed"
        pixLog(
          `settled: finalize status=${finalStatus ?? "none"} notify=${!flow.turnAborted && !flow.stopping} failed=${flow.turnFailed} aborted=${flow.turnAborted}`,
          runtimeId,
        )
        setSessionRunStatus(sessionFile.value, finalStatus)
        // Error messages carry an empty content array, so a finally-failed run
        // would otherwise leave no trace in the conversation. Transient errors
        // that a retry recovered from never reach this point.
        if (finalStatus === "error" && flow.lastErrorMessage) {
          entries.value.push({
            kind: "assistant",
            id: nextId(),
            blocks: [{ type: "text", text: errorBlockText(flow.lastErrorMessage) }],
            live: true,
          })
        }
        if (!flow.turnAborted && !flow.stopping) {
          const workspace = useWorkspaceStore()
          const file = sessionFile.value
          const row = file ? workspace.histories[cwd.value]?.find(s => s.file === file) : undefined
          const project = cwd.value ? workspace.projectName(cwd.value) : ""
          const name = row?.title || row?.preview || ""
          notifyTurnComplete(name ? `${project} · ${name}` : project, flow.turnFailed)
        }
        void refreshStats()
        void refreshState()
        // Turn snapshot: record the files changed during this round (including partial changes from aborted rounds), for the summary card and git rollback.
        checkpointSettle()
        // Our own worker just flushed the file; sync so watcher events for
        // this write are not mistaken for external edits.
        void syncSessionFile()
        if (!flow.stopping && !flow.queuePaused) dispatchQueuedPrompt()
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
        if (usage && usage.totalTokens) lastUsage.value = usage
        const delta = ev.assistantMessageEvent as AssistantMessageEvent | undefined
        if (!delta) break
        // Streaming content proves the retried request has recovered; keep the
        // banner only while nothing is coming back (pi may not report
        // auto_retry_end until the first message ends, if at all).
        retryInfo.value = null
        if (!partialBlocks.value) break
        applyDelta(partialBlocks.value, delta)
        break
      }

      case "message_end": {
        const msg = ev.message
        if (msg?.role === "assistant") {
          // A successful response means the retried request recovered, even if
          // the runtime's matching auto_retry_end event is delayed.
          if (msg.stopReason !== "error" && msg.stopReason !== "aborted") retryInfo.value = null
          if (msg.stopReason === "error") {
            flow.turnFailed = true
            flow.lastErrorMessage = msg.errorMessage ?? null
          }
          if (msg.stopReason === "aborted") flow.turnAborted = true
          // authoritative replace
          const blocks = blocksFromMessage(msg)
          // Failed attempts persist with empty content and history replay drops
          // them; pushing an empty live entry would only split the turn into
          // extra bubbles (final failures are surfaced at agent_settled).
          if (blocks.length)
            entries.value.push({
              kind: "assistant",
              id: streamingTurnId.value ?? nextId(),
              blocks,
              live: true,
              startedAt: flow.agentStartedAt,
              completedAt: Date.now(),
            })
          if (msg.usage) lastUsage.value = msg.usage
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

      case "entry_appended": {
        // pi emits this for every session entry appended by extensions or
        // internal subsystems (context edits, cache warming, bug reports...).
        // File-change artifacts keep flowing to their merger; only what the
        // conversation should show is materialized as a UI entry.
        customEntryAppended(ev.entry)
        const entry = uiEntryFromAppendedEntry(ev.entry, nextId(), Date.now())
        if (entry) entries.value.push(entry)
        break
      }

      case "compaction_start":
        isCompacting.value = true
        break

      case "compaction_end": {
        isCompacting.value = false
        // Keep a visible marker at the position where history was collapsed.
        if (ev.result?.summary)
          entries.value.push({
            kind: "compaction",
            id: nextId(),
            summary: String(ev.result.summary),
            tokensBefore: Number(ev.result.tokensBefore) || undefined,
            tokensAfter: Number(ev.result.estimatedTokensAfter) || undefined,
            timestamp: Date.now(),
            live: true,
          })
        void refreshStats()
        // Pi flushed the compaction entry to the session file; sync our mtime
        // so the watcher does not mistake it for an external edit and rebuild.
        void syncSessionFile()
        if (!flow.stopping && !flow.queuePaused) dispatchQueuedPrompt()
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
        flow.turnFailed = !ev.success
        if (!ev.success) void refreshState()
        // Do NOT synthesize agent_settled here: pi emits auto_retry_end at
        // the first healthy assistant message, which is usually mid-run, and
        // always follows with the real agent_settled when the run is done.
        break
      }

      case "extension_error": {
        // Built-in extensions report a `builtin:<name>` pseudo-path; older pi
        // versions used `<builtin:name>` / `<inline:name>`.
        const path = typeof ev.extensionPath === "string" ? ev.extensionPath : ""
        console.warn("[pi] extension error:", path && builtinExtensionPath(path), ev.error)
        break
      }
    }
  }

  return handleEvent
}
