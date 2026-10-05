import { ref, type Ref } from "vue"
import type { AppConfig, TrustStatus, WorkspaceContext, WorkspaceGitInfo, WorkspaceSelection } from "@/api/piClient"
import type { SessionStore } from "@/stores/session"
import type { WorkspacePhase } from "@/lib/workspaceRuntime"
import { normalizeProjectPath, samePath } from "@/lib/paths"
import { isSshProject, resolveSshConnectionId } from "@/lib/ssh"
import { encodeCodedError } from "@/lib/backendError"

/** 毫秒计时；部分测试 VM 环境没有 performance 全局。 */
const nowMs = () => (typeof performance === "undefined" ? Date.now() : performance.now())

type Api = typeof import("@/api/piClient")
type Conversations = typeof import("@/stores/conversations")
interface StartupContext {
  api: Pick<
    Api,
    | "prepareWorkspaceGit"
    | "workspaceGitInfo"
    | "killPi"
    | "spawnPi"
    | "trustStatus"
    | "trustSave"
    | "saveConfig"
    | "pixLog"
  >
  conversations: Pick<Conversations, "sessionFor" | "uiFor" | "activeRuntimeId">
  workspace: ReturnType<typeof import("@/stores/workspace").useWorkspaceStore>
  phase: Ref<WorkspacePhase>
  config: Ref<AppConfig>
  project: Ref<string>
  connecting: Ref<boolean>
  selectingProject: Ref<boolean>
  lastError: Ref<string | null>
  pushToast(message: string, type: "error"): void
  translate(key: string): string
  translateError(message: string): string
  rebuildConversation(owner: SessionStore): Promise<void>
}

/** Starts a conversation in its selected workspace, preserving checkout retries and trust. */
export function createWorkspaceStartup(context: StartupContext) {
  const {
    workspace,
    phase,
    config,
    project,
    connecting,
    selectingProject,
    lastError,
    rebuildConversation,
    translate: t,
    translateError: tBackendError,
  } = context
  const ui = { pushToast: context.pushToast }
  const { prepareWorkspaceGit, workspaceGitInfo, killPi, spawnPi, trustStatus, trustSave, saveConfig, pixLog } =
    context.api
  const { sessionFor, uiFor, activeRuntimeId } = context.conversations
  const runtimeWorkspaces = new Map<string, string>()
  function contextFor(dir: string): WorkspaceContext | undefined {
    const group = workspace.projectGroups[workspace.projectRoot(dir)]
    if (!group) return undefined
    // A linked checkout must belong to the runtime's declared roots too.
    const roots = group.folders.some(path => samePath(path, dir)) ? [...group.folders] : [...group.folders, dir]
    return { name: group.name, primary: group.primary, roots }
  }
  function contextSignature(dir: string) {
    return JSON.stringify(contextFor(dir) ?? null)
  }
  /** 远程项目的 spawn 必须携带连接 id；SSH 连接是连接细节的唯一权威来源（契约 §3.1）。 */
  function sshConnectionIdFor(dir: string): string {
    const connectionId = resolveSshConnectionId(dir, config.value.sshConnections ?? [])
    if (!connectionId)
      throw new Error(encodeCodedError("sshConnectionMissing", "远程项目没有匹配的 SSH 连接，请在设置中检查连接配置"))
    return connectionId
  }
  async function spawnWorkspacePi(dir: string, file?: string, runtimeId = activeRuntimeId.value) {
    // 空目录传给后端会让 CreateProcess 报晦涩的 os error 123；在入口统一拦截。
    if (!dir) throw new Error(encodeCodedError("projectDirMissing", "项目目录不存在"))
    // 远程项目：P1 不支持多目录组，workspace 恒为 null（契约 §3.1 第 4 条）。
    if (isSshProject(dir)) {
      const connectionId = sshConnectionIdFor(dir)
      await spawnPi(dir, file, runtimeId, undefined, connectionId)
      runtimeWorkspaces.set(runtimeId, JSON.stringify(null))
      return
    }
    const context = contextFor(dir)
    await spawnPi(dir, file, runtimeId, context)
    runtimeWorkspaces.set(runtimeId, JSON.stringify(context ?? null))
  }

  // Keep the composer mounted while asking about resources in the new checkout.
  const workspaceTrust = ref<TrustStatus | null>(null)
  let resolveWorkspaceTrust: ((allowed: boolean) => void) | undefined
  function finishWorkspaceTrust(allowed: boolean) {
    workspaceTrust.value = null
    resolveWorkspaceTrust?.(allowed)
    resolveWorkspaceTrust = undefined
  }
  async function decideWorkspaceTrust(trusted: boolean, trustParent: boolean) {
    try {
      if (workspaceTrust.value) await trustSave(workspaceTrust.value.projectPath, trusted, trustParent)
      finishWorkspaceTrust(trusted)
    } catch (e) {
      ui.pushToast(String(e), "error")
      finishWorkspaceTrust(false)
    }
  }
  function requestWorkspaceTrust(status: TrustStatus): Promise<boolean> {
    return new Promise(resolve => {
      // Only one startup can own the dialog; reject an abandoned previous request.
      finishWorkspaceTrust(false)
      resolveWorkspaceTrust = resolve
      workspaceTrust.value = status
    })
  }
  // Cache successful creation before later initialization/trust steps. Retrying a
  // failed first send must reuse its checkout, not create another one.
  const preparedWorkspaces = new Map<string, { key: string; path: string }>()
  /** 单屏入口：始终启动当前激活会话。 */
  async function start(selection?: WorkspaceSelection | null): Promise<boolean> {
    return startSession(activeRuntimeId.value, selection)
  }

  /** 指定会话的启动流程；分屏时各窗格携带各自 runtimeId 调用，行为与激活会话一致。 */
  async function startSession(runtimeId: string, selection?: WorkspaceSelection | null): Promise<boolean> {
    const sessionStart = nowMs()
    pixLog(`[perf] startSession begin selection=${selection?.branch ?? "-"}`, runtimeId)
    if (workspace.gitBusy || connecting.value || selectingProject.value || phase.value !== "chat") return false
    // 远程项目必须无 branch/worktree 选择（契约 §5）；正常入口不会产生，这里兜底校验。
    if (selection?.project && isSshProject(selection.project) && (selection.branch || selection.worktree)) {
      ui.pushToast(t("ssh.gitUnavailable"), "error")
      return false
    }
    if (selection?.worktree && !selection.branch) {
      ui.pushToast(t("workspace.selectBaseBranch"), "error")
      return false
    }
    if (!selection || !selection.branch) return startRuntime(runtimeId)
    const owner = sessionFor(runtimeId)
    if (owner.entries.length || owner.promptQueue.length || owner.isStreaming) return startRuntime(runtimeId)
    workspace.gitBusy = true
    connecting.value = true
    try {
      const prepStart = nowMs()
      const key = JSON.stringify(selection)
      const cached = preparedWorkspaces.get(owner.runtimeId)
      let path = cached?.key === key ? cached.path : undefined
      let knownInfo: WorkspaceGitInfo | undefined
      if (!path || !selection.worktree) {
        const info = await workspaceGitInfo(selection.project)
        // An unchanged local selection doesn't switch away from an existing checkout.
        path =
          !selection.worktree && info.branch === selection.branch
            ? selection.project
            : await prepareWorkspaceGit(selection)
        path = normalizeProjectPath(path)
        preparedWorkspaces.set(owner.runtimeId, { key, path })
        // 本地模式查的是同一目录，直接复用；worktree 模式要重新查一次，
        // 新 worktree 才会出现在 worktrees 列表里。
        if (samePath(path, selection.project)) knownInfo = info
      }
      pixLog(`[perf] startSession workspace prep ${Math.round(nowMs() - prepStart)}ms path=${path}`, runtimeId)
      // The user explicitly picked this folder, so lift any earlier removal marker.
      workspace.unremoveProject(path)
      await workspace.rememberWorkspace(path, knownInfo)
      // 远程项目 P1 跳过信任决策，直接 spawn（契约 §4.2）。
      if (!isSshProject(path)) {
        const status = await trustStatus(path)
        if (status.needsDecision) {
          const allowed = await requestWorkspaceTrust(status)
          if (!allowed) return false
        }
      }
      // Completion may already have started an empty worker in the original cwd.
      // Reuse the conversation identity (and composer), but never that old worker.
      if (owner.started) await killPi(owner.runtimeId)
      owner.started = false
      owner.clear()
      owner.cwd = path
      project.value = path
      config.value.lastProject = path
      await saveConfig({ ...config.value })
      return await startRuntime(runtimeId)
    } catch (e) {
      lastError.value = String(e)
      uiFor(owner.runtimeId).pushToast(tBackendError(String(e)), "error")
      return false
    } finally {
      connecting.value = false
      workspace.gitBusy = false
      pixLog(`[perf] startSession total ${Math.round(nowMs() - sessionStart)}ms`, runtimeId)
    }
  }

  async function startRuntime(runtimeId: string): Promise<boolean> {
    const runtimeStart = nowMs()
    // Completion can request a runtime while the draft remains editable.
    if (selectingProject.value || phase.value !== "chat") return false
    const owner = sessionFor(runtimeId)
    if (owner.started && runtimeWorkspaces.get(owner.runtimeId) === contextSignature(owner.cwd || project.value))
      return true
    if (owner.started && owner.isStreaming) {
      return true
    }
    if (owner.started && owner.sessionFile) {
      try {
        await rebuildConversation(owner)
        return owner.started
      } catch (error) {
        uiFor(owner.runtimeId).pushToast(String(error), "error")
        return false
      } finally {
        pixLog(`[perf] startRuntime rebuild ${Math.round(nowMs() - runtimeStart)}ms`, runtimeId)
      }
    }
    if (owner.started) {
      await killPi(owner.runtimeId)
      owner.started = false
    }
    connecting.value = true
    try {
      const spawnStart = nowMs()
      await spawnWorkspacePi(owner.cwd || project.value, undefined, owner.runtimeId)
      pixLog(`[perf] spawnWorkspacePi ${Math.round(nowMs() - spawnStart)}ms`, runtimeId)
      await owner.init(owner.cwd || project.value, true)
      owner.started = true
      return true
    } catch (e) {
      await killPi(owner.runtimeId).catch(() => {})
      owner.started = false
      lastError.value = String(e)
      uiFor(owner.runtimeId).pushToast(String(e), "error")
      return false
    } finally {
      connecting.value = false
      pixLog(`[perf] startRuntime total ${Math.round(nowMs() - runtimeStart)}ms`, runtimeId)
    }
  }

  return {
    start,
    startSession,
    startRuntime,
    spawnWorkspacePi,
    workspaceTrust,
    requestWorkspaceTrust,
    decideWorkspaceTrust,
    finishWorkspaceTrust,
  }
}
