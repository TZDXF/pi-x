import { killPi, spawnAuxPi, sshConnectionList } from "@/api/piClient"
import {
  auxModelMissing,
  auxModelTarget,
  auxProjectMissing,
  auxWorkspaceContext,
  type AuxModelTarget,
} from "@/lib/auxLaunch"
import { terminalConnectionId } from "@/lib/sshTrust"
import { auxSessionFor, registerAuxRuntimeBridge, type AuxTab } from "@/stores/auxChat"
import type { useWorkspaceStore } from "@/stores/workspace"

/**
 * aux 进程的启动接线（`api/client/process.ts` 的 `spawnAuxPi` 之上的薄封装）。
 *
 * 分工：
 * - **参数**全部走独立字段（Tauri 命令参数），argv 由后端 `aux_launch` 的代码常量
 *   白名单组装；前端只能选 provider/model/thinking 与父会话的 project/workspace。
 * - **失败**原样抛给 `auxChat`（`openAux` 把 coded error 记在 Tab 上、面板显示原因），
 *   这里不吞错、不改写文案。
 * - **关闭**通过注入的 bridge 调 `rpc_kill`：进程生命周期归后端，前端只负责"什么时候
 *   该关"，与 `stores/session.ts` 的进程管理边界一致。
 */
registerAuxRuntimeBridge({ kill: (runtimeId: string) => killPi(runtimeId) })

/** 启动一个 aux 实例需要从父会话带过来的上下文。 */
export interface AuxParentContext {
  /** 父（主）会话 runtimeId。 */
  runtimeId: string
  /** 父会话 cwd（远程为 `ssh://` 展示 URI）。 */
  project: string
  /** 继承的模型选择；`null` 表示父会话还没有可用模型（面板据此报 `auxModelMissing`）。 */
  model: AuxModelTarget | null
  /** 多目录工作区上下文来源（远程 P1 恒不使用）。 */
  workspace?: Pick<ReturnType<typeof useWorkspaceStore>, "projectRoot" | "projectGroups">
}

/**
 * 启动 tab 对应的 aux 进程并完成首次状态握手。
 *
 * `session.init()` 只发 `get_state`/`get_commands`/`get_available_models`/
 * `get_session_stats`/`get_available_thinking_levels`（全部在 Aux 白名单内），
 * 且不读历史（aux 无 session 文件，`--no-session`）。
 */
export async function spawnAuxRuntime(parent: AuxParentContext, tab: AuxTab): Promise<void> {
  if (!parent.project) throw auxProjectMissing()
  if (!parent.model) throw auxModelMissing()
  // 远程项目必须带连接 id（连接选择是远程细节的唯一权威来源）；本地恒为 undefined。
  const sshConnectionId = await terminalConnectionId(parent.project, sshConnectionList)
  await spawnAuxPi({
    parentRuntimeId: parent.runtimeId,
    runtimeId: tab.runtimeId,
    project: parent.project,
    provider: parent.model.provider,
    model: parent.model.model,
    thinking: parent.model.thinking ?? null,
    workspace: auxWorkspaceContext(parent.workspace, parent.project),
    sshConnectionId,
  })
  const session = auxSessionFor(tab.runtimeId)
  session.cwd = parent.project
  session.started = true
  await session.init(parent.project)
}

/** 从父会话 store 提取启动上下文（首次打开与失败重试共用同一份）。 */
export function auxParentContext(
  runtimeId: string,
  project: string,
  session: Parameters<typeof auxModelTarget>[0],
  workspace?: AuxParentContext["workspace"],
): AuxParentContext {
  return { runtimeId, project, model: auxModelTarget(session), workspace }
}
