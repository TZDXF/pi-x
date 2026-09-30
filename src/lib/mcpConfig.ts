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

// ---- Structured server editing ----
//
// pi's mcp.json schema (pi 0.99): `mcpServers: { name: def }` where a def is
// either stdio (`command`, optional `args`/`env`/`cwd`) or streamable HTTP
// (`url`, optional `headers`; legacy `type: "sse"` is rejected by pi). Defs
// also allow `type`, `enabled`, `timeout`, `exposure`, `toolExposure` and
// `oauth` — everything the form does not model is preserved verbatim.

/** Transports the structured editor models; pi also accepts `type:
 *  "streamable-http"`, normalized to "http" here. */
export type McpTransport = "stdio" | "http"

/** Server names pi accepts in mcp.json. */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/

export function mcpServerNameValid(name: string): boolean {
  return MCP_SERVER_NAME_RE.test(name)
}

/** "unknown" = no command/url (broken entry); unsupported transports (e.g.
 *  legacy "sse") also map here so the form cannot silently rewrite them. */
export type McpEntryTransport = McpTransport | "unknown"

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Normalize the `type`/`transport` discriminator plus the command/url shape
 *  to one of the editor's transports. */
export function mcpEntryTransport(def: unknown): McpEntryTransport {
  if (!isJsonRecord(def)) return "unknown"
  const declared = typeof def.type === "string" ? def.type.toLowerCase() : ""
  if (declared === "sse") return "unknown"
  if (typeof def.url === "string" && def.url.trim()) {
    return declared === "stdio" ? "unknown" : "http"
  }
  if (typeof def.command === "string" && def.command.trim()) {
    return declared === "http" || declared === "streamable-http" ? "unknown" : "stdio"
  }
  return "unknown"
}

/** Ordered `mcpServers` entries of a validated document. */
export function mcpServerEntries(doc: Record<string, unknown>): { name: string; def: Record<string, unknown> }[] {
  const servers = doc.mcpServers
  if (!isJsonRecord(servers)) return []
  return Object.entries(servers)
    .filter((entry): entry is [string, Record<string, unknown>] => isJsonRecord(entry[1]))
    .map(([name, def]) => ({ name, def }))
}

/** Form view of a server definition; everything the structured editor edits. */
export interface McpServerForm {
  transport: McpTransport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
  /** undefined = field absent in the def (pi treats missing as enabled). */
  enabled: boolean | undefined
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isJsonRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item
  }
  return out
}

function stringArgList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

export function mcpFormFromDef(def: Record<string, unknown>): McpServerForm {
  const transport: McpTransport = mcpEntryTransport(def) === "http" ? "http" : "stdio"
  return {
    transport,
    command: typeof def.command === "string" ? def.command : "",
    args: stringArgList(def.args),
    env: stringRecord(def.env),
    cwd: typeof def.cwd === "string" ? def.cwd : "",
    url: typeof def.url === "string" ? def.url : "",
    headers: stringRecord(def.headers),
    enabled: typeof def.enabled === "boolean" ? def.enabled : undefined,
  }
}

/** Clone `def` and write the form fields back. Unknown fields survive; fields
 *  the form clears (empty args/env/…) are removed rather than written empty,
 *  and transport-incompatible keys (command on http, url on stdio) are
 *  dropped. A stale `type` that contradicts the new transport is removed so
 *  pi re-infers it from the shape. */
export function applyMcpForm(def: Record<string, unknown>, form: McpServerForm): Record<string, unknown> {
  const next: Record<string, unknown> = { ...def }
  const declared = typeof next.type === "string" ? next.type.toLowerCase() : ""
  if (declared && declared !== "stdio" && declared !== "http" && declared !== "streamable-http") {
    delete next.type
  } else if (declared && (form.transport === "stdio") !== (declared === "stdio")) {
    delete next.type
  }
  if (form.transport === "stdio") {
    delete next.url
    delete next.headers
    next.command = form.command.trim()
    setOrDelete(next, "args", form.args.filter((arg) => arg.trim()).length ? form.args : undefined)
    setOrDelete(next, "env", nonEmptyRecord(form.env))
    setOrDelete(next, "cwd", form.cwd.trim() || undefined)
  } else {
    delete next.command
    delete next.args
    delete next.env
    delete next.cwd
    next.url = form.url.trim()
    setOrDelete(next, "headers", nonEmptyRecord(form.headers))
  }
  setOrDelete(next, "enabled", form.enabled)
  return next
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined) delete target[key]
  else target[key] = value
}

function nonEmptyRecord(map: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) {
    const k = key.trim()
    if (k) out[k] = value.trim()
  }
  return Object.keys(out).length ? out : undefined
}

/** Save-time validation for one form. The name is not checked here: the
 *  dialog validates it (required/charset) and the settings page rejects
 *  conflicts against the document. */
export function mcpFormError(form: McpServerForm): "commandRequired" | "urlRequired" | "urlInvalid" | null {
  if (form.transport === "stdio") {
    if (!form.command.trim()) return "commandRequired"
    return null
  }
  const url = form.url.trim()
  if (!url) return "urlRequired"
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) return "urlInvalid"
  } catch {
    return "urlInvalid"
  }
  return null
}

/** Insert/replace a named server in a validated document (in place) and
 *  return the document. Replacing keeps the original key order; a new name is
 *  appended. */
export function upsertMcpServer(
  doc: Record<string, unknown>,
  name: string,
  def: Record<string, unknown>,
): Record<string, unknown> {
  const servers = isJsonRecord(doc.mcpServers) ? { ...doc.mcpServers } : {}
  servers[name] = def
  return { ...doc, mcpServers: servers }
}

/** Remove a named server (in place); no-op when absent. */
export function removeMcpServer(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!isJsonRecord(doc.mcpServers) || !(name in doc.mcpServers)) return doc
  const servers = { ...doc.mcpServers }
  delete servers[name]
  return { ...doc, mcpServers: servers }
}

export function serializeMcpDoc(doc: Record<string, unknown>): string {
  return JSON.stringify(doc, null, 2)
}

/** Parsed single-server JSON from the editor's JSON mode. */
export type McpEntryParse =
  | { ok: true; name: string; def: Record<string, unknown> }
  | { ok: false; error: "invalidJson" | "notAnObject" | "noEntry" | "entryNotAnObject" }

/** Accept the paste shapes the editor dialog allows for a single server: a
 *  bare definition, a `{ "name": def }` wrapper, or a `{ "mcpServers": … }`
 *  document (first entry wins). An explicit name in the wrapper overrides
 *  `def.name`. */
export function parseMcpEntryJson(text: string, fallbackName: string): McpEntryParse {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: "invalidJson" }
  }
  if (!isJsonRecord(value)) return { ok: false, error: "notAnObject" }
  let name = fallbackName
  let def: unknown = value
  if (isJsonRecord(value.mcpServers)) {
    const [first, second] = Object.entries(value.mcpServers)
    if (!first) return { ok: false, error: "noEntry" }
    def = first[1]
    name = first[0]
    if (second) return { ok: false, error: "noEntry" }
  } else if (!looksLikeDef(value)) {
    const entries = Object.entries(value)
    if (entries.length !== 1) return { ok: false, error: "noEntry" }
    const [key, item] = entries[0]!
    def = item
    name = key
  }
  if (!isJsonRecord(def)) return { ok: false, error: "entryNotAnObject" }
  const defName = typeof def.name === "string" && def.name.trim() ? def.name.trim() : undefined
  if (!name.trim() && !defName) return { ok: false, error: "noEntry" }
  return { ok: true, name: name.trim() || (defName ?? ""), def }
}

function looksLikeDef(value: Record<string, unknown>): boolean {
  return (
    (typeof value.command === "string" && !!value.command.trim()) ||
    (typeof value.url === "string" && !!value.url.trim()) ||
    mcpEntryTransport(value) !== "unknown"
  )
}
