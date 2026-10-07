import { invoke } from "../transport"
import type { RemoteKind } from "@/lib/ssh"
import type { SessionMeta } from "./sessions"

/** SSH 连接的最近一次探测缓存；仅 UI 展示与错误指引，spawn 不读缓存（契约 §2.3）。 */
export interface SshProbeInfo {
  probedAt: string
  ok: boolean
  uname: string | null
  arch: string | null
  nodeVersion: string | null
  piVersion: string | null
}

/**
 * ~/.pix/config.json 中 `sshConnections` 数组的一项（P1 契约 §2.1 + 多后端契约 §3.1）。
 * 键名沿用历史命名的 `sshConnections`（语义已是"远程连接"）；凭据不落盘，仅存私钥路径。
 */
export interface SshConnection {
  id: string
  /** 连接后端种类；Rust 侧 serde default 补齐，但旧数据防御性按缺省 ssh 处理。 */
  kind?: RemoteKind
  name: string
  /** ---- kind = "ssh" 专用 ---- */
  host: string
  port: number
  user: string | null
  keyPath: string | null
  /** ---- kind = "wsl" 专用（skip_serializing_if 缺省时字段可能缺席）---- */
  distro?: string | null
  /** ---- kind = "docker" 专用 ---- */
  container?: string | null
  createdAt: string
  lastUsedAt: string | null
  lastProbe: SshProbeInfo | null
}

export interface SshConnectionInput {
  id?: string
  /** 缺省 ssh，由后端落盘（契约 §3.1）。 */
  kind?: RemoteKind
  name: string
  /** kind = "ssh" 专用；wsl/docker 输入省略（后端 per-kind 裁剪，serde default）。 */
  host?: string
  port?: number
  user?: string | null
  keyPath?: string | null
  /** kind = "wsl" 专用 */
  distro?: string | null
  /** kind = "docker" 专用 */
  container?: string | null
}

export type SshErrorKind =
  | "auth"
  | "hostKey"
  | "network"
  | "sshMissing"
  | "remote"
  | "timeout"
  // ---- 多后端契约 §4.4 的 errorKind 键集（冻结）----
  | "wslUnsupportedPlatform"
  | "wslNotInstalled"
  | "wslDistroNotFound"
  | "wslExecFailed"
  | "dockerMissing"
  | "dockerDaemonDown"
  | "dockerContainerNotFound"
  | "dockerContainerNotRunning"
  | "dockerExecFailed"

export interface SshProbeResult {
  ok: boolean
  uname: string | null
  arch: string | null
  nodeVersion: string | null
  piVersion: string | null
  nodeFound: boolean
  piFound: boolean
  errorKind: SshErrorKind | null
  /** 已按 i18n 键归类的 coded error，前端用 translateError 渲染 */
  error: string | null
}

export const sshConnectionList = () => invoke<SshConnection[]>("ssh_connection_list")

export const sshConnectionSave = (connection: SshConnectionInput) =>
  invoke<SshConnection>("ssh_connection_save", { connection })

export const sshConnectionDelete = (id: string) => invoke<void>("ssh_connection_delete", { id })

export const sshConnectionProbe = (id: string) => invoke<SshProbeResult>("ssh_connection_probe", { id })

/** 远程项目会话列表（契约 §2.1）。project 为远程展示 URI，连接 id 与 rpc_spawn 同源。 */
export const sshSessions = (project: string, sshConnectionId: string) =>
  invoke<SessionMeta[]>("ssh_sessions", { project, sshConnectionId })

// ---- WSL / Docker 枚举（多后端契约 §4.1）。不可用时不返回 Err，而是
// available=false + errorKind 的结构化结果，前端呈现不可用态而非报错 toast。----

export interface WslDistroInfo {
  /** 原样（大小写保留） */
  name: string
  /** "Running" / "Stopped" / …（wsl.exe 原文） */
  state: string
  /** 1 | 2 */
  version: number
  /** `*` 前缀行（wsl.exe 的 default 标记），仅供 UI 标注 */
  isDefault: boolean
}

export interface WslDistroListResult {
  available: boolean
  distros: WslDistroInfo[]
  errorKind: SshErrorKind | null
  /** coded error，前端用 translateError 渲染 */
  error: string | null
}

/** 枚举 WSL 发行版（`wsl.exe -l -v`）；仅 Windows 有意义，非 Windows 返回 available=false。 */
export const wslDistroList = () => invoke<WslDistroListResult>("wsl_distro_list")

export interface DockerContainerInfo {
  /** json .Names 首名 */
  name: string
  /** json .ID（12 位短 ID） */
  id: string
  image: string
  /** "running" / "exited" / …（小写原值） */
  state: string
  /** "Up 2 minutes" 等展示文本 */
  status: string
}

export interface DockerContainerListResult {
  available: boolean
  containers: DockerContainerInfo[]
  errorKind: SshErrorKind | null
  /** coded error，前端用 translateError 渲染 */
  error: string | null
}

/** 枚举 Docker 容器（`docker ps -a`，含未运行容器；不自动 start）。 */
export const dockerContainerList = () => invoke<DockerContainerListResult>("docker_container_list")

/** 保存前的“测试连接”：参数即测，不写配置。 */
export const sshProbeTarget = (target: {
  host: string
  port?: number | null
  user?: string | null
  keyPath?: string | null
}) =>
  invoke<SshProbeResult>("ssh_probe_target", {
    host: target.host,
    port: target.port ?? null,
    user: target.user ?? null,
    keyPath: target.keyPath ?? null,
  })
