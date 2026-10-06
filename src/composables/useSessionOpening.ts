import { normalizeProjectPath } from "@/lib/paths"
import { isSshProject } from "@/lib/ssh"
import { loadTrustStatusLenient } from "@/lib/sshTrust"
import { createUuid } from "@/lib/uuid"
import { splitAtEdge, isMember, leafByRuntime, firstLeafRuntime, closePane, splitView } from "@/stores/splitView"
import type { Ref } from "vue"
import type { AppConfig, TrustStatus } from "@/api/piClient"
import type { WorkspacePhase } from "@/lib/workspaceRuntime"

type WorkspaceStore = ReturnType<typeof import("@/stores/workspace").useWorkspaceStore>
type UiStore = ReturnType<typeof import("@/stores/conversations").useUiStore>
type PiClient = typeof import("@/api/piClient")
type Conversations = typeof import("@/stores/conversations")
type SessionStore = ReturnType<Conversations["sessionFor"]>
type ConversationLoader = ReturnType<typeof import("@/lib/conversationLoader").createConversationLoader<SessionStore>>

/** Active conversation before resumeSession paused on a trust decision; the
 *  user rejecting trust must not leave the untrusted session activated. */
export interface TrustActivationBackup {
  owner: { sessionFile: string | null }
  prevOwnerFile: string | null
  prevActive: string
  prevProject: string
}

interface UseSessionOpeningContext {
  workspace: WorkspaceStore
  phase: Ref<WorkspacePhase>
  connecting: Ref<boolean>
  navigating: Ref<boolean>
  project: Ref<string>
  config: Ref<AppConfig>
  trustInfo: Ref<TrustStatus | null>
  lastError: Ref<string | null>
  pendingResume: Ref<string | null>
  trustActivationBackup: Ref<TrustActivationBackup | null>
  activeRuntimeId: Ref<string>
  ui: UiStore
  t(key: string): string
  translateError(error: unknown): string
  api: Pick<PiClient, "saveConfig" | "trustStatus" | "sshTrustStatus" | "exportSessionFileHtml">
  conversations: Pick<
    Conversations,
    "sessionFor" | "findConversation" | "activateSession" | "createConversation" | "pruneDormantConversations"
  >
  session: ReturnType<Conversations["useSessionStore"]>
  conversationLoader: ConversationLoader
  requestWorkspaceTrust(info: TrustStatus, sshProject?: string | null): Promise<boolean>
  selectProject(dir: string): Promise<void>
}

/** Opening conversations: resuming saved sessions (including trust rollback),
 *  split panes, queued drafts and sidebar actions on saved files. */
export function useSessionOpening(context: UseSessionOpeningContext) {
  const {
    workspace,
    phase,
    connecting,
    navigating,
    project,
    config,
    trustInfo,
    lastError,
    pendingResume,
    trustActivationBackup,
    activeRuntimeId,
    ui,
    t,
    translateError: tBackendError,
    api: { saveConfig, trustStatus, sshTrustStatus, exportSessionFileHtml },
    conversations: { sessionFor, findConversation, activateSession, createConversation, pruneDormantConversations },
    session,
    conversationLoader,
    requestWorkspaceTrust,
    selectProject,
  } = context

  /** 信任状态查询（契约 §4.3）：本地照旧；远程调 ssh_trust_status，连接缺失降级 null 并 toast。 */
  async function trustStatusFor(dir: string): Promise<TrustStatus | null> {
    return loadTrustStatusLenient(dir, config.value.sshConnections ?? [], { trustStatus, sshTrustStatus }, error =>
      ui.pushToast(tBackendError(error), "error"),
    )
  }

  /** Activate a saved conversation, reusing or spawning its independent worker. */
  async function resumeSession(file: string, targetProject?: string) {
    if (workspace.gitBusy || navigating.value || connecting.value) return
    // Snapshot the active state: a failed open must restore it, or the "ghost"
    // activation survives and later navigation replays an empty conversation.
    const prevPhase = phase.value
    const prevActive = activeRuntimeId.value
    const prevProject = project.value
    const prevLastProject = config.value.lastProject
    const existing = findConversation(file)
    const prevOwnerFile = existing?.sessionFile ?? null
    phase.value = "chat"
    connecting.value = true
    let owner = existing
    try {
      const dir = normalizeProjectPath(targetProject || owner?.cwd || project.value)
      const changingProject = dir !== project.value
      if (!owner) owner = createConversation(dir)
      // Select the saved identity before any asynchronous work, never a draft.
      owner.sessionFile = file
      activateSession(owner.runtimeId)
      project.value = dir
      if (changingProject) {
        if (!workspace.isRemovedProject(dir)) {
          config.value.lastProject = dir
          await saveConfig({ ...config.value })
        }
        // 远程项目走远程信任命令（契约 §4.3）；连接缺失时降级为 null 继续。
        const status = await trustStatusFor(dir)
        if (status?.needsDecision) {
          trustInfo.value = status
          pendingResume.value = file
          trustActivationBackup.value = {
            owner,
            prevOwnerFile: existing ? prevOwnerFile : null,
            prevActive,
            prevProject,
          }
          phase.value = "trust"
          return
        }
      }
      owner = await conversationLoader.load(owner, file, dir)
      activateSession(owner.runtimeId)
      project.value = owner.cwd
    } catch (e) {
      // Opening the conversation failed — an IPC hiccup counts. The pi process
      // is still alive, so stay interactive and surface the error; a real exit
      // is reported by the pi-exit listener, which owns the "down" phase.
      const message = tBackendError(e)
      lastError.value = message
      ui.pushToast(message, "error")
      if (owner) owner.sessionFile = existing ? prevOwnerFile : null
      activateSession(prevActive)
      project.value = prevProject
      config.value.lastProject = prevLastProject
      phase.value = prevPhase === "detecting" ? "pick" : prevPhase
    } finally {
      connecting.value = false
    }
  }

  /** Load a saved conversation without changing the active pane or project.
   * Uses the same worker loader and disk reconciliation as ordinary navigation. */
  async function ensureSessionForSplit(file: string, targetProject?: string): Promise<string | null> {
    if (workspace.gitBusy || navigating.value || connecting.value) return null
    connecting.value = true
    let owner = findConversation(file)
    try {
      const dir = normalizeProjectPath(targetProject || owner?.cwd || project.value)
      if (!owner) {
        pruneDormantConversations()
        owner = sessionFor(createUuid())
        owner.cwd = dir
      }
      owner.sessionFile = file
      if (!owner.started) {
        // 远程项目走远程信任命令（契约 §4.3）；本地照旧。
        const status = await trustStatusFor(dir)
        if (status?.needsDecision) {
          const allowed = await requestWorkspaceTrust(status, isSshProject(dir) ? dir : null)
          if (!allowed) return null
        }
      }
      owner = await conversationLoader.load(owner, file, dir)
      return owner.runtimeId
    } catch (e) {
      ui.pushToast(tBackendError(e), "error")
      return null
    } finally {
      connecting.value = false
    }
  }

  /** Drop a session onto a pane edge: grow the split tree around the target. */
  async function handleSplitDrop(
    payload: { file: string; path: string },
    zone: "left" | "right" | "top" | "bottom",
    targetRuntimeId: string,
  ) {
    const newId = await ensureSessionForSplit(payload.file, payload.path)
    if (!newId) return
    if (!splitAtEdge(targetRuntimeId, zone, newId)) {
      if (isMember(newId)) ui.pushToast(t("chat.toastAlreadyInSplit"), "warning")
      return
    }
    activateSession(newId)
  }

  function closeSplitPane(runtimeId: string) {
    const leaf = leafByRuntime(runtimeId)
    if (!leaf) return
    closePane(leaf.id)
    if (!leafByRuntime(activeRuntimeId.value) && splitView.tree) {
      const fallback = firstLeafRuntime()
      if (fallback) activateSession(fallback)
    }
  }

  async function selectQueuedConversation(runtimeId: string) {
    if (workspace.gitBusy || connecting.value) return
    const owner = sessionFor(runtimeId)
    activateSession(runtimeId)
    project.value = owner.cwd
    phase.value = "chat"
  }

  /** Export a sidebar session directly from its saved file. Never change the
   * active project or conversation just to perform an action on that file. */
  async function openSessionAction(file: string, action: "export") {
    if (action !== "export") return
    try {
      if (await exportSessionFileHtml(file, t("chat.exportDirectory"))) ui.pushToast(t("chat.toastExported"), "info")
    } catch (error) {
      ui.pushToast(tBackendError(error), "error")
    }
  }

  async function newProjectSession(path: string) {
    path = normalizeProjectPath(path)
    if (!path) return
    if (workspace.gitBusy || navigating.value || connecting.value) return
    navigating.value = true
    try {
      if (path !== project.value) await selectProject(path)
      if (phase.value === "chat") {
        // "New session" creates nothing until the first message is sent: reuse
        // the pristine draft instead of accumulating empty conversations.
        const active = sessionFor(activeRuntimeId.value)
        const pristine = !active.started && !active.sessionFile && !active.entries.length
        if (!pristine || active.cwd !== path) createConversation(path)
        void session.loadOfflineModels()
      }
    } catch (e) {
      ui.pushToast(tBackendError(e), "error")
    } finally {
      navigating.value = false
    }
  }

  return {
    resumeSession,
    ensureSessionForSplit,
    handleSplitDrop,
    closeSplitPane,
    selectQueuedConversation,
    openSessionAction,
    newProjectSession,
  }
}
