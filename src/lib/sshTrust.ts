/**
 * SSH 远程项目的信任与终端连接分流（docs/plans/ssh-remote-p2-contracts.md §3.4/§4.3）。
 *
 * 纯逻辑层：本地项目走既有 trust_status/trust_save，远程项目改为调用
 * ssh_trust_status/ssh_trust_save，连接 id 由 resolveSshConnectionId 解析，
 * 解析不到时按 coded error `sshConnectionMissing` 失败或降级。
 */
import { encodeCodedError } from "@/lib/backendError"
import { isRemoteProject, resolveSshConnectionId, type SshConnectionRef } from "@/lib/ssh"
import type { TrustStatus } from "@/api/client/config"

export const SSH_CONNECTION_MISSING_FALLBACK = "远程项目没有匹配的 SSH 连接"

interface TrustReadApi {
  trustStatus(project: string): Promise<TrustStatus>
  sshTrustStatus(project: string, sshConnectionId: string): Promise<TrustStatus>
}

interface TrustWriteApi {
  trustSave(project: string, trusted: boolean, trustParent: boolean): Promise<unknown>
  sshTrustSave(project: string, sshConnectionId: string, trusted: boolean, trustParent: boolean): Promise<unknown>
}

/** 解析远程项目必须使用的连接 id；本地路径不经此入口（返回前已由 isRemoteProject 分流）。 */
export function requireSshConnectionId(project: string, connections: readonly SshConnectionRef[]): string {
  const connectionId = resolveSshConnectionId(project, connections)
  if (!connectionId) throw new Error(encodeCodedError("sshConnectionMissing", SSH_CONNECTION_MISSING_FALLBACK))
  return connectionId
}

/** 信任状态分流：本地照旧，远程调 ssh_trust_status；连接缺失抛 coded error（契约 §4.3 第 1 处）。 */
export async function loadTrustStatus(
  project: string,
  connections: readonly SshConnectionRef[],
  api: TrustReadApi,
): Promise<TrustStatus> {
  if (!isRemoteProject(project)) return api.trustStatus(project)
  return api.sshTrustStatus(project, requireSshConnectionId(project, connections))
}

/**
 * 宽松版信任状态分流（契约 §4.3 第 2/3 处）：远程项目连接缺失时降级为 null
 * 并回调 onConnectionMissing（由调用方 toast），不阻断后续恢复流程。
 */
export async function loadTrustStatusLenient(
  project: string,
  connections: readonly SshConnectionRef[],
  api: TrustReadApi,
  onConnectionMissing?: (error: Error) => void,
): Promise<TrustStatus | null> {
  if (!isRemoteProject(project)) return api.trustStatus(project)
  const connectionId = resolveSshConnectionId(project, connections)
  if (!connectionId) {
    onConnectionMissing?.(new Error(encodeCodedError("sshConnectionMissing", SSH_CONNECTION_MISSING_FALLBACK)))
    return null
  }
  return api.sshTrustStatus(project, connectionId)
}

/**
 * 信任决策保存分流（契约 §4.3）：project 为 ssh:// 时远程保存，否则走本地
 * trustSave（localProjectPath 允许与展示路径不同，如远端 realpath 后的路径）。
 */
export async function saveTrustDecision(
  project: string,
  localProjectPath: string,
  trusted: boolean,
  trustParent: boolean,
  connections: readonly SshConnectionRef[],
  api: TrustWriteApi,
): Promise<void> {
  if (!isRemoteProject(project)) {
    await api.trustSave(localProjectPath, trusted, trustParent)
    return
  }
  await api.sshTrustSave(project, requireSshConnectionId(project, connections), trusted, trustParent)
}

/**
 * term_create 的连接参数（契约 §3.4）：本地项目恒为 undefined（即使误传也被
 * 后端忽略）；远程项目解析连接 id，缺失时抛 coded error 交由调用方 toast。
 */
export async function terminalConnectionId(
  project: string,
  listConnections: () => Promise<SshConnectionRef[]>,
): Promise<string | undefined> {
  if (!isRemoteProject(project)) return undefined
  return requireSshConnectionId(project, await listConnections())
}
