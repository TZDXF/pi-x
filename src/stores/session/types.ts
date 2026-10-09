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

export interface TextBlock {
  type: "text"
  text: string
}
export interface ThinkingBlock {
  type: "thinking"
  text: string
  streaming: boolean
}
export interface ToolCallBlock {
  type: "toolCall"
  callId: string
  name: string
  argsText: string
}
/** Operational errors are never markdown or reasoning content. */
export interface ErrorBlock {
  type: "error"
  text: string
}
export type Block = TextBlock | ThinkingBlock | ToolCallBlock | ErrorBlock

export interface QueuedPrompt {
  id: number
  text: string
  images?: { data: string; mimeType: string }[]
  expandedText?: string
  sendAt?: number
}

export interface UserEntry {
  kind: "user"
  id: number
  text: string
  modelChange?: { from: string; to: string }
  images?: { url: string }[]
  live?: true
  timestamp?: number
  turnIndex?: number
}
export interface AssistantEntry {
  kind: "assistant"
  id: number
  blocks: Block[]
  failed?: boolean
  live?: true
  startedAt?: number
  completedAt?: number
  timestamp?: number
}
/** Marks where a compaction collapsed earlier history; summary stays expandable. */
export interface CompactionEntry {
  kind: "compaction"
  id: number
  summary: string
  tokensBefore?: number
  tokensAfter?: number
  timestamp?: number
  live?: true
}
/** pi ≥0.87: append-only edit of an earlier context-producing entry. It only
 *  affects future model context; the target entry, raw history, the rendered
 *  conversation and session statistics stay unchanged. */
export interface ContextEditEntry {
  kind: "context_edit"
  id: number
  /** Session entry id of the edited message. */
  targetId: string
  /** true = the target content was replaced; false = the target is omitted
   *  from the model context from now on. */
  replaced: boolean
  timestamp?: number
  live?: true
}
/** Model switch (pi model_change entry); rendered as a divider. */
export interface ModelChangeEntry {
  kind: "model_change"
  id: number
  provider: string
  modelId: string
  timestamp?: number
  live?: true
}
export type Entry = (UserEntry | AssistantEntry | CompactionEntry | ContextEditEntry | ModelChangeEntry) & {
  turnIndex?: number
}

export interface RetryInfo {
  attempt: number
  maxAttempts: number
  errorMessage: string
}

/**
 * Mutable run-flow flags shared by event ingestion (events.ts) and the prompt
 * actions in the store. Plain (non-reactive) on purpose: they coordinate
 * control flow, none of them is rendered directly.
 */
export interface SessionFlow {
  /** Last assistant message failed; surfaced as an error entry at settle. */
  turnFailed: boolean
  turnAborted: boolean
  /** errorMessage of the last failed assistant message; surfaced at settle. */
  lastErrorMessage: string | null
  /** A dispatched prompt reserves the next run before its agent_start arrives. */
  awaitingAgentStart: boolean
  agentStartedAt: number | undefined
  /** Suppresses settle side effects (notifications, queue dispatch) while the
   *  store is aborting or replacing a prompt. */
  stopping: boolean
  /** Queue dispatch paused while edits or aborts own the session. */
  queuePaused: boolean
}
