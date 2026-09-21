/**
 * Types for pi's RPC protocol (`pi --mode rpc`).
 * Mirrors pi docs/rpc.md — subset used by the desktop client.
 */

export interface RpcResponse<T = unknown> {
  id?: number
  type: "response"
  command: string
  success: boolean
  data?: T
  error?: string
}

export interface Model {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
  cost: { input: number, output: number, cacheRead: number, cacheWrite: number }
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number, output: number, cacheRead: number, cacheWrite: number, total: number }
}

export interface SessionState {
  model: Model | null
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: "one-at-a-time" | "all"
  followUpMode: "one-at-a-time" | "all"
  sessionFile: string | null
  sessionId: string
  sessionName?: string
  messageCount: number
  pendingMessageCount: number
}

export interface SessionStats {
  sessionId: string
  sessionFile: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  totalMessages: number
  tokens: { input: number, output: number, cacheRead: number, cacheWrite: number, total: number }
  cost: number
  contextUsage: { tokens: number, contextWindow: number, percent: number } | null
}

export interface CommandInfo {
  name: string
  description?: string
  source: "extension" | "prompt" | "skill"
  location?: "user" | "project" | "path"
  path?: string
}

export interface TextContent { type: "text", text: string }
export interface ImageContent { type: "image", data: string, mimeType: string }
export interface ThinkingContent { type: "thinking", thinking: string }
export interface ToolCallContent { type: "toolCall", id: string, name: string, arguments: Record<string, unknown> | string }
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent

export interface UserMessage {
  role: "user"
  content: string | Array<TextContent | ImageContent>
  timestamp?: number
  attachments?: unknown[]
}

export interface AssistantMessage {
  role: "assistant"
  content: AssistantContent[]
  api?: string
  provider?: string
  model?: string
  usage?: Usage
  stopReason?: string
  errorMessage?: string
  timestamp?: number
}

export type AgentMessage = UserMessage | AssistantMessage
  | { role: "toolResult", [k: string]: unknown }
  | { role: "bashExecution", [k: string]: unknown }

// ---- streaming delta events (assistantMessageEvent) ----

export type AssistantMessageEvent =
  | { type: "text_start", contentIndex: number }
  | { type: "text_delta", contentIndex: number, delta: string }
  | { type: "text_end", contentIndex: number, content?: string }
  | { type: "thinking_start", contentIndex: number }
  | { type: "thinking_delta", contentIndex: number, delta: string }
  | { type: "thinking_end", contentIndex: number, thinking?: string }
  | { type: "toolcall_start", contentIndex: number, id: string, toolName: string }
  | { type: "toolcall_delta", contentIndex: number, delta: string }
  | { type: "toolcall_end", contentIndex: number, toolCall: ToolCallContent }

// ---- extension UI sub-protocol ----

export type ExtensionUiMethod =
  | "select" | "confirm" | "input" | "editor"
  | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"

export interface ExtensionUiRequest {
  type: "extension_ui_request"
  id: string
  method: ExtensionUiMethod
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
  notifyType?: "info" | "warning" | "error"
  statusKey?: string
  statusText?: string
  widgetKey?: string
  widgetLines?: string[]
  widgetPlacement?: "aboveEditor" | "belowEditor"
  text?: string
}

export interface ExtensionUiResponse {
  type: "extension_ui_response"
  id: string
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}
