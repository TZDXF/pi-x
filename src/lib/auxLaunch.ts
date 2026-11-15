import { modelKey as formatModelKey } from "@/lib/modelKey"
import { isRemoteProject } from "@/lib/ssh"
import { requireSshConnectionId } from "@/lib/sshTrust"
import { encodeCodedError } from "@/lib/backendError"
import type { WorkspaceContext } from "@/api/piClient"
import type { SessionStore } from "@/stores/session"
import type { useWorkspaceStore } from "@/stores/workspace"

/**
 * aux 启动所需的两块"从父会话推导"的信息：模型选择与工作区上下文。
 *
 * 与 `lib/auxSpawn.ts` 分开是为了让这部分保持**纯逻辑**（单测不需要 transport）：
 * auxLaunch 只算参数，真正调用 `aux_spawn` 的在 auxSpawn。
 */
export interface AuxModelTarget {
  provider: string
  model: string
  thinking?: string
}

type ModelSource = Pick<SessionStore, "currentModel" | "thinkingLevel" | "desiredModelKey" | "offlineDefaultModelKey">

/**
 * 父会话的模型目标：优先 pi 侧报（`get_state.model`），其次用户显式选过的离线默认
 * （懒启动时还没有 `state`）。
 *
 * 无法确定时返回 `null` 而**不**猜一个兜底模型：aux 必须显式指定模型，猜一个会让
 * 用户花错供应商的钱；后端同样以 `auxModelMissing` 拒绝空 provider/model。
 */
export function auxModelTarget(session: ModelSource): AuxModelTarget | null {
  const thinking = session.thinkingLevel
  const model = session.currentModel
  if (model) return { provider: model.provider, model: model.id, ...(thinking ? { thinking } : {}) }
  const key = session.desiredModelKey ?? session.offlineDefaultModelKey
  if (!key) return null
  const separator = key.indexOf("/")
  if (separator <= 0 || separator === key.length - 1) return null
  return { provider: key.slice(0, separator), model: key.slice(separator + 1), ...(thinking ? { thinking } : {}) }
}

/** 诊断/测试用的稳定文本（不含凭据）。 */
export function auxModelTargetKey(target: AuxModelTarget | null) {
  return target ? formatModelKey({ provider: target.provider, id: target.model }) : ""
}

/**
 * aux 的 workspace 上下文：与主会话同一份多目录组定义（链接检出的根补齐规则一致）。
 * 远程项目 P1 不支持多目录组（契约 §3.1 第 4 条），恒为 `undefined`。
 */
export function auxWorkspaceContext(
  workspace: Pick<ReturnType<typeof useWorkspaceStore>, "projectRoot" | "projectGroups"> | undefined,
  project: string,
): WorkspaceContext | undefined {
  if (!project || !workspace || isRemoteProject(project)) return undefined
  const group = workspace.projectGroups[workspace.projectRoot(project)]
  if (!group) return undefined
  const roots = group.folders.some(folder => folder === project || folder === project.replace(/\\/g, "/"))
    ? [...group.folders]
    : [...group.folders, project]
  return { name: group.name, primary: group.primary, roots }
}

/** 父会话尚未就绪（没有 cwd）时 aux 无法启动：与主会话同一 coded error。 */
export function auxProjectMissing(): Error {
  return new Error(encodeCodedError("projectDirMissing", "项目目录不存在"))
}

/** 无法确定模型时的 coded error（面板按 i18n 展示，不静默）。 */
export function auxModelMissing(): Error {
  return new Error(encodeCodedError("auxModelMissing", "辅助对话需要显式指定模型"))
}

/** 远程项目缺连接 id 时的 coded error（与 `terminalConnectionId` 同一语义）。 */
export function auxSshConnectionId(
  project: string,
  connections: Parameters<typeof requireSshConnectionId>[1],
): string | undefined {
  if (!isRemoteProject(project)) return undefined
  return requireSshConnectionId(project, connections)
}
