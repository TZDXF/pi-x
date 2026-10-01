/**
 * Estimate how much of the model context MCP tool calls occupy, per server,
 * from the projected session messages (`get_messages`). Uses the same
 * chars-per-token heuristic as contextBreakdown (pi's estimateTokens): tool
 * name plus arguments and the tool result, images counted at a fixed size.
 *
 * pi registers MCP tools as `mcp__<server>__<tool>` with characters outside
 * [A-Za-z0-9_-] replaced by "_", so server attribution compares the
 * sanitized server name (see createMcpToolName in pi's mcp extension).
 *
 * estimateMcpLoadUsage is the other direction: the static cost of a server's
 * tool definitions if it were loaded, computed from its `tools/list` result.
 */

import type { McpToolDef } from "@/api/piClient"

export interface McpToolUsage {
  tool: string
  calls: number
  tokens: number
}

export interface McpServerUsage {
  /** Sanitized server name as it appears in `mcp__<server>__<tool>`. */
  server: string
  calls: number
  tokens: number
  tools: McpToolUsage[]
}

/** Token cost of one tool's model-facing definition. */
export interface McpToolLoad {
  tool: string
  tokens: number
}

/** Estimated context cost of a server's tool definitions if it were loaded. */
export interface McpServerLoad {
  server: string
  toolCount: number
  tokens: number
  /** Per-tool estimates, most expensive first. */
  tools: McpToolLoad[]
}

const CHARS_PER_TOKEN = 4
// Mirrors pi's ESTIMATED_IMAGE_CHARS for image blocks.
const ESTIMATED_IMAGE_CHARS = 4800

export function sanitizeMcpServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_")
}

/** `mcp__<server>__<tool>` → { server, tool }; null for non-MCP tool names. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null
  const rest = name.slice("mcp__".length)
  const sep = rest.indexOf("__")
  if (sep <= 0) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + "__".length) }
}

interface MutableUsage {
  calls: number
  chars: number
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") chars += block.text.length
    else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS
  }
  return chars
}

/**
 * Parameters as pi declares a tool to the model: MCP servers may omit
 * `type`, and providers reject object schemas without `properties` (pi's
 * toParameters in the MCP extension).
 */
function declaredParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = schema ?? {}
  return {
    ...base,
    type: base.type ?? "object",
    ...(base.properties === undefined ? { properties: {} } : {}),
  }
}

/** Model-facing description of one tool, mirroring pi's fallback chain
 *  (trimmed description, else the fixed "MCP tool … from server …" text). */
function declaredDescription(def: McpToolDef, server: string): string {
  return def.description?.trim() || `MCP tool ${def.name} from server ${server}`
}

/**
 * Estimate the context cost of loading `server`'s tool definitions — what the
 * provider receives per tool when the server's tools are declared directly:
 * the full `mcp__<server>__<tool>` name, the description and the parameter
 * schema, at the same chars-per-token heuristic as the session estimate.
 * Actual cost varies with exposure: codemode compresses the declarations into
 * a budgeted description, deferred tools cost nothing until first invoked.
 * Returns null when the server exposes no tool definitions.
 */
export function estimateMcpLoadUsage(server: string, defs: McpToolDef[]): McpServerLoad | null {
  if (!defs.length) return null
  const prefix = `mcp__${sanitizeMcpServerName(server)}__`
  const tools = defs
    .map(def => {
      const name = `${prefix}${def.name}`
      const chars =
        name.length +
        declaredDescription(def, server).length +
        JSON.stringify(declaredParameters(def.inputSchema)).length
      return { tool: def.name, tokens: toTokens(chars) }
    })
    .sort((a, b) => b.tokens - a.tokens || a.tool.localeCompare(b.tool))
  return {
    server,
    toolCount: defs.length,
    tokens: tools.reduce((sum, tool) => sum + tool.tokens, 0),
    tools,
  }
}
function toTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Attribute context characters to MCP servers across the projected messages:
 * assistant toolCall blocks contribute name + arguments, toolResult messages
 * contribute their output (matched by callId). Returns an empty object when
 * the session made no MCP calls. Not attributable: codemode-exposed servers
 * are invoked through the codemode tool, so their calls never surface as
 * `mcp__…` tool runs.
 */
export function estimateMcpContextUsage(messages: any[]): Record<string, McpServerUsage> {
  const servers = new Map<string, MutableUsage>()
  const tools = new Map<string, MutableUsage>()
  /** toolCallId → "server\0tool", from the assistant call blocks. */
  const owners = new Map<string, string>()

  for (const message of messages ?? []) {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "toolCall") continue
        const name = String(block.name ?? "")
        const parsed = parseMcpToolName(name)
        if (!parsed) continue
        const chars = name.length + JSON.stringify(block.arguments ?? {}).length
        const server = servers.get(parsed.server) ?? { calls: 0, chars: 0 }
        servers.set(parsed.server, server)
        server.calls++
        server.chars += chars
        const toolKey = `${parsed.server}\0${parsed.tool}`
        const tool = tools.get(toolKey) ?? { calls: 0, chars: 0 }
        tools.set(toolKey, tool)
        tool.calls++
        tool.chars += chars
        if (typeof block.callId === "string") owners.set(block.callId, toolKey)
      }
    } else if (message?.role === "toolResult") {
      const toolKey = owners.get(String(message.toolCallId ?? message.id ?? ""))
      if (!toolKey) continue
      const chars = contentChars(message.content)
      const serverKey = toolKey.slice(0, toolKey.indexOf("\0"))
      const server = servers.get(serverKey)
      const tool = tools.get(toolKey)
      if (server) server.chars += chars
      if (tool) tool.chars += chars
    }
  }

  const result: Record<string, McpServerUsage> = {}
  for (const [serverName, server] of servers) {
    result[serverName] = {
      server: serverName,
      calls: server.calls,
      tokens: toTokens(server.chars),
      tools: [...tools.entries()]
        .filter(([key]) => key.startsWith(`${serverName}\0`))
        .map(([key, usage]) => ({
          tool: key.slice(serverName.length + 1),
          calls: usage.calls,
          tokens: toTokens(usage.chars),
        }))
        .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || a.tool.localeCompare(b.tool)),
    }
  }
  return result
}
