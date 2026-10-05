import { normalizeProjectPath } from "@/lib/paths"
import { isSshProject } from "@/lib/ssh"
import type { Ref } from "vue"
import type { AppConfig, TrustStatus } from "@/api/piClient"
import type { WorkspacePhase } from "@/lib/workspaceRuntime"
import type { ProjectGroup } from "@/stores/workspace"

type WorkspaceStore = ReturnType<typeof import("@/stores/workspace").useWorkspaceStore>
type UiStore = ReturnType<typeof import("@/stores/conversations").useUiStore>
type PiClient = typeof import("@/api/piClient")

interface UseProjectActionsContext {
  workspace: WorkspaceStore
  session: ReturnType<typeof import("@/stores/conversations").useSessionStore>
  phase: Ref<WorkspacePhase>
  connecting: Ref<boolean>
  selectingProject: Ref<boolean>
  navigating: Ref<boolean>
  project: Ref<string>
  config: Ref<AppConfig>
  trustInfo: Ref<TrustStatus | null>
  lastError: Ref<string | null>
  /** Whether the active conversation's pi worker is already running. */
  started: Ref<boolean>
  projectDialogOpen: Ref<boolean>
  editingProjectPath: Ref<string | null>
  ui: UiStore
  t(key: string): string
  translateError(error: unknown): string
  api: Pick<PiClient, "saveConfig" | "trustStatus" | "chooseDirectoryPath" | "getConfig">
  projectRoute(project: string): string
  goHome(replace?: boolean): void
  createConversation: typeof import("@/stores/conversations").createConversation
  pendingResume: Ref<string | null>
  requestConversationNavigation(path: string, action: () => Promise<unknown>): void
}

/** Project-level actions: selection, switching, the project-group dialog and
 *  the projectless entry points. */
export function useProjectActions(context: UseProjectActionsContext) {
  const {
    workspace,
    session,
    phase,
    connecting,
    selectingProject,
    navigating,
    project,
    config,
    trustInfo,
    lastError,
    started,
    projectDialogOpen,
    editingProjectPath,
    ui,
    t,
    translateError: tBackendError,
    api: { saveConfig, trustStatus, chooseDirectoryPath, getConfig },
    projectRoute,
    goHome,
    createConversation,
    pendingResume,
    requestConversationNavigation,
  } = context

  async function selectProject(dir: string) {
    dir = normalizeProjectPath(dir)
    // 空目录（如无项目目录尚未解析完成）不能创建会话，否则 spawn 必然失败。
    if (!dir) return
    if (workspace.gitBusy || connecting.value) return
    connecting.value = true
    selectingProject.value = true
    phase.value = "chat"
    try {
      // Selecting a project creates an independent, lazily started draft.
      createConversation(dir)
      project.value = dir
      // Route replays can land on a removed project; the sidebar keeps it
      // removed, so it must not become the auto-restored project either.
      if (!workspace.isRemovedProject(dir)) {
        config.value.lastProject = dir
        // Await so quick successive selections cannot persist out of order.
        await saveConfig({ ...config.value })
      }
      // 远程项目 P1 跳过信任决策，直接进入会话（契约 §4.2）。
      if (isSshProject(dir)) {
        phase.value = "chat"
        if (!started.value) void session.loadOfflineModels()
        return
      }
      const status = await trustStatus(dir)
      if (status.needsDecision) {
        trustInfo.value = status
        phase.value = "trust"
        return
      }
      phase.value = "chat"
      // pi starts lazily on first submit; still fill the model picker now.
      if (!started.value) void session.loadOfflineModels()
    } catch (e) {
      lastError.value = tBackendError(e)
      ui.pushToast(tBackendError(e), "error")
      phase.value = "down"
    } finally {
      selectingProject.value = false
      connecting.value = false
    }
  }

  async function switchProject() {
    if (workspace.gitBusy || navigating.value || connecting.value) return
    // 项目组关闭时退化为直接选择目录：不弹项目组对话框。配置可能刚在设置页
    // 改过，这里读最新值而不是启动时缓存的副本。
    const groupsEnabled = await getConfig()
      .then(cfg => cfg.workspaceGroups !== false)
      .catch(() => true)
    if (!groupsEnabled) {
      navigating.value = true
      try {
        const path = await chooseDirectoryPath(t("welcome.openFolderTitle"))
        if (!path) return
        const dir = normalizeProjectPath(path)
        // 显式添加的目录即使曾被移除也重新出现，与项目组的保存行为一致。
        workspace.unremoveProject(dir)
        await workspace.rememberWorkspace(dir)
        await selectProject(dir)
      } catch (e) {
        ui.pushToast(tBackendError(e), "error")
      } finally {
        navigating.value = false
      }
      return
    }
    editingProjectPath.value = null
    projectDialogOpen.value = true
  }

  /** 无项目会话：不选文件夹，直接在 PiX 的工作目录（默认 ~/.pix/workspace）中开始。 */
  async function openProjectless() {
    if (workspace.gitBusy || navigating.value || connecting.value || phase.value === "trust") return
    navigating.value = true
    try {
      await selectProject(await workspace.ensureProjectless())
    } catch (e) {
      ui.pushToast(tBackendError(e), "error")
    } finally {
      navigating.value = false
    }
  }

  async function openProjectlessFromSidebar() {
    if (workspace.gitBusy || navigating.value || connecting.value || phase.value === "trust") return
    const path = await workspace.ensureProjectless().catch(e => {
      ui.pushToast(tBackendError(e), "error")
      return ""
    })
    if (path) requestConversationNavigation(projectRoute(path), () => selectProject(path))
  }

  function editProject(path: string) {
    if (workspace.gitBusy || navigating.value || connecting.value) return
    editingProjectPath.value = path
    projectDialogOpen.value = true
  }

  async function saveProject(group: ProjectGroup) {
    try {
      const oldPath = editingProjectPath.value
      if (oldPath) {
        const activeGroup = workspace.projectRoot(project.value) === oldPath
        workspace.updateProject(oldPath, group)
        projectDialogOpen.value = false
        editingProjectPath.value = null
        for (const folder of group.folders) void workspace.refresh(folder).catch(console.warn)
        if (activeGroup && group.primary !== project.value) await selectProject(group.primary)
      } else {
        workspace.createProject(group)
        projectDialogOpen.value = false
        await selectProject(group.primary)
      }
    } catch (e) {
      ui.pushToast(tBackendError(e), "error")
    }
  }

  // Removing a project only removes its navigation entry, never files or logs.
  async function removeProject(path: string) {
    if (workspace.gitBusy || navigating.value || connecting.value) return
    navigating.value = true
    try {
      const removingActive = workspace.projectRoot(project.value) === path
      // A removed project must not come back on the next launch either, even
      // when lastProject merely pointed at it while another project was active.
      if (removingActive || (config.value.lastProject && workspace.projectRoot(config.value.lastProject) === path)) {
        const nextConfig = { ...config.value, lastProject: undefined }
        // Persist before altering UI so a failure does not silently re-open the project.
        await saveConfig(nextConfig)
        // Removing a navigation entry does not cancel background conversations.
        config.value = nextConfig
      }
      if (removingActive) {
        pendingResume.value = null
        trustInfo.value = null
        project.value = ""
        phase.value = "pick"
        // Replace the stale conversation route so Back/Forward or a reload
        // cannot replay the removed project into the sidebar.
        goHome(true)
      }
      workspace.removeProject(path)
    } catch (e) {
      ui.pushToast(tBackendError(e), "error")
    } finally {
      navigating.value = false
    }
  }

  return {
    selectProject,
    switchProject,
    openProjectless,
    openProjectlessFromSidebar,
    editProject,
    saveProject,
    removeProject,
  }
}
