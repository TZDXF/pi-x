import { invoke } from "../transport"

// ---- pi MCP servers (mcp.json editor + live status) ----

export type McpScope = "global" | "project"

/** Raw contents of a mcp.json; missing files come back with exists=false and
 *  empty content. Text is passed through verbatim so unknown fields survive
 *  a read/edit/save round trip. */
export interface McpConfigFile {
  path: string
  exists: boolean
  content: string
}

export const getMcpConfig = (scope: McpScope, project?: string) =>
  invoke<McpConfigFile>("mcp_config_read", { scope, project: project ?? null })

export const saveMcpConfig = (scope: McpScope, content: string, project?: string) =>
  invoke<void>("mcp_config_save", { scope, content, project: project ?? null })

/** Model-facing fields of one MCP tool from the server's `tools/list`; the
 *  raw material for the "cost if loaded" token estimate. */
export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** One server report from `pi mcp list --json`. */
export interface McpServerStatus {
  name: string
  scope: "global" | "project"
  source: string
  enabled: boolean
  exposure: string
  transport: string
  state: string
  tools: string[]
  /** Connection error, e.g. the tail of a stdio server's stderr. */
  error?: string | null
  /** Tool definitions fetched over MCP `tools/list` (enabled connected
   *  servers only); null when the fetch failed or did not run. */
  toolDefs?: McpToolDef[] | null
  [key: string]: unknown
}

/** Parsed `pi mcp list --json` result. `ok` is false when pi exited with 1
 *  (some server failed); `note` is set when an untrusted project's
 *  .pi/mcp.json is ignored. */
export interface McpStatusResult {
  ok: boolean
  exitCode: number
  servers: McpServerStatus[]
  errors: string[]
  note?: string | null
}

/** Connects to every enabled server and can take a while; call on explicit
 *  user request only (no polling). */
export const getMcpStatus = (project?: string) => invoke<McpStatusResult>("mcp_status", { project: project ?? null })

/** Result of a single-server MCP `initialize` handshake check. */
export interface McpCheckResult {
  ok: boolean
  latencyMs: number | null
  /** Encoded (PIXERR:) or plain error message; empty on success. */
  error: string | null
}

/** Runs a real MCP initialize handshake against one server definition from
 *  the scope's mcp.json (15s timeout), without touching other servers. */
export const checkMcpServer = (scope: McpScope, name: string, project?: string) =>
  invoke<McpCheckResult>("mcp_check", { scope, name, project: project ?? null })
