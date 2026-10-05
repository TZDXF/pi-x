/**
 * SSH 远程项目身份模型（docs/plans/ssh-remote-p1-contracts.md §1）。
 *
 * 两种标识，禁止在任何调用方手拼，必须经这里的构造/解析函数：
 * - 展示 URI：`ssh://[user@]host[:port]/abs/posix/path`（项目列表、lastProject、localStorage）
 * - 内部身份键：`remote:ssh:<host>:<port>:<user>:<posixPath>`（后端匹配、日志）
 *
 * 归一化语义与 Rust 侧 `src-tauri/src/ssh/identity.rs` 完全一致；本模块保持零依赖。
 */

export interface SshTarget {
  /** 归一化小写 */
  host: string
  /** 1–65535，缺省 22 */
  port: number
  /** null 表示缺省 */
  user: string | null
  /** 归一化后的绝对 POSIX 路径 */
  path: string
}

/** 供连接解析使用的最小结构（与 SshConnection 的 host/port/user 字段兼容）。 */
export interface SshConnectionRef {
  id: string
  host: string
  port?: number
  user?: string | null
}

const SSH_URI_PREFIX = "ssh://"
const IDENTITY_KEY_PREFIX = "remote:ssh:"
const USER_PATTERN = /^[A-Za-z0-9._-]+$/
const DEFAULT_PORT = 22

function hasControlOrWhitespace(value: string): boolean {
  return /[\s\0]/.test(value)
}

/**
 * 仅路径归一化：`\` → `/`、连续 `/` 折叠、去尾部 `/`（根保留）、删除 `.` 空段；
 * 含 `..` 段、`:` 或控制字符，或非 `/` 开头一律返回 null（P1 不做词法上推）。
 */
export function normalizeSshPath(path: string): string | null {
  if (!path) return null
  if (/[\0\n\r\t]/.test(path)) return null
  const slashed = path.replace(/\\/g, "/")
  if (!slashed.startsWith("/")) return null
  if (slashed.includes(":")) return null
  const segments = slashed.split("/").filter(segment => segment.length > 0 && segment !== ".")
  if (segments.some(segment => segment === "..")) return null
  return segments.length ? `/${segments.join("/")}` : "/"
}

/** True only for literal `ssh://` prefixed URIs; local paths are never remote. */
export function isSshUri(value: string): boolean {
  return value.startsWith(SSH_URI_PREFIX)
}

/** 解析展示 URI；非法或非 ssh 返回 null。 */
export function parseSshUri(uri: string): SshTarget | null {
  if (!isSshUri(uri)) return null
  const rest = uri.slice(SSH_URI_PREFIX.length)
  const slashIndex = rest.indexOf("/")
  // 无路径（`ssh://host`）非法。
  if (slashIndex < 0) return null
  const path = normalizeSshPath(rest.slice(slashIndex))
  if (!path) return null
  const authority = rest.slice(0, slashIndex)
  let user: string | null = null
  let hostPart = authority
  const atIndex = authority.indexOf("@")
  if (atIndex >= 0) {
    const rawUser = authority.slice(0, atIndex)
    // 空 user（`ssh://@host/…`）或含非法字符均拒绝。
    if (!rawUser || !USER_PATTERN.test(rawUser)) return null
    user = rawUser
    hostPart = authority.slice(atIndex + 1)
  }
  const colonIndex = hostPart.indexOf(":")
  let rawHost = hostPart
  let port = DEFAULT_PORT
  if (colonIndex >= 0) {
    rawHost = hostPart.slice(0, colonIndex)
    const rawPort = hostPart.slice(colonIndex + 1)
    if (!/^\d+$/.test(rawPort)) return null
    // Number 去前导零（`022` → 22）；0 或超界均非法。
    port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  }
  // P1 不支持 IPv6 字面量（host 含 `:`）。
  if (!rawHost || /[:/@]/.test(rawHost) || hasControlOrWhitespace(rawHost)) return null
  return { host: rawHost.toLowerCase(), port, user, path }
}

function validateHost(host: string): string {
  const normalized = host.toLowerCase()
  if (!normalized || /[:/@]/.test(normalized) || hasControlOrWhitespace(normalized))
    throw new Error(`Invalid SSH host: ${host}`)
  return normalized
}

function validateUser(user: string | null): string | null {
  if (user == null || user === "") return null
  if (!USER_PATTERN.test(user)) throw new Error(`Invalid SSH user: ${user}`)
  return user
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SSH port: ${port}`)
  return port
}

function validatedTarget(target: SshTarget): { host: string; port: number; user: string | null; path: string } {
  const path = normalizeSshPath(target.path)
  if (!path) throw new Error(`Invalid SSH project path: ${target.path}`)
  return { host: validateHost(target.host), port: validatePort(target.port), user: validateUser(target.user), path }
}

/** 构造展示 URI；字段非法抛 Error。port 22 省略、缺省 user 省略。 */
export function buildSshUri(target: SshTarget): string {
  const { host, port, user, path } = validatedTarget(target)
  const authority = user ? `${user}@${host}` : host
  const portSuffix = port === DEFAULT_PORT ? "" : `:${port}`
  return `${SSH_URI_PREFIX}${authority}${portSuffix}${path}`
}

/** 构造内部身份键；字段非法抛 Error。user 缺省时为空串段。 */
export function sshIdentityKey(target: SshTarget): string {
  const { host, port, user, path } = validatedTarget(target)
  return `${IDENTITY_KEY_PREFIX}${host}:${port}:${user ?? ""}:${path}`
}

/** 解析内部身份键；非法返回 null。 */
export function parseSshIdentityKey(key: string): SshTarget | null {
  if (!key.startsWith(IDENTITY_KEY_PREFIX)) return null
  const parts = key.slice(IDENTITY_KEY_PREFIX.length).split(":")
  if (parts.length !== 4) return null
  const [rawHost, rawPort, rawUser, rawPath] = parts
  if (!rawHost || /[:/@]/.test(rawHost) || hasControlOrWhitespace(rawHost)) return null
  if (!/^\d+$/.test(rawPort)) return null
  const port = Number(rawPort)
  if (port < 1 || port > 65535) return null
  const user = rawUser ? rawUser : null
  if (user && !USER_PATTERN.test(user)) return null
  const path = normalizeSshPath(rawPath)
  // 身份键中的 path 必须已是归一化形式。
  if (!path || path !== rawPath) return null
  return { host: rawHost.toLowerCase(), port, user, path }
}

/** UI 守卫统一入口：项目 cwd 是否为远程项目（= isSshUri）。 */
export const isSshProject = isSshUri

// ---- 项目 → 连接的关联（localStorage）----
// 连接细节（port/user/keyPath）不在 URI 里；同一 host:port:user 可能存多个连接，
// 创建远程项目时记录用户选择的连接 id，spawn 时优先使用，失效后回退到参数匹配。

const SSH_PROJECT_CONNECTIONS_KEY = "pix.sshProjectConnections"

function readConnectionMap(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SSH_PROJECT_CONNECTIONS_KEY) || "{}")
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      return Object.fromEntries(
        Object.entries(stored as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      )
    }
  } catch {
    /* Optional storage. */
  }
  return {}
}

function writeConnectionMap(map: Record<string, string>) {
  try {
    localStorage.setItem(SSH_PROJECT_CONNECTIONS_KEY, JSON.stringify(map))
  } catch {
    /* Optional storage. */
  }
}

/** 创建/编辑远程项目时记录所选连接 id。 */
export function rememberSshProjectConnection(uri: string, connectionId: string) {
  if (!isSshUri(uri) || !connectionId) return
  const map = readConnectionMap()
  map[uri] = connectionId
  writeConnectionMap(map)
}

/** 删除远程项目或连接时清理关联。 */
export function forgetSshProjectConnection(uri: string) {
  const map = readConnectionMap()
  if (!(uri in map)) return
  delete map[uri]
  writeConnectionMap(map)
}

function connectionMatches(connection: SshConnectionRef, target: SshTarget): boolean {
  return (
    connection.host === target.host &&
    (connection.port ?? DEFAULT_PORT) === target.port &&
    (connection.user ?? null) === target.user
  )
}

/** spawn 前解析项目应使用的连接 id：优先取记住的选择（仍需与 URI 一致），否则按 host/port/user 匹配。 */
export function resolveSshConnectionId(uri: string, connections: readonly SshConnectionRef[]): string | null {
  const target = parseSshUri(uri)
  if (!target) return null
  const remembered = readConnectionMap()[uri]
  if (
    remembered &&
    connections.some(connection => connection.id === remembered && connectionMatches(connection, target))
  )
    return remembered
  return connections.find(connection => connectionMatches(connection, target))?.id ?? null
}
