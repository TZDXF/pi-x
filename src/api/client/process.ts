import { activeRuntimeId } from "@/stores/runtime"
import { invoke } from "../transport"

export interface PiInfo {
  found: boolean
  path: string | null
  version: string | null
  source: "config" | "path" | "fallback" | null
  hint: string
}

export const detectPi = (customPath?: string) => invoke<PiInfo>("pi_detect", { customPath: customPath ?? null })

export interface WorkspaceContext {
  name: string
  primary: string
  roots: string[]
}

export const spawnPi = (
  project: string,
  sessionFile?: string,
  runtimeId = activeRuntimeId.value,
  workspace?: WorkspaceContext,
  /** SSH 远程项目必传：选定连接的唯一权威来源；本地项目不传。 */
  sshConnectionId?: string,
) =>
  invoke<void>("rpc_spawn", {
    project,
    sessionFile: sessionFile ?? null,
    runtimeId,
    workspace: workspace ?? null,
    sshConnectionId: sshConnectionId ?? null,
  })

export const killPi = (runtimeId = activeRuntimeId.value) => invoke<void>("rpc_kill", { runtimeId })

/**
 * aux（辅助对话）进程的启动参数。
 *
 * 每个字段**独立传参**（Tauri 命令参数，不做字符串拼接）：argv 由后端
 * `rpc::aux_launch::aux_extra_args()` 按代码常量白名单组装，前端只能选 provider/model/
 * thinking（`docs/aux-chat-spec.md` §1）。
 */
export interface AuxSpawnOptions {
  /** 父（主）会话 runtimeId：aux 的归属关系，前端注册表/面板/关闭清理按它过滤。 */
  parentRuntimeId: string
  /** aux 自己的 runtimeId，必须 `aux:` 前缀（后端 `aux_spawn` 强校验）。 */
  runtimeId: string
  /** 父会话 cwd（远程为 `ssh://` 展示 URI）；aux 与父会话同目录。 */
  project: string
  /** 继承父会话 state.model 的 provider / model（缺省即 `auxModelMissing`）。 */
  provider: string
  model: string
  /** 继承父会话 thinkingLevel；未设置时不传（后端按 pi 默认）。 */
  thinking?: string | null
  /** 父会话的多目录工作区上下文（仅本地；远程 P1 不支持）。 */
  workspace?: WorkspaceContext
  /** SSH 远程项目必传：连接选择是远程细节的唯一权威来源。 */
  sshConnectionId?: string
}

/**
 * 启动一个 aux 运行时（策略固定 `Aux`，客户端无法翻转）。
 *
 * 失败时后端返回 coded error（`auxPiUnsupported` / `auxModelMissing` /
 * `auxRuntimeIdInvalid` …），调用方按原样展示，不要静默。
 */
export const spawnAuxPi = (options: AuxSpawnOptions) =>
  invoke<void>("aux_spawn", {
    project: options.project,
    runtimeId: options.runtimeId,
    provider: options.provider,
    model: options.model,
    thinking: options.thinking ?? null,
    workspace: options.workspace ?? null,
    sshConnectionId: options.sshConnectionId ?? null,
    // 归属父会话：回收日志与 `aux_list` 的重连过滤按它归类（规格 §5）。
    parentRuntimeId: options.parentRuntimeId,
  })

/** 登记本客户端对某 aux 实例的持有（心跳每 20s 重复调用，后端幂等）。 */
export const auxClaim = (runtimeId: string, clientId: string) => invoke<void>("aux_claim", { runtimeId, clientId })

/**
 * 释放本客户端的租约。关闭实例时**先于** `rpc_kill` 调用（顺序与规格 §5 销毁段一致）：
 * 先 release 再 kill，回收器就不会把一个正在关闭的实例当成"有租约"而跳过，
 * 也不会让残租约留在 `aux_list` 里。
 */
export const auxRelease = (runtimeId: string, clientId: string) => invoke<void>("aux_release", { runtimeId, clientId })

/** 列出全部租约条目（重连时只恢复本机 clientId 且父会话在本地注册表的那几条）。 */
export const auxList = () => invoke<unknown>("aux_list")

export const piRunning = (runtimeId = activeRuntimeId.value) => invoke<boolean>("rpc_running", { runtimeId })

/** Fire-and-forget diagnostic log line, persisted by the backend to ~/.pix/logs. */
export const pixLog = (message: string, runtimeId: string | null = null) => {
  try {
    void invoke("pix_log", { message, runtimeId }).catch(() => {})
  } catch {
    /* tests / offline */
  }
}

export interface RunningSession {
  runtimeId: string
  project: string
  state: import("../protocol").SessionState
  /** Backend-issued identity; updatedAt is Unix time in milliseconds. */
  activity?: {
    status: "running" | "completed" | "error" | "idle"
    runId: string
    updatedAt: number
  }
  pendingUiRequests?: import("../protocol").ExtensionUiRequest[]
}
export const listRunningSessions = () => invoke<RunningSession[]>("rpc_sessions")
