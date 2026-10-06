import { invoke } from "../transport"
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

/** ~/.pix/config.json 中 `sshConnections` 数组的一项（契约 §2.1）。凭据不落盘，仅存私钥路径。 */
export interface SshConnection {
  id: string
  name: string
  host: string
  port: number
  user: string | null
  keyPath: string | null
  createdAt: string
  lastUsedAt: string | null
  lastProbe: SshProbeInfo | null
}

export interface SshConnectionInput {
  id?: string
  name: string
  host: string
  port?: number
  user?: string | null
  keyPath?: string | null
}

export type SshErrorKind = "auth" | "hostKey" | "network" | "sshMissing" | "remote" | "timeout"

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

/** 远程项目会话列表（契约 §2.1）。project 为 `ssh://` 展示 URI，连接 id 与 rpc_spawn 同源。 */
export const sshSessions = (project: string, sshConnectionId: string) =>
  invoke<SessionMeta[]>("ssh_sessions", { project, sshConnectionId })

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
