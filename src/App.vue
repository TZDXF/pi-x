<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useMediaQuery, useWindowSize } from "@vueuse/core"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useWorkspaceSidebarLayout } from "@/composables/useWorkspaceSidebarLayout"
import {
  detectPi,
  prepareWorkspaceGit,
  workspaceGitInfo,
  chooseDirectoryPath,
  exportSessionFileHtml,
  listRunningSessions,
  getConfig,
  killPi,
  onPiEvent,
  pixLog,
  onPiExit,
  onPiStderr,
  onReconnected,
  onSessionsChanged,
  saveConfig,
  sessionMtime,
  setTrayLabels,
  toggleDevtools,
  spawnPi,
  trustSave,
  trustStatus,
} from "@/api/piClient"
import type { AppConfig, TrustStatus } from "@/api/piClient"
import {
  useSessionStore,
  sessionFor,
  uiFor,
  activeRuntimeId,
  activateSession,
  createConversation,
  findConversation,
  peekConversation,
  pruneDormantConversations,
} from "@/stores/conversations"
import {
  splitView,
  splitAtEdge,
  isMember,
  leafByRuntime,
  firstLeafRuntime,
  restoreIfMember,
  suspend,
  closePane,
  type PaneLeaf,
} from "@/stores/splitView"
import { createWorkspaceStartup } from "@/lib/workspaceStartup"
import { createWorkspaceRuntime, type WorkspacePhase } from "@/lib/workspaceRuntime"
import { createConversationLoader } from "@/lib/conversationLoader"
import { createUuid } from "@/lib/uuid"
import { focusComposer } from "@/lib/composer"
import { useWorkspaceStore, registerSessionMtimeSync, type ProjectGroup } from "@/stores/workspace"
import { useUiStore } from "@/stores/conversations"
import WelcomeView from "@/components/WelcomeView.vue"
import CreateProjectDialog from "@/components/CreateProjectDialog.vue"
import TrustDialog from "@/components/TrustDialog.vue"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import WorkspaceSidebar from "@/components/WorkspaceSidebar.vue"
import SettingsPage from "@/components/SettingsPage.vue"
import ScheduledTasksPage from "@/components/ScheduledTasksPage.vue"
import { Button } from "@/components/ui/button"
import ChatView from "@/components/ChatView.vue"
import SplitChatLayout from "@/components/SplitChatLayout.vue"
import WindowTitleBar from "@/components/WindowTitleBar.vue"
import { useRoute, navigate, goHome, projectRoute, sessionRoute } from "@/lib/router"
import { acknowledgeSessionRunStatus, sessionRunStatus } from "@/stores/sessionRunStatus"
import { developerModeEnabled } from "@/lib/developerMode"
import { isDesktop } from "@/api/transport"
import { normalizeProjectPath } from "@/lib/paths"
import { tBackendError } from "@/i18n"
import { dispatchShortcut, registerShortcutHandler } from "@/lib/shortcuts"

const route = useRoute()

type Phase = WorkspacePhase

const session = useSessionStore()
const workspace = useWorkspaceStore()
const navigating = ref(false)
const pendingResume = ref<string | null>(null)
const ui = useUiStore()
const { t } = useI18n()

const rightSidebarOpen = ref(false)
const sidebarOpen = ref(true)
const projectDialogOpen = ref(false)
const editingProjectPath = ref<string | null>(null)

const { width: windowWidth } = useWindowSize()
const isNarrowViewport = useMediaQuery("(max-width: 640px)")
const {
  SIDEBAR_MIN_WIDTH,
  sidebarVisible,
  sidebarMaxWidth,
  preferredSidebarWidth,
  defaultSidebarWidth,
  sidebarPanel,
  onSidebarResize,
  resizeSidebarWithKeyboard,
} = useWorkspaceSidebarLayout(sidebarOpen, route, windowWidth, isNarrowViewport)

function closeProjectDialog() {
  projectDialogOpen.value = false
  editingProjectPath.value = null
}

const phase = ref<Phase>("detecting")
const config = ref<AppConfig>({})
const project = ref("")
const trustInfo = ref<TrustStatus | null>(null)
const lastError = ref<string | null>(null)

const started = computed({
  get: () => session.started,
  set: value => {
    session.started = value
  },
})
const connecting = ref(false)
const selectingProject = ref(false)
// A terminal badge represents an unread result, not a permanent session state.
watch(
  () => {
    if (
      phase.value !== "chat" ||
      (route.value.name !== "home" && route.value.name !== "session" && route.value.name !== "project") ||
      connecting.value ||
      navigating.value
    )
      return null
    const file = session.sessionFile
    const status = file ? sessionRunStatus(file) : undefined
    return status === "completed" || status === "error" ? file : null
  },
  file => acknowledgeSessionRunStatus(file),
  { immediate: true },
)
const startup = createWorkspaceStartup({
  api: { prepareWorkspaceGit, workspaceGitInfo, killPi, spawnPi, trustStatus, trustSave, saveConfig, pixLog },
  conversations: { sessionFor, uiFor, activeRuntimeId },
  workspace,
  phase,
  config,
  project,
  connecting,
  selectingProject,
  lastError,
  pushToast: (message, type) => ui.pushToast(message, type),
  translate: t,
  translateError: tBackendError,
  rebuildConversation: owner => runtimeLifecycle.rebuildConversation(owner),
})
const {
  start,
  startSession,
  spawnWorkspacePi,
  workspaceTrust,
  requestWorkspaceTrust,
  decideWorkspaceTrust,
  finishWorkspaceTrust,
} = startup

// event listener lifecycle: always unlisten on unmount, otherwise HMR
// remounts stack duplicate listeners and events get handled N times
let disposed = false

const runtimeLifecycle = createWorkspaceRuntime({
  api: {
    listRunningSessions,
    killPi,
    onPiEvent,
    onPiExit,
    onPiStderr,
    onReconnected,
    onSessionsChanged,
    pixLog,
    sessionMtime,
  },
  conversations: { sessionFor, uiFor, findConversation, activateSession, activeRuntimeId },
  workspace,
  phase,
  config,
  project,
  connecting,
  navigating,
  lastError,
  isDisposed: () => disposed,
  spawnWorkspacePi,
  translateError: tBackendError,
  registerSessionMtimeSync,
})
const { reattachRunningSessions, rebuildConversation } = runtimeLifecycle

onMounted(async () => {
  try {
    config.value = await getConfig()
  } catch {
    config.value = {}
  }
  // 解析（并由后端按需创建）无项目会话目录，让欢迎页与侧栏入口随时可用。
  void workspace.ensureProjectless().catch(e => console.warn("[pi] failed to resolve the no-project directory:", e))
  void setTrayLabels(t("tray.show"), t("tray.quit")).catch(() => {})

  try {
    await runtimeLifecycle.listen()

    // Reattach after UI reload / remote connection without spawning duplicates.
    const restored = await reattachRunningSessions()
    if (restored) {
      const file = restored.state.sessionFile
      navigate(sessionRoute(file ?? restored.runtimeId, restored.project), true)
      return
    }
    // A reload keeps its conversation deep link instead of falling back silently.
    const initialRoute = route.value
    if (initialRoute.name === "session" && initialRoute.params.conversation) {
      const target = initialRoute.params.project || config.value.lastProject || ""
      if (target) {
        project.value = target
        await workspace.rememberWorkspace(target)
      }
      await resumeSession(initialRoute.params.conversation, target)
      return
    }
    if (initialRoute.name === "project" && initialRoute.params.project) {
      await selectProject(initialRoute.params.project)
      navigate(projectRoute(initialRoute.params.project), true)
      return
    }
    // Restore the workspace only; start pi when a conversation is opened.
    if (config.value.lastProject) {
      project.value = config.value.lastProject
      await selectProject(project.value)
      navigate(projectRoute(project.value), true)
      return
    }

    const info = await detectPi(config.value.piPath)
    phase.value = info.found ? "pick" : "no-pi"
  } catch (e) {
    lastError.value = String(e)
    phase.value = "down"
  }
})

// Serialize backend switches, but keep navigation clickable and retain the latest choice.
let queuedNavigation: (() => Promise<unknown>) | null = null
const navigationRunning = ref(false)
function requestNavigation(action: () => Promise<unknown>) {
  if (workspace.gitBusy || phase.value === "trust") return
  queuedNavigation = action
  void drainNavigation()
}

/** Push the conversation route first so browser back/forward replays it. */
let suppressRouteAction = false
function requestConversationNavigation(path: string, action: () => Promise<unknown>) {
  if (workspace.gitBusy || phase.value === "trust") return
  suppressRouteAction = true
  // The initial home entry is only a shell state; make the first project route replace it.
  navigate(path, route.value.name === "home")
  requestNavigation(action)
  void nextTick(() => {
    suppressRouteAction = false
  })
}

/** Route changes from sidebar clicks are handled by `action`; history changes replay here. */
watch(route, next => {
  if (suppressRouteAction || (next.name !== "session" && next.name !== "project")) return
  requestNavigation(() => followConversationRoute(next))
})

async function followConversationRoute(next: ReturnType<typeof useRoute>["value"]) {
  if (next.name === "session" && next.params.conversation) {
    const id = next.params.conversation
    const targetProject = next.params.project || project.value
    // History entries carry a runtime id for live conversations and a session
    // file for saved ones. Resolve both to the in-memory store first: passing
    // a runtime id to resumeSession (or a file path to selectQueuedConversation)
    // would open a wrong, fresh conversation instead of replaying history.
    const owner = peekConversation(id)
    if (owner) {
      // Dormant stores with a saved file must go through resume so the worker
      // reattaches or respawns; live ones (and file-less pending ones) activate
      // directly, mirroring the sidebar's pending-conversation click.
      if (!owner.started && owner.sessionFile) return resumeSession(owner.sessionFile, targetProject)
      return selectQueuedConversation(owner.runtimeId)
    }
    return resumeSession(id, targetProject)
  }
  if (next.name === "project" && next.params.project) return newProjectSession(next.params.project)
}

async function drainNavigation() {
  if (navigationRunning.value || connecting.value || navigating.value || disposed) return
  navigationRunning.value = true
  try {
    while (queuedNavigation && !disposed) {
      const action = queuedNavigation
      queuedNavigation = null
      pendingResume.value = null
      try {
        await action()
      } catch (error) {
        ui.pushToast(String(error), "error")
      }
    }
  } finally {
    navigationRunning.value = false
  }
}
watch([connecting, navigating], () => {
  void drainNavigation()
})

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
    lastError.value = String(e)
    ui.pushToast(String(e), "error")
    phase.value = "down"
  } finally {
    selectingProject.value = false
    connecting.value = false
  }
}

async function onTrustDecision(trusted: boolean, trustParent: boolean) {
  if (trustInfo.value) await trustSave(trustInfo.value!.projectPath, trusted, trustParent)
  if (trusted) {
    phase.value = "chat"
    if (!started.value) void session.loadOfflineModels()
    const file = pendingResume.value
    pendingResume.value = null
    if (file && phase.value === "chat") await resumeSession(file)
  } else {
    pendingResume.value = null
    phase.value = "pick"
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
      ui.pushToast(String(e), "error")
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
    ui.pushToast(String(e), "error")
  }
}

function selectConversationFromSidebar(runtimeId: string) {
  const cwd = sessionFor(runtimeId).cwd || project.value
  requestConversationNavigation(sessionRoute(runtimeId, cwd), () => selectQueuedConversation(runtimeId))
}

async function selectQueuedConversation(runtimeId: string) {
  if (workspace.gitBusy || connecting.value) return
  const owner = sessionFor(runtimeId)
  activateSession(runtimeId)
  project.value = owner.cwd
  phase.value = "chat"
}

const conversationLoader = createConversationLoader({
  listRunning: listRunningSessions,
  sessionFor,
  spawn: spawnWorkspacePi,
  kill: killPi,
  mtime: sessionMtime,
  rebuild: rebuildConversation,
})

/** Activate a saved conversation, reusing or spawning its independent worker. */
async function resumeSession(file: string, targetProject?: string) {
  if (workspace.gitBusy || navigating.value || connecting.value) return
  phase.value = "chat"
  connecting.value = true
  let owner = findConversation(file)
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
      const status = await trustStatus(dir)
      if (status.needsDecision) {
        trustInfo.value = status
        pendingResume.value = file
        phase.value = "trust"
        return
      }
    }
    owner = await conversationLoader.load(owner, file, dir)
    activateSession(owner.runtimeId)
    project.value = owner.cwd
  } catch (e) {
    lastError.value = String(e)
    ui.pushToast(String(e), "error")
    phase.value = "down"
  } finally {
    connecting.value = false
  }
}

// ---- 会话分屏：状态跟随激活会话，树在非成员会话展示期间挂起保留 ----
const splitLeaf = computed<PaneLeaf | null>(() => leafByRuntime(activeRuntimeId.value))
watch(activeRuntimeId, id => {
  if (phase.value !== "chat") return
  if (isMember(id)) restoreIfMember(id)
  else if (splitView.tree) suspend()
})

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
      const status = await trustStatus(dir)
      if (status.needsDecision) {
        const allowed = await requestWorkspaceTrust(status)
        if (!allowed) return null
      }
    }
    owner = await conversationLoader.load(owner, file, dir)
    return owner.runtimeId
  } catch (e) {
    ui.pushToast(String(e), "error")
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
  if (!newId || !splitAtEdge(targetRuntimeId, zone, newId)) return
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
/** Export a sidebar session directly from its saved file. Never change the
 * active project or conversation just to perform an action on that file. */
async function openSessionAction(file: string, action: "export") {
  if (action !== "export") return
  try {
    if (await exportSessionFileHtml(file, t("chat.exportDirectory"))) ui.pushToast(t("chat.toastExported"), "info")
  } catch (error) {
    ui.pushToast(String(error), "error")
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
    ui.pushToast(String(e), "error")
  } finally {
    navigating.value = false
  }
}

// ---- global keyboard shortcuts: dispatcher + app-level actions ----

/** 开发者模式下的 devtools 快捷键：F12 或 Ctrl+Shift+I。 */
function isDevtoolsShortcut(event: KeyboardEvent) {
  if (!isDesktop) return false
  if (event.key === "F12") return true
  return event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "i"
}

function onGlobalKeydown(event: KeyboardEvent) {
  // devtools 快捷键不受会话阶段限制，打包版本在开发者模式下同样可用。
  if (developerModeEnabled.value && isDevtoolsShortcut(event)) {
    event.preventDefault()
    void toggleDevtools()
    return
  }
  if (phase.value !== "chat") return
  if (ui.activeDialog) return // extension dialogs handle their own keys
  dispatchShortcut(event)
}

function focusComposerFromShortcut() {
  focusComposer()
}

/** cycle_model / cycle_thinking_level:返回 false 表示没有其他可选（pi data 为 null）。 */
async function cycleModelShortcut() {
  try {
    if (!(await session.cycleModel())) ui.pushToast(t("chat.cycleNoOtherModel"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}

async function cycleThinkingLevelShortcut() {
  try {
    if (!(await session.cycleThinkingLevel())) ui.pushToast(t("chat.cycleThinkingUnsupported"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}

function switchSessionByOffset(offset: number) {
  if (
    (route.value.name !== "home" && route.value.name !== "session" && route.value.name !== "project") ||
    connecting.value ||
    navigating.value
  )
    return
  const rows = workspace.orderedSessions(project.value)
  if (rows.length < 2) return
  const index = rows.findIndex(row => row.file === session.sessionFile)
  // No saved session yet (pristine draft): next = newest, prev = oldest.
  const target = index < 0 ? rows[offset > 0 ? 0 : rows.length - 1] : rows[(index + offset + rows.length) % rows.length]
  if (target)
    requestConversationNavigation(sessionRoute(target.file, target.cwd), () => resumeSession(target.file, target.cwd))
}

const offShortcutHandlers = [
  registerShortcutHandler("app.newSession", () =>
    requestConversationNavigation(projectRoute(project.value), () => newProjectSession(project.value)),
  ),
  registerShortcutHandler("app.focusComposer", focusComposerFromShortcut),
  registerShortcutHandler("app.toggleSidebar", () => {
    if (route.value.name === "home") sidebarOpen.value = !sidebarOpen.value
  }),
  registerShortcutHandler("app.settings", () => navigate("/settings/general")),
  registerShortcutHandler("app.schedules", () => navigate("/schedules")),
  registerShortcutHandler("app.archives", () => navigate("/settings/archives")),
  registerShortcutHandler("app.prevSession", () => switchSessionByOffset(-1)),
  registerShortcutHandler("app.nextSession", () => switchSessionByOffset(1)),
  registerShortcutHandler("chat.cycleModel", cycleModelShortcut),
  registerShortcutHandler("chat.cycleThinkingLevel", cycleThinkingLevelShortcut),
]

onMounted(() => window.addEventListener("keydown", onGlobalKeydown))
onUnmounted(() => {
  offShortcutHandlers.forEach(off => off())
  window.removeEventListener("keydown", onGlobalKeydown)
})
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
    ui.pushToast(String(e), "error")
  } finally {
    navigating.value = false
  }
}

onUnmounted(() => {
  disposed = true
  finishWorkspaceTrust(false)
  runtimeLifecycle.dispose()
})
</script>

<template>
  <div class="desktop-shell flex h-[100dvh] overflow-hidden bg-background text-foreground" style="padding-top: 2.25rem">
    <WindowTitleBar
      :sidebar-open="sidebarOpen"
      :right-sidebar-open="rightSidebarOpen"
      :show-right-sidebar="phase === 'chat' && route.name !== 'settings' && route.name !== 'schedules'"
      :show-open-in-editor="phase === 'chat' && route.name !== 'settings' && route.name !== 'schedules'"
      :open-in-editor-project="session.cwd || project"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @toggle-right-sidebar="rightSidebarOpen = !rightSidebarOpen"
    />
    <!-- Settings is a standalone full-page route: it covers the entire shell. -->
    <ResizablePanelGroup direction="horizontal" class="flex-1 min-h-0 min-w-0">
      <ResizablePanel
        :ref="panel => (sidebarPanel = panel as typeof sidebarPanel)"
        class="min-h-0"
        size-unit="px"
        :default-size="defaultSidebarWidth"
        :min-size="SIDEBAR_MIN_WIDTH"
        :max-size="sidebarMaxWidth"
        collapsible
        @resize="onSidebarResize"
      >
        <WorkspaceSidebar
          v-show="sidebarOpen && route.name !== 'settings'"
          :project="project"
          :ready="phase === 'chat'"
          :busy="navigating || workspace.gitBusy || phase === 'trust'"
          :navigation-busy="workspace.gitBusy || phase === 'trust'"
          @switch-project="requestNavigation(() => switchProject())"
          @select-project="path => requestConversationNavigation(projectRoute(path), () => selectProject(path))"
          @select-conversation="selectConversationFromSidebar"
          @resume-session="
            (file, path) => requestConversationNavigation(sessionRoute(file, path), () => resumeSession(file, path))
          "
          @session-action="(file, action) => openSessionAction(file, action)"
          @new-session="path => requestConversationNavigation(projectRoute(path), () => newProjectSession(path))"
          @projectless="openProjectlessFromSidebar"
          @remove-project="removeProject"
          @edit-project="editProject"
          @settings="navigate('/settings/general')"
          @schedules="navigate('/schedules')"
          @collapse="sidebarOpen = false"
        />
      </ResizablePanel>
      <ResizableHandle
        v-show="sidebarVisible && !isNarrowViewport"
        class="sidebar-resize-handle bg-transparent"
        :aria-label="t('sidebar.resizeWidth')"
        :title="t('sidebar.resizeWidth')"
        :aria-valuenow="preferredSidebarWidth"
        :aria-valuemin="SIDEBAR_MIN_WIDTH"
        :aria-valuemax="sidebarMaxWidth"
        @keydown="resizeSidebarWithKeyboard"
      />
      <ResizablePanel class="min-h-0">
        <main
          id="workspace-main"
          class="workspace-main h-full min-h-0 min-w-0 flex relative overflow-hidden"
          :style="{ '--workspace-header-left': sidebarOpen ? undefined : '48px' }"
        >
          <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <template v-if="route.name === 'settings'">
              <SettingsPage :project="project" />
            </template>
            <template v-else>
              <ScheduledTasksPage
                v-if="route.name === 'schedules'"
                :project="project"
                @resume-session="
                  (file, path) =>
                    requestConversationNavigation(sessionRoute(file, path), () => resumeSession(file, path))
                "
              />
              <WelcomeView
                v-else-if="phase === 'no-pi' || phase === 'pick' || phase === 'detecting'"
                :phase
                :config
                @configured="phase = 'pick'"
                @open-project="switchProject"
                @open-projectless="openProjectless"
              />

              <div v-else-if="phase === 'trust' && trustInfo" class="flex flex-1 items-center justify-center">
                <TrustDialog :info="trustInfo" @done="onTrustDecision" />
              </div>

              <template v-else-if="phase === 'chat'">
                <SplitChatLayout
                  v-if="splitView.tree && splitLeaf"
                  :key="splitView.tree.id"
                  :tree="splitView.tree"
                  :active-leaf-id="splitLeaf.id"
                  @activate="id => activateSession(id)"
                >
                  <template #pane="{ runtimeId }">
                    <ChatView
                      :key="runtimeId"
                      :session-id="runtimeId"
                      :split-pane="splitView.tree.kind === 'group'"
                      sidebar-target="#workspace-main"
                      v-model:right-sidebar-open="rightSidebarOpen"
                      @close-pane="closeSplitPane(runtimeId)"
                      :project="sessionFor(runtimeId).cwd || project"
                      :ensure-started="selection => startSession(runtimeId, selection)"
                      :connecting="connecting"
                      :selecting-project="selectingProject"
                      :connected="sessionFor(runtimeId).started"
                      @select-project="
                        path => requestConversationNavigation(projectRoute(path), () => selectProject(path))
                      "
                      @open-project="requestNavigation(switchProject)"
                      @new-session="
                        () =>
                          requestConversationNavigation(projectRoute(workspace.projectRoot(project)), () =>
                            newProjectSession(workspace.projectRoot(project)),
                          )
                      "
                      @split-drop="(payload, zone) => handleSplitDrop(payload, zone, runtimeId)"
                    />
                  </template>
                </SplitChatLayout>
                <ChatView
                  v-else
                  sidebar-target="#workspace-main"
                  v-model:right-sidebar-open="rightSidebarOpen"
                  :key="activeRuntimeId"
                  :session-id="activeRuntimeId"
                  :project="project"
                  :ensure-started="start"
                  :connecting="connecting"
                  :selecting-project="selectingProject"
                  :connected="started"
                  @select-project="path => requestConversationNavigation(projectRoute(path), () => selectProject(path))"
                  @open-project="requestNavigation(switchProject)"
                  @new-session="
                    () =>
                      requestConversationNavigation(projectRoute(workspace.projectRoot(project)), () =>
                        newProjectSession(workspace.projectRoot(project)),
                      )
                  "
                  @split-drop="(payload, zone) => handleSplitDrop(payload, zone, activeRuntimeId)"
                />
              </template>

              <div v-else-if="phase === 'down'" class="flex flex-1 flex-col items-center justify-center gap-4 p-8">
                <p class="text-lg font-medium">{{ t("app.exited") }}</p>
                <p v-if="lastError" class="text-muted-foreground max-w-xl text-center font-mono text-xs">
                  {{ lastError }}
                </p>
                <div v-if="ui.stderrLines.length" class="bg-muted w-full max-w-2xl rounded-md p-3">
                  <p class="text-muted-foreground mb-1 text-xs font-medium">
                    {{ t("app.stderr") }}
                  </p>
                  <ScrollArea viewport-class="max-h-48">
                    <pre class="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{{
                      ui.stderrLines.slice(-12).join("\n")
                    }}</pre>
                  </ScrollArea>
                </div>
                <div class="flex gap-2">
                  <Button variant="outline" @click="switchProject">
                    {{ t("app.chooseProject") }}
                  </Button>
                </div>
              </div>
            </template>
          </div>
        </main>
      </ResizablePanel>
    </ResizablePanelGroup>
    <CreateProjectDialog
      :open="projectDialogOpen"
      :edit-path="editingProjectPath"
      @close="closeProjectDialog"
      @save="saveProject"
    />
    <Dialog
      :open="!!workspaceTrust"
      @update:open="
        open => {
          if (!open) finishWorkspaceTrust(false)
        }
      "
    >
      <DialogContent class="sm:max-w-lg">
        <DialogTitle class="sr-only">{{ t("trust.title") }}</DialogTitle>
        <TrustDialog v-if="workspaceTrust" :info="workspaceTrust" @done="decideWorkspaceTrust" />
      </DialogContent>
    </Dialog>
    <!-- global toasts -->
    <div class="pointer-events-none fixed right-4 bottom-4 z-[100] flex flex-col gap-2">
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="pointer-events-auto max-w-sm rounded-md border px-4 py-3 text-sm shadow-lg"
        :class="{
          'bg-background text-foreground': t.kind === 'info',
          'border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100': t.kind === 'warning',
          'border-red-500/50 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100': t.kind === 'error',
        }"
      >
        {{ t.message }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* reka 手柄本体只有 1px，用 ::before 扩大命中区而不占布局空间。 */
.sidebar-resize-handle {
  position: relative;
  z-index: 2;
  touch-action: none;
}

.sidebar-resize-handle::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  right: -3px;
}

.sidebar-resize-handle::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: -1px;
  width: 2px;
  background: transparent;
  transition: background 120ms;
}

.sidebar-resize-handle:hover::after,
.sidebar-resize-handle:focus-visible::after,
.sidebar-resize-handle[data-resize-handle-state="drag"]::after,
.sidebar-resize-handle[data-resize-handle-active="keyboard"]::after {
  background: var(--primary);
}
</style>
