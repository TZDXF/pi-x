/** mcp.json editor helpers: shallow validation shared by the MCP settings
 *  page and unit tests. Mirrors the Rust-side checks (mcp.rs
 *  validate_config_text): the document must parse, the top level must be an
 *  object, and `mcpServers` (when present) must be an object. Unknown fields
 *  are intentionally allowed — the file is saved as typed. */

export type McpJsonErrorKind = "empty" | "parse" | "topLevel" | "mcpServers"

export interface McpJsonError {
  kind: McpJsonErrorKind
  /** Raw parser message for kind "parse" (shown verbatim as diagnostics). */
  message?: string
  line?: number
  column?: number
}

export type McpJsonValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: McpJsonError }

const POSITION_RE = /position (\d+)/

/** Map a JSON.parse failure message to 1-based line/column diagnostics when
 *  the engine reports a character position (V8 does). */
export function parseErrorInfo(message: string, text: string): McpJsonError {
  const error: McpJsonError = { kind: "parse", message }
  const match = POSITION_RE.exec(message)
  if (!match) return error
  const position = Number(match[1])
  if (!Number.isSafeInteger(position) || position < 0 || position > text.length) return error
  let line = 1
  let column = 1
  for (let i = 0; i < position; i++) {
    if (text[i] === "\n") {
      line++
      column = 1
    } else {
      column++
    }
  }
  error.line = line
  error.column = column
  return error
}

export function validateMcpJson(text: string): McpJsonValidation {
  if (!text.trim()) return { ok: false, error: { kind: "empty" } }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: parseErrorInfo(e instanceof Error ? e.message : String(e), text) }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: { kind: "topLevel" } }
  }
  const servers = (value as Record<string, unknown>).mcpServers
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    return { ok: false, error: { kind: "mcpServers" } }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** Template offered when a mcp.json does not exist yet. */
export function mcpConfigTemplate(): string {
  return JSON.stringify({ mcpServers: {} }, null, 2)
}

/** Connection states pi reports for MCP servers (mcp/runtime.js). Unknown
 *  values (future pi versions) fall back to a generic label. */
export const MCP_SERVER_STATES = [
  "connected",
  "connecting",
  "disconnected",
  "failed",
  "needs-auth",
  "disabled",
  "closed",
] as const

export type McpServerState = (typeof MCP_SERVER_STATES)[number]

export function isKnownMcpState(state: string): state is McpServerState {
  return (MCP_SERVER_STATES as readonly string[]).includes(state)
}

/** i18n key for a server state; unknown states get a fallback key with the
 *  raw value interpolated. */
export function mcpStateLabelKey(state: string): { key: string; raw?: string } {
  if (isKnownMcpState(state)) return { key: `mcpConfig.state.${state}` }
  return { key: "mcpConfig.stateUnknown", raw: state }
}
