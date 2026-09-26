/**
 * Estimate how the context window is divided between the system prompt,
 * tool definitions, and message history.
 *
 * pi's RPC only reports the aggregate `contextUsage`; the split is estimated
 * client-side from the projected messages (`get_messages`), using the same
 * chars-per-token heuristic pi itself uses when provider usage is
 * unavailable (see estimateTokens in pi's compaction module).
 */

export type ContextBreakdownKey = "systemPrompt" | "toolDefinitions" | "messageHistory"

export interface ContextBreakdownEstimate {
  systemPrompt: number
  toolDefinitions: number
  messageHistory: number
  total: number
}

export interface ContextBreakdownPart {
  key: ContextBreakdownKey
  /** Estimated tokens; scaled to the actual context total when available. */
  tokens: number
  /** Share of the context, 0..1. */
  percent: number
}

const CHARS_PER_TOKEN = 4
// Mirrors pi's ESTIMATED_IMAGE_CHARS for image blocks.
const ESTIMATED_IMAGE_CHARS = 4800
const TOOLS_SECTION = "tools"

function textAndImageChars(content: unknown): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string")
      chars += block.text.length
    else if (block?.type === "image")
      chars += ESTIMATED_IMAGE_CHARS
  }
  return chars
}

function assistantChars(content: unknown): number {
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string")
      chars += block.text.length
    else if (block?.type === "thinking" && typeof block.thinking === "string")
      chars += block.thinking.length
    else if (block?.type === "toolCall")
      chars += String(block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length
  }
  return chars
}

/** Characters for one projected message, matching pi's estimateTokens cases. */
function messageChars(message: any): number {
  switch (message?.role) {
    case "user":
    case "toolResult":
    case "custom":
      return textAndImageChars(message.content)
    case "assistant":
      return assistantChars(message.content)
    case "bashExecution":
      return String(message.command ?? "").length + String(message.output ?? "").length
    case "branchSummary":
    case "compactionSummary":
      return String(message.summary ?? "").length
    default:
      return 0
  }
}

const toTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

/**
 * Replay the projected system messages: `sections` patch by name (null
 * removes), tools accumulate via toolsAdded/toolsRemoved. The merged result
 * is the prompt and tool loadout the next request would use.
 */
export function estimateContextBreakdown(messages: any[]): ContextBreakdownEstimate {
  let promptChars = 0
  const sections = new Map<string, string>()
  const tools = new Map<string, unknown>()
  let historyChars = 0

  for (const message of messages ?? []) {
    if (message?.role !== "system") {
      historyChars += messageChars(message)
      continue
    }
    if (typeof message.content === "string" && message.content)
      promptChars = message.content.length
    if (message.sections && typeof message.sections === "object") {
      for (const [name, value] of Object.entries(message.sections)) {
        if (value == null)
          sections.delete(name)
        else if (typeof value === "string")
          sections.set(name, value)
      }
    }
    if (Array.isArray(message.toolsAdded)) {
      for (const tool of message.toolsAdded)
        if (tool?.name) tools.set(tool.name, tool)
    }
    if (Array.isArray(message.toolsRemoved)) {
      for (const tool of message.toolsRemoved)
        tools.delete(typeof tool === "string" ? tool : tool?.name)
    }
  }

  for (const [name, value] of sections) {
    if (name !== TOOLS_SECTION)
      promptChars += value.length
  }
  const toolChars = (sections.get(TOOLS_SECTION)?.length ?? 0)
    + (tools.size ? JSON.stringify([...tools.values()]).length : 0)

  const systemPrompt = toTokens(promptChars)
  const toolDefinitions = toTokens(toolChars)
  const messageHistory = toTokens(historyChars)
  return { systemPrompt, toolDefinitions, messageHistory, total: systemPrompt + toolDefinitions + messageHistory }
}

/**
 * Shares per category. When `actualTotal` (the usage-backed token count from
 * get_session_stats) is available, category tokens are scaled so they sum to
 * it; otherwise the raw estimates are shown.
 */
export function contextBreakdownParts(estimate: ContextBreakdownEstimate, actualTotal?: number | null): ContextBreakdownPart[] {
  if (estimate.total <= 0)
    return []
  const scale = actualTotal && actualTotal > 0 ? actualTotal / estimate.total : 1
  const keys: ContextBreakdownKey[] = ["systemPrompt", "toolDefinitions", "messageHistory"]
  return keys.map(key => ({
    key,
    tokens: Math.round(estimate[key] * scale),
    percent: estimate[key] / estimate.total,
  }))
}
