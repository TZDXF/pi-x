/**
 * 远程项目身份模型（docs/plans/ssh-remote-p1-contracts.md §1 与
 * docs/plans/remote-backends-contract.md §2：SSH / WSL / Docker 三后端）。
 *
 * 两种标识，禁止在任何调用方手拼，必须经这里的构造/解析函数：
 * - 展示 URI：`ssh://[user@]host[:port]/path`、`wsl://[user@]distro/path`、`docker://container/path`
 * - 内部身份键：`remote:ssh:<host>:<port>:<user>:<path>`、`remote:wsl:<distro>:<user>:<path>`、
 *   `remote:docker:<container>:<path>`
 *
 * 归一化语义与 Rust 侧 `src-tauri/src/ssh/identity.rs` 完全一致；本模块保持零依赖。
 */

/** 远程连接后端种类；旧数据（无 kind 字段）按契约 §3.2 迁移规则缺省视为 "ssh"。 */
export type RemoteKind = "ssh" | "wsl" | "docker"

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

export interface WslTarget {
  /** 大小写保留（发行版名是注册表身份）；构造/解析时按 §2.2 校验 */
  distro: string
  /** null 表示发行版默认用户 */
  user: string | null
  /** 归一化后的绝对 POSIX 路径 */
  path: string
}

export interface DockerTarget {
  /** 容器名或短 ID，保留输入原样、不做 lowercase */
  container: string
  /** 归一化后的绝对 POSIX 路径 */
  path: string
}

/** 三后端伞型（契约 §2.3）：kind 判别 + 对应 target。 */
export type RemoteTarget =
  | { kind: "ssh"; target: SshTarget }
  | { kind: "wsl"; target: WslTarget }
  | { kind: "docker"; target: DockerTarget }

/** 供连接解析使用的最小结构（与 SshConnection 的 per-kind 字段兼容）。 */
export interface SshConnectionRef {
  id: string
  /** 缺省视为 "ssh"（契约 §3.1/§3.2 的旧数据迁移规则）。 */
  kind?: RemoteKind
  host: string
  port?: number
  user?: string | null
  distro?: string | null
  container?: string | null
}

const SSH_URI_PREFIX = "ssh://"
const IDENTITY_KEY_PREFIX = "remote:ssh:"
const WSL_URI_PREFIX = "wsl://"
const WSL_IDENTITY_KEY_PREFIX = "remote:wsl:"
const DOCKER_URI_PREFIX = "docker://"
const DOCKER_IDENTITY_KEY_PREFIX = "remote:docker:"
// 字母数字采用 Unicode 语义（\p{Alphabetic} + \p{N}），与 Rust 侧 char::is_alphanumeric
// （identity.rs is_valid_user/is_valid_distro）逐字对齐。
const USER_PATTERN = /^[\p{Alphabetic}\p{N}._-]+$/u
/** WSL 发行版名：字母数字与 `._-`，不以 `.`/`-` 开头；大小写保留（契约 §2.2）。 */
const DISTRO_PATTERN = /^[\p{Alphabetic}\p{N}._-]+$/u
/** Docker 容器名/短 ID：`^[A-Za-z0-9][A-Za-z0-9_.-]+$`（至少 2 字符，对齐 moby 真实命名规则；契约 §2.2 修订版，ASCII）。 */
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/
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

// ---- WSL / Docker 身份（docs/plans/remote-backends-contract.md §2）----

/** distro 名校验：字符集 + 非 `.`/`-` 开头 + 拒绝任何大小写的 "default"（模糊输入，§2.2）。 */
function isValidDistroName(value: string): boolean {
  return DISTRO_PATTERN.test(value) && !/^[.-]/.test(value) && !/^default$/i.test(value)
}

function validateDistroName(value: string): string {
  if (!isValidDistroName(value)) throw new Error(`Invalid WSL distro: ${value}`)
  return value
}

function validateContainerName(value: string): string {
  if (!CONTAINER_PATTERN.test(value)) throw new Error(`Invalid Docker container: ${value}`)
  return value
}

function validatedWslPath(target: WslTarget): { distro: string; user: string | null; path: string } {
  const path = normalizeSshPath(target.path)
  if (!path) throw new Error(`Invalid WSL project path: ${target.path}`)
  return { distro: validateDistroName(target.distro), user: validateUser(target.user), path }
}

function validatedDockerTarget(target: DockerTarget): { container: string; path: string } {
  const path = normalizeSshPath(target.path)
  if (!path) throw new Error(`Invalid Docker project path: ${target.path}`)
  return { container: validateContainerName(target.container), path }
}

/** 解析 WSL 展示 URI；非法或非 wsl 返回 null（契约 §2.2/§2.4 用例 1-4）。 */
export function parseWslUri(uri: string): WslTarget | null {
  if (!uri.startsWith(WSL_URI_PREFIX)) return null
  const rest = uri.slice(WSL_URI_PREFIX.length)
  const slashIndex = rest.indexOf("/")
  // 无路径（`wsl://Ubuntu`）非法。
  if (slashIndex < 0) return null
  const path = normalizeSshPath(rest.slice(slashIndex))
  if (!path) return null
  const authority = rest.slice(0, slashIndex)
  let user: string | null = null
  let distroPart = authority
  const atIndex = authority.indexOf("@")
  if (atIndex >= 0) {
    const rawUser = authority.slice(0, atIndex)
    // 空 user（`wsl://@U/x`）或含非法字符均拒绝。
    if (!rawUser || !USER_PATTERN.test(rawUser)) return null
    user = rawUser
    distroPart = authority.slice(atIndex + 1)
  }
  // 空 distro（`wsl:///x`）、`wsl://default/x`、含空白/`:` 的输入均被字符集拒绝。
  if (!isValidDistroName(distroPart)) return null
  return { distro: distroPart, user, path }
}

/** 构造 WSL 展示 URI；字段非法抛 Error。缺省 user 省略（契约 §2.2 展示重建）。 */
export function buildWslUri(target: WslTarget): string {
  const { distro, user, path } = validatedWslPath(target)
  return `${WSL_URI_PREFIX}${user ? `${user}@` : ""}${distro}${path}`
}

/** 构造 WSL 内部身份键；字段非法抛 Error。user 缺省时为空串段。 */
export function wslIdentityKey(target: WslTarget): string {
  const { distro, user, path } = validatedWslPath(target)
  return `${WSL_IDENTITY_KEY_PREFIX}${distro}:${user ?? ""}:${path}`
}

/** 解析 WSL 内部身份键；非法返回 null。path 必须已是归一化形式。 */
export function parseWslIdentityKey(key: string): WslTarget | null {
  if (!key.startsWith(WSL_IDENTITY_KEY_PREFIX)) return null
  const parts = key.slice(WSL_IDENTITY_KEY_PREFIX.length).split(":")
  if (parts.length !== 3) return null
  const [rawDistro, rawUser, rawPath] = parts
  if (!isValidDistroName(rawDistro)) return null
  const user = rawUser ? rawUser : null
  if (user && !USER_PATTERN.test(user)) return null
  const path = normalizeSshPath(rawPath)
  if (!path || path !== rawPath) return null
  return { distro: rawDistro, user, path }
}

/** 解析 Docker 展示 URI；非法或非 docker 返回 null（契约 §2.2/§2.4 用例 5-6）。 */
export function parseDockerUri(uri: string): DockerTarget | null {
  if (!uri.startsWith(DOCKER_URI_PREFIX)) return null
  const rest = uri.slice(DOCKER_URI_PREFIX.length)
  const slashIndex = rest.indexOf("/")
  // 无路径（`docker://x`）非法。
  if (slashIndex < 0) return null
  const path = normalizeSshPath(rest.slice(slashIndex))
  if (!path) return null
  const container = rest.slice(0, slashIndex)
  // `docker:///x`（空）、`docker://x:1/y`（含 `:`）、`docker://-x/y`（`-` 开头）均拒绝。
  if (!CONTAINER_PATTERN.test(container)) return null
  return { container, path }
}

/** 构造 Docker 展示 URI；字段非法抛 Error。 */
export function buildDockerUri(target: DockerTarget): string {
  const { container, path } = validatedDockerTarget(target)
  return `${DOCKER_URI_PREFIX}${container}${path}`
}

/** 构造 Docker 内部身份键；字段非法抛 Error。 */
export function dockerIdentityKey(target: DockerTarget): string {
  const { container, path } = validatedDockerTarget(target)
  return `${DOCKER_IDENTITY_KEY_PREFIX}${container}:${path}`
}

/** 解析 Docker 内部身份键；非法返回 null。path 必须已是归一化形式。 */
export function parseDockerIdentityKey(key: string): DockerTarget | null {
  if (!key.startsWith(DOCKER_IDENTITY_KEY_PREFIX)) return null
  const parts = key.slice(DOCKER_IDENTITY_KEY_PREFIX.length).split(":")
  if (parts.length !== 2) return null
  const [rawContainer, rawPath] = parts
  if (!CONTAINER_PATTERN.test(rawContainer)) return null
  const path = normalizeSshPath(rawPath)
  if (!path || path !== rawPath) return null
  return { container: rawContainer, path }
}

/** True only for literal `ssh://` / `wsl://` / `docker://` prefixed URIs; local paths are never remote. */
export function isRemoteUri(value: string): boolean {
  return isSshUri(value) || value.startsWith(WSL_URI_PREFIX) || value.startsWith(DOCKER_URI_PREFIX)
}

/** 三后端伞型解析（契约 §2.3）：依次尝试 ssh/wsl/docker 前缀；本地路径与非法输入返回 null。 */
export function parseRemoteUri(uri: string): RemoteTarget | null {
  const ssh = parseSshUri(uri)
  if (ssh) return { kind: "ssh", target: ssh }
  const wsl = parseWslUri(uri)
  if (wsl) return { kind: "wsl", target: wsl }
  const docker = parseDockerUri(uri)
  if (docker) return { kind: "docker", target: docker }
  return null
}

/** 按后端种类构造展示 URI 的统一分发入口（禁止手拼 URI 的纪律不变）。 */
export function buildRemoteUri(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return buildSshUri(target.target)
    case "wsl":
      return buildWslUri(target.target)
    case "docker":
      return buildDockerUri(target.target)
  }
}

/**
 * WSL 入口的平台守卫（契约 §4.1）：wsl.exe 仅 Windows 提供；非 Windows 平台
 * 前端直接隐藏 WSL 入口。可注入 userAgent 便于单测。
 */
export function isWslPlatform(userAgent: string = navigator.userAgent): boolean {
  return /windows/i.test(userAgent)
}

/** UI 守卫统一入口：项目 cwd 是否为远程项目（= isSshUri）。 */
export const isSshProject = isSshUri

/** UI 守卫统一入口（契约 §2.3）：三后端远程项目的判定，本地路径恒为 false。 */
export const isRemoteProject = isRemoteUri

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

/** 创建/编辑远程项目时记录所选连接 id（三后端通用：URI 前缀自带 kind，契约 §3.2 第 4 条）。 */
export function rememberSshProjectConnection(uri: string, connectionId: string) {
  if (!isRemoteUri(uri) || !connectionId) return
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

/** 连接的后端种类；缺省（旧数据无 kind 字段）按契约 §3.2 迁移规则视为 ssh。 */
export function connectionKind(connection: SshConnectionRef): RemoteKind {
  return connection.kind ?? "ssh"
}

/**
 * 连接与项目 URI 的 per-kind 匹配（契约 §3.1）：kind 不匹配直接 false；
 * ssh 比 host/port/user，wsl 比 distro/user，docker 比 container。
 */
function connectionMatches(connection: SshConnectionRef, remote: RemoteTarget): boolean {
  if (connectionKind(connection) !== remote.kind) return false
  switch (remote.kind) {
    case "wsl":
      return (connection.distro ?? "") === remote.target.distro && (connection.user ?? null) === remote.target.user
    case "docker":
      return (connection.container ?? "") === remote.target.container
    case "ssh":
      return (
        connection.host === remote.target.host &&
        (connection.port ?? DEFAULT_PORT) === remote.target.port &&
        (connection.user ?? null) === remote.target.user
      )
  }
}

/** spawn 前解析项目应使用的连接 id：优先取记住的选择（仍需与 URI 一致），否则按 kind 匹配对应字段。 */
export function resolveSshConnectionId(uri: string, connections: readonly SshConnectionRef[]): string | null {
  const remote = parseRemoteUri(uri)
  if (!remote) return null
  const remembered = readConnectionMap()[uri]
  if (
    remembered &&
    connections.some(connection => connection.id === remembered && connectionMatches(connection, remote))
  )
    return remembered
  return connections.find(connection => connectionMatches(connection, remote))?.id ?? null
}

/** realpath 回绑时复制来源的有效连接选择，保留旧项目关联；禁止跨连接目标迁移。 */
export function copySshProjectConnection(previous: string, rebound: string, connections: readonly SshConnectionRef[]) {
  if (previous === rebound) return
  const remote = parseRemoteUri(rebound)
  if (!remote) return
  const connectionId = resolveSshConnectionId(previous, connections)
  if (!connectionId) return
  const connection = connections.find(connection => connection.id === connectionId)
  if (!connection || !connectionMatches(connection, remote)) return
  rememberSshProjectConnection(rebound, connectionId)
}
