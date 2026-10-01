<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useMediaQuery, useWindowSize } from "@vueuse/core"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { usePanelKeyboardResize, type ResizablePanelApi } from "@/composables/usePanelKeyboardResize"
import {
  detectPi,
  prepareWorkspaceGit,
  workspaceGitInfo,
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
  spawnPi,
  trustSave,
  trustStatus,
} from "@/api/piClient"
import type { AppConfig, RunningSession, TrustStatus, WorkspaceContext, WorkspaceSelection } from "@/api/piClient"
import {
  useSessionStore,
  sessionFor,
  uiFor,
  activeRuntimeId,
  activateSession,
  createConversation,
  findConversation,
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
import { normalizeProjectPath, normalizeSlashes, samePath } from "@/lib/paths"
import { encodeCodedError } from "@/lib/backendError"
import { tBackendError } from "@/i18n"
import { dispatchShortcut, registerShortcutHandler } from "@/lib/shortcuts"

const route = useRoute()

type Phase = "detecting" | "no-pi" | "pick" | "trust" | "chat" | "down"

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

// ---- 工作区侧栏宽度（reka Splitter，像素单位并持久化）----
const SIDEBAR_WIDTH_STORAGE_KEY = "pix.sidebar-width"
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_DEFAULT_WIDTH = 272 // 与侧栏旧默认宽度 w-68 对齐
const { width: windowWidth } = useWindowSize()
const isNarrowViewport = useMediaQuery("(max-width: 640px)")
const sidebarVisible = computed(() => sidebarOpen.value && route.value.name !== "settings")
/** 窄屏下侧栏以覆盖层悬浮，面板需让出全部宽度。 */
const sidebarCollapsed = computed(() => !sidebarVisible.value || isNarrowViewport.value)
const sidebarMaxWidth = computed(() => Math.min(480, Math.max(280, windowWidth.value - 360)))
const preferredSidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH)
try {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
  if (Number.isFinite(saved) && saved > 0) preferredSidebarWidth.value = saved
} catch {
  /* Storage may be unavailable in restricted browsers. */
}
/** reka 只在首次布局读取 default-size；初始折叠态直接体现到默认尺寸，避免布局就绪前调用命令式 API。 */
const defaultSidebarWidth = sidebarCollapsed.value
  ? 0
  : Math.min(SIDEBAR_DEFAULT_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, preferredSidebarWidth.value))
const sidebarPanel = ref<ResizablePanelApi | null>(null)

function clampSidebarWidth(width: number) {
  return Math.min(sidebarMaxWidth.value, Math.max(SIDEBAR_MIN_WIDTH, width))
}

function onSidebarResize(width: number) {
  if (width <= 0 || isNarrowViewport.value) return
  preferredSidebarWidth.value = Math.round(width)
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(preferredSidebarWidth.value))
  } catch {
    /* Optional preference. */
  }
}

watch(
  sidebarCollapsed,
  collapsed => {
    const panel = sidebarPanel.value
    if (!panel) return
    if (collapsed) panel.collapse()
    else panel.resize(clampSidebarWidth(preferredSidebarWidth.value))
  },
  { flush: "post" },
)

const resizeSidebarWithKeyboard = usePanelKeyboardResize(sidebarPanel, () => ({
  min: SIDEBAR_MIN_WIDTH,
  max: sidebarMaxWidth.value,
}))

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
async function spawnWorkspacePi(dir: string, file?: string, runtimeId = activeRuntimeId.value) {
  // 空目录传给后端会让 CreateProcess 报晦涩的 os error 123；在入口统一拦截。
  if (!dir) throw new Error(encodeCodedError("projectDirMissing", "项目目录不存在"))
  const context = contextFor(dir)
  await spawnPi(dir, file, runtimeId, context)
  runtimeWorkspaces.set(runtimeId, JSON.stringify(context ?? null))
}

// event listener lifecycle: always unlisten on unmount, otherwise HMR
// remounts stack duplicate listeners and events get handled N times
let unlisteners: Array<() => void> = []
let disposed = false

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
    const handlers = await Promise.all([
      onPiEvent(ev => {
        const id = ev.runtimeId ?? "default"
        if (ev.type === "extension_ui_request") {
          uiFor(id).handleRequest(ev as any)
          return
        }
        const owner = sessionFor(id)
        if (ev.type === "scheduled_session_created") {
          owner.cwd = ev.project
          owner.sessionFile = ev.sessionFile
          owner.state = ev.state
          owner.started = true
          // Metadata requests do not replace live entries accumulated below.
          void owner.init(ev.project).catch(console.warn)
        }
        owner.handleEvent(ev)
        if ((ev.type === "agent_end" || ev.type === "agent_settled") && owner.cwd)
          void workspace.refresh(owner.cwd).catch(console.warn)
      }),
      onSessionsChanged(files => handleExternalSessionChanges(files)),
      onPiExit(runtimeId => {
        pixLog(`pi exit: runtimeId=${runtimeId ?? "<transport>"}`, runtimeId ?? null)
        // An unscoped exit is a transport disconnect; it is not an agent exit.
        if (!runtimeId) {
          if (phase.value === "chat") phase.value = "down"
          return
        }
        const owner = sessionFor(runtimeId)
        owner.markInterrupted()
        owner.started = false
        owner.isStreaming = false
        owner.isCompacting = false
        owner.partialBlocks = null
        if (runtimeId === activeRuntimeId.value && phase.value === "chat" && !connecting.value) phase.value = "down"
      }),
      onPiStderr((line, runtimeId) => uiFor(runtimeId ?? activeRuntimeId.value).pushStderr(tBackendError(line))),
      onReconnected(() => {
        if (disposed) return
        // Events during the disconnect gap are lost; restore from the backend.
        if (phase.value === "down") {
          void reattachRunningSessions()
            .then(restored => {
              if (restored) return
              phase.value = "pick"
              refreshVisibleHistories()
            })
            .catch(e => {
              lastError.value = String(e)
            })
          return
        }
        refreshVisibleHistories()
      }),
    ])
    if (disposed) {
      handlers.forEach(off => off())
      return
    }
    unlisteners = handlers

    // Metadata writes (rename/archive) by this app must not look external.
    registerSessionMtimeSync((file, mtime) => findConversation(file)?.syncSessionMtime(mtime))

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
    if (findConversation(id)) return selectQueuedConversation(id)
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

/** Reattach to runtimes already alive on the backend (UI reload, remote
 *  reconnect) without spawning duplicates. Returns the restored runtime. */
async function reattachRunningSessions(): Promise<RunningSession | null> {
  const running = await listRunningSessions()
  for (const runtime of running) {
    const owner = sessionFor(runtime.runtimeId)
    owner.started = true
    await owner.init(runtime.project)
    await owner.loadHistory()
    owner.isStreaming = runtime.state.isStreaming ?? false
    if (owner.isStreaming) owner.markRunning()
  }
  // Never auto-activate a project the user explicitly removed, even when its
  // conversations keep running in the background.
  const restorable = running.filter(runtime => !workspace.isRemovedProject(runtime.project))
  const restored = restorable.find(runtime => runtime.project === config.value.lastProject) ?? restorable[0]
  if (restored) {
    activateSession(restored.runtimeId)
    project.value = restored.project
    phase.value = "chat"
  }
  return restored ?? null
}

// ---- external session changes (e.g. the session continued in a terminal) ----

let sessionsListTimer: ReturnType<typeof setTimeout> | null = null
function refreshVisibleHistories() {
  // Refresh the sidebar lists so previews/titles/timestamps follow the disk.
  if (sessionsListTimer) clearTimeout(sessionsListTimer)
  sessionsListTimer = setTimeout(() => {
    sessionsListTimer = null
    const projects = new Set<string>(Object.keys(workspace.histories))
    if (project.value) projects.add(project.value)
    for (const p of projects) void workspace.refresh(p).catch(console.warn)
  }, 600)
}
function handleExternalSessionChanges(files: string[]) {
  for (const file of files) scheduleExternalReload(file)
  refreshVisibleHistories()
}

const pendingReloads = new Set<string>()
function scheduleExternalReload(file: string) {
  if (pendingReloads.has(file)) return
  // Let in-flight own writes settle and their mtimes sync first.
  pendingReloads.add(file)
  setTimeout(() => {
    pendingReloads.delete(file)
    void reloadExternalConversation(file)
  }, 800)
}

/** Restart a conversation's worker so it picks up history appended elsewhere;
 *  `get_messages` reads worker memory, so a reload alone is not enough. */
async function rebuildConversation(owner: ReturnType<typeof sessionFor>) {
  const file = owner.sessionFile
  const dir = owner.cwd
  if (!file || !dir) return
  pixLog(`rebuild: kill+respawn file=${file} streaming=${owner.isStreaming}`, owner.runtimeId)
  const active = owner.runtimeId === activeRuntimeId.value
  // The scoped pi-exit handler keeps phase "chat" while connecting.
  if (active) connecting.value = true
  try {
    await killPi(owner.runtimeId)
    await spawnWorkspacePi(dir, file, owner.runtimeId)
    owner.started = true
    owner.clear()
    owner.sessionFile = file
    await Promise.all([owner.init(dir), owner.loadHistory()])
  } catch (e) {
    await killPi(owner.runtimeId).catch(() => {})
    owner.started = false
    lastError.value = String(e)
    uiFor(owner.runtimeId).pushToast(String(e), "error")
  } finally {
    if (active) connecting.value = false
  }
}

async function reloadExternalConversation(file: string) {
  if (disposed || connecting.value || navigating.value) return
  const owner = findConversation(file)
  if (!owner?.started || !owner.sessionFile || owner.isStreaming || owner.isResending) return
  const disk = await sessionMtime(file).catch(() => null)
  // Equal mtime means the write was our own (already synced at agent_end).
  if (disk == null || disk === owner.syncedSessionMtime || owner.isStreaming || owner.isResending) return
  pixLog(
    `watcher: external change detected, rebuilding file=${file} streaming=${owner.isStreaming} synced=${owner.syncedSessionMtime} disk=${disk}`,
    owner.runtimeId,
  )
  await rebuildConversation(owner)
}

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
// Cache successful creation before later initialization/trust steps. Retrying a
// failed first send must reuse its checkout, not create another one.
const preparedWorkspaces = new Map<string, { key: string; path: string }>()
/** 单屏入口：始终启动当前激活会话。 */
async function start(selection?: WorkspaceSelection | null): Promise<boolean> {
  return startSession(activeRuntimeId.value, selection)
}

/** 指定会话的启动流程；分屏时各窗格携带各自 runtimeId 调用，行为与激活会话一致。 */
async function startSession(runtimeId: string, selection?: WorkspaceSelection | null): Promise<boolean> {
  if (workspace.gitBusy || connecting.value || selectingProject.value || phase.value !== "chat") return false
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
    const key = JSON.stringify(selection)
    const cached = preparedWorkspaces.get(owner.runtimeId)
    let path = cached?.key === key ? cached.path : undefined
    if (!path || !selection.worktree) {
      const info = await workspaceGitInfo(selection.project)
      // An unchanged local selection doesn't switch away from an existing checkout.
      path =
        !selection.worktree && info.branch === selection.branch
          ? selection.project
          : await prepareWorkspaceGit(selection)
      path = normalizeProjectPath(path)
      preparedWorkspaces.set(owner.runtimeId, { key, path })
    }
    // The user explicitly picked this folder, so lift any earlier removal marker.
    workspace.unremoveProject(path)
    await workspace.rememberWorkspace(path)
    const status = await trustStatus(path)
    if (status.needsDecision) {
      const allowed = await new Promise<boolean>(resolve => {
        resolveWorkspaceTrust = resolve
        workspaceTrust.value = status
      })
      if (!allowed) return false
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
  }
}

async function startRuntime(runtimeId: string): Promise<boolean> {
  // Completion can request a runtime while the draft remains editable.
  if (selectingProject.value || phase.value !== "chat") return false
  const owner = sessionFor(runtimeId)
  if (owner.started && runtimeWorkspaces.get(owner.runtimeId) === contextSignature(owner.cwd || project.value))
    return true
  if (owner.started && owner.isStreaming) {
    return true
  }
  if (owner.started && owner.sessionFile) {
    await rebuildConversation(owner)
    return owner.started
  }
  if (owner.started) {
    await killPi(owner.runtimeId)
    owner.started = false
  }
  connecting.value = true
  try {
    await spawnWorkspacePi(owner.cwd || project.value, undefined, owner.runtimeId)
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
  }
}

async function switchProject() {
  if (workspace.gitBusy || navigating.value || connecting.value) return
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

/** Resume a stored session: switch in-process when possible, else restart. */
async function resumeSession(file: string, targetProject?: string) {
  if (workspace.gitBusy || navigating.value || connecting.value) return
  // Clicking the already-active session is a no-op: it is still attached in
  // memory, and appends made elsewhere are picked up by the session-file
  // watcher (scheduleExternalReload), so no reconnect or history reload.
  const activeOwner = findConversation(file)
  if (activeOwner?.started && activeOwner.runtimeId === activeRuntimeId.value) {
    project.value = activeOwner.cwd
    return
  }
  phase.value = "chat"
  connecting.value = true
  let owner = findConversation(file)
  let attaching = false
  try {
    const dir = normalizeProjectPath(targetProject || owner?.cwd || project.value)
    const changingProject = dir !== project.value
    if (!owner) owner = createConversation(dir)
    // Select the saved identity before any asynchronous work, never a draft.
    owner.sessionFile = file
    activateSession(owner.runtimeId)
    project.value = dir
    if (changingProject) {
      // A removed project can still be opened by its route, but it must not
      // become the auto-restored project on the next launch.
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
    // The scheduler and other PiX windows may have created the worker since
    // this UI last synchronized. Attach by persisted identity, never spawn twice.
    if (!owner?.started) {
      const running = await listRunningSessions()
      const runtime = running.find(
        item => item.state.sessionFile && normalizeSlashes(item.state.sessionFile) === normalizeSlashes(file),
      )
      if (runtime) {
        const placeholder = owner
        owner = sessionFor(runtime.runtimeId)
        attaching = true
        if (placeholder && placeholder !== owner) placeholder.sessionFile = null
        if (!owner.started) {
          owner.sessionFile = file
          await owner.init(runtime.project)
          await owner.loadHistory()
          owner.isStreaming = runtime.state.isStreaming
          owner.started = true
          if (owner.isStreaming) owner.markRunning()
        }
      }
    }
    if (owner.started) {
      activateSession(owner.runtimeId)
      project.value = owner.cwd
      // The session may have been continued externally since we last saw it;
      // rebuild the worker when the file changed on disk.
      if (!owner.isStreaming && owner.sessionFile) {
        const disk = await sessionMtime(owner.sessionFile).catch(() => null)
        if (disk != null && disk !== owner.syncedSessionMtime) await rebuildConversation(owner)
      }
      return
    }
    // A dormant conversation gets its own worker; other workers are untouched.
    owner.clear()
    owner.sessionFile = file
    await spawnWorkspacePi(dir, file, owner.runtimeId)
    // History does not depend on model/command metadata being ready.
    await Promise.all([owner.init(dir), owner.loadHistory()])
    owner.started = true
  } catch (e) {
    if (owner && !attaching) {
      await killPi(owner.runtimeId).catch(() => {})
      owner.started = false
    }
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

/** Load a sidebar session for a split pane without touching the active
 * conversation or project. Reuses the trust dialog, running-session attach
 * and dormant-spawn paths of resumeSession. */
async function ensureSessionForSplit(file: string, targetProject?: string): Promise<string | null> {
  const attached = findConversation(file)
  if (attached?.started) return attached.runtimeId
  if (workspace.gitBusy || navigating.value || connecting.value) return null
  connecting.value = true
  let owner = findConversation(file)
  let attaching = false
  try {
    const dir = normalizeProjectPath(targetProject || owner?.cwd || project.value)
    if (!owner) {
      // 分屏装载不得抢占激活会话，绕过 createConversation 的激活副作用。
      pruneDormantConversations()
      owner = sessionFor(createUuid())
      owner.cwd = dir
    }
    owner.sessionFile = file
    const status = await trustStatus(dir)
    if (status.needsDecision) {
      const allowed = await new Promise<boolean>(resolve => {
        resolveWorkspaceTrust = resolve
        workspaceTrust.value = status
      })
      if (!allowed) return null
    }
    if (!owner.started) {
      // The scheduler and other PiX windows may already run this session.
      const running = await listRunningSessions()
      const runtime = running.find(
        item => item.state.sessionFile && normalizeSlashes(item.state.sessionFile) === normalizeSlashes(file),
      )
      if (runtime) {
        const placeholder = owner
        owner = sessionFor(runtime.runtimeId)
        attaching = true
        if (placeholder && placeholder !== owner) placeholder.sessionFile = null
        if (!owner.started) {
          owner.sessionFile = file
          await owner.init(runtime.project)
          await owner.loadHistory()
          owner.isStreaming = runtime.state.isStreaming
          owner.started = true
          if (owner.isStreaming) owner.markRunning()
        }
      }
    }
    if (!owner.started) {
      owner.clear()
      owner.sessionFile = file
      await spawnWorkspacePi(dir, file, owner.runtimeId)
      await Promise.all([owner.init(dir), owner.loadHistory()])
      owner.started = true
    }
    return owner.runtimeId
  } catch (e) {
    if (owner && !attaching) await killPi(owner.runtimeId).catch(() => {})
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

function onGlobalKeydown(event: KeyboardEvent) {
  if (phase.value !== "chat") return
  if (ui.activeDialog) return // extension dialogs handle their own keys
  dispatchShortcut(event)
}

function focusComposerFromShortcut() {
  focusComposer()
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
  unlisteners.forEach(off => off())
  unlisteners = []
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
        ref="sidebarPanel"
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
