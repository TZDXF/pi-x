<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useMediaQuery, useWindowSize } from "@vueuse/core"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useWorkspaceSidebarLayout } from "@/composables/useWorkspaceSidebarLayout"
import { useAppNavigation } from "@/composables/useAppNavigation"
import { useProjectActions } from "@/composables/useProjectActions"
import { useSessionOpening, type TrustActivationBackup } from "@/composables/useSessionOpening"
import { useAppShortcuts } from "@/composables/useAppShortcuts"
import { useWorkspaceLayout, type WorkspaceLayout } from "@/composables/useWorkspaceLayout"
import { useKanbanWorkspace } from "@/composables/useKanbanWorkspace"
import { useSessionActivitySync } from "@/composables/useSessionActivitySync"
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
  onSshPathBound,
  pixLog,
  onPiExit,
  onPiStderr,
  onReconnected,
  onWorkspaceStateChanged,
  onSessionsChanged,
  saveConfig,
  sessionMtime,
  setTrayLabels,
  toggleDevtools,
  spawnPi,
  sshTrustSave,
  sshTrustStatus,
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
import { splitView, isMember, leafByRuntime, restoreIfMember, suspend, type PaneLeaf } from "@/stores/splitView"
import { createWorkspaceStartup } from "@/lib/workspaceStartup"
import { createWorkspaceRuntime, type WorkspacePhase } from "@/lib/workspaceRuntime"
import { createConversationLoader } from "@/lib/conversationLoader"
import { focusComposer } from "@/lib/composer"
import { useWorkspaceStore, registerSessionMtimeSync } from "@/stores/workspace"
import { useUiStore } from "@/stores/conversations"
import { useAppUpdateStore } from "@/stores/appUpdate"
import WelcomeView from "@/components/WelcomeView.vue"
import CreateProjectDialog from "@/components/CreateProjectDialog.vue"
import TrustDialog from "@/components/TrustDialog.vue"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import WorkspaceSidebar from "@/components/WorkspaceSidebar.vue"
import type { SidebarSessionTarget } from "@/components/workspace/sidebar/useSidebarSessionReveal"
import SettingsPage from "@/components/SettingsPage.vue"
import ScheduledTasksPage from "@/components/ScheduledTasksPage.vue"
import { Button } from "@/components/ui/button"
import ChatView from "@/components/ChatView.vue"
import SplitChatLayout from "@/components/SplitChatLayout.vue"
import WindowTitleBar from "@/components/WindowTitleBar.vue"
import KanbanBoard from "@/components/kanban/KanbanBoard.vue"
import KanbanDetailsPanel from "@/components/kanban/KanbanDetailsPanel.vue"
import { useRoute, navigate, goHome, projectRoute, sessionRoute } from "@/lib/router"
import { kanbanColumnOrderKey, kanbanStatusOrderKey, type KanbanCard } from "@/lib/kanban"
import { loadTrustStatus } from "@/lib/sshTrust"
import { isRemoteProject } from "@/lib/ssh"
import { sameSessionIdentity } from "@/lib/sessionIdentity"
import { ExternalLink, FolderPlus, Trash2, X } from "@lucide/vue"
import { developerModeEnabled } from "@/lib/developerMode"
import { initializeConfigPreferences } from "@/lib/configPreference"
import { isDesktop } from "@/api/transport"
import { tBackendError } from "@/i18n"
import { saveTrustDecision } from "@/lib/sshTrust"
import { dispatchShortcut, registerShortcutHandler } from "@/lib/shortcuts"

const route = useRoute()

type Phase = WorkspacePhase

const session = useSessionStore()
const workspace = useWorkspaceStore()
useSessionActivitySync(workspace)
const { workspaceLayout } = useWorkspaceLayout()
const navigating = ref(false)
const pendingResume = ref<string | null>(null)
const trustActivationBackup = ref<TrustActivationBackup | null>(null)
const ui = useUiStore()
const appUpdate = useAppUpdateStore()
const { t } = useI18n()

const rightSidebarOpen = ref(false)
const sidebarOpen = ref(true)
const sidebarRevealTarget = ref<SidebarSessionTarget | null>(null)
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
  sidebarAnimating,
  onSidebarResize,
  resizeSidebarWithKeyboard,
} = useWorkspaceSidebarLayout(sidebarOpen, windowWidth, isNarrowViewport)

function closeProjectDialog() {
  projectDialogOpen.value = false
  editingProjectPath.value = null
}

const phase = ref<Phase>("detecting")
const config = ref<AppConfig>({})
const project = ref("")
const trustInfo = ref<TrustStatus | null>(null)
const lastError = ref<string | null>(null)
const kanban = useKanbanWorkspace(workspace, () => workspaceLayout.value === "board" && phase.value !== "detecting")
const board = reactive(kanban)
const boardVisited = ref(workspaceLayout.value === "board")
const boardComponent = ref<InstanceType<typeof KanbanBoard> | null>(null)
const boardChat = ref<InstanceType<typeof ChatView> | null>(null)
const creatingBoardDraft = ref(false)
const showKanban = computed(
  () =>
    workspaceLayout.value === "board" &&
    phase.value !== "trust" &&
    route.value.name !== "settings" &&
    route.value.name !== "schedules",
)
const boardSelectionReady = computed(() => {
  const card = board.selectedCard
  if (!card) return !connecting.value && !navigating.value
  return card.file
    ? sameSessionIdentity(session.sessionFile, session.cwd, card.file, card.cwd || card.project)
    : activeRuntimeId.value === (card.runtimeId || card.draftId)
})
watch(workspaceLayout, layout => {
  if (layout === "board") boardVisited.value = true
})

const started = computed({
  get: () => session.started,
  set: value => {
    session.started = value
  },
})
const connecting = ref(false)
const selectingProject = ref(false)
// Read receipts belong to visible ChatView instances, never the selected runtime alone.
const startup = createWorkspaceStartup({
  api: {
    prepareWorkspaceGit,
    workspaceGitInfo,
    killPi,
    spawnPi,
    trustStatus,
    trustSave,
    sshTrustStatus,
    sshTrustSave,
    saveConfig,
    pixLog,
  },
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
    onSshPathBound,
    onReconnected,
    onWorkspaceStateChanged,
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

const conversationLoader = createConversationLoader({
  listRunning: listRunningSessions,
  sessionFor,
  spawn: spawnWorkspacePi,
  kill: killPi,
  mtime: sessionMtime,
  rebuild: rebuildConversation,
})

const projectActions = useProjectActions({
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
  // Late-bound: requestConversationNavigation is destructured further below.
  requestConversationNavigation: (path, action) => requestConversationNavigation(path, action),
})
const {
  selectProject,
  switchProject,
  openProjectless,
  openProjectlessFromSidebar,
  editProject,
  saveProject,
  removeProject,
} = projectActions

const sessionOpening = useSessionOpening({
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
})
const {
  resumeSession,
  handleSplitDrop,
  closeSplitPane,
  selectQueuedConversation,
  openSessionAction,
  newProjectSession,
} = sessionOpening

const navigation = useAppNavigation({
  workspace,
  phase,
  connecting,
  navigating,
  pendingResume,
  project,
  route,
  ui,
  translateError: tBackendError,
  navigate,
  isDisposed: () => disposed,
  peekConversation: (id, path) => {
    const draft = workspace.boardDrafts?.[id]
    return draft && !draft.sessionFile ? board.draftConversation(draft) : peekConversation(id, path)
  },
  resumeSession,
  selectQueuedConversation,
  newProjectSession,
})
const { requestNavigation, requestConversationNavigation } = navigation

// ---- 会话分屏：状态跟随激活会话，树在非成员会话展示期间挂起保留 ----
const splitLeaf = computed<PaneLeaf | null>(() => leafByRuntime(activeRuntimeId.value))
watch(activeRuntimeId, id => {
  if (phase.value !== "chat") return
  if (isMember(id)) restoreIfMember(id)
  else if (splitView.tree) suspend()
})

const { onGlobalKeydown, disposeShortcuts } = useAppShortcuts({
  workspace,
  session,
  phase,
  connecting,
  navigating,
  sidebarOpen,
  project,
  route,
  ui,
  t,
  translateError: tBackendError,
  navigate,
  sessionRoute,
  requestConversationNavigation,
  newSessionFromChat,
  resumeSession,
  developerModeEnabled,
  isDesktop,
  toggleDevtools,
  focusComposer,
  shortcuts: { dispatchShortcut, registerShortcutHandler },
})

// ---- template handlers for the conversation-navigation wrappers ----

function changeWorkspaceLayout(layout: WorkspaceLayout) {
  workspaceLayout.value = layout
  if (layout === "board") board.detailsOpen = false
}

function selectBoardConversation(file: string, path: string) {
  if (workspaceLayout.value !== "board") return
  board.selection = board.cards.find(card => sameSessionIdentity(card.file, card.cwd, file, path)) ?? null
  board.detailsOpen = true
}

function onBoardCardDeleted(card: KanbanCard) {
  const selected = board.selection
  const matches = selected?.id === card.id || (!!card.draftId && selected?.draftId === card.draftId)
  if (!matches) return
  board.selection = null
  board.detailsOpen = false
}

function openBoardCard(card: KanbanCard) {
  board.selection = card
  board.detailsOpen = true
  const draft = card.draftId ? workspace.boardDrafts[card.draftId] : null
  if (draft && !draft.sessionFile) {
    const owner = board.draftConversation(draft)
    requestConversationNavigation(sessionRoute(owner.runtimeId, owner.cwd), () =>
      selectQueuedConversation(owner.runtimeId),
    )
  } else if (card.file) {
    resumeSessionFromRoute(card.file, card.cwd || card.project)
  } else if (card.runtimeId) {
    selectConversationFromSidebar(card.runtimeId)
  }
}

function startBoardDraft(card: KanbanCard) {
  if (card.status !== "todo" || !card.draftId || connecting.value || navigating.value) return
  const draft = workspace.boardDrafts[card.draftId]
  if (!draft || draft.sessionFile) return
  board.selection = card
  board.detailsOpen = true
  const owner = board.draftConversation(draft)
  requestConversationNavigation(sessionRoute(owner.runtimeId, owner.cwd), async () => {
    await selectQueuedConversation(owner.runtimeId)
    await nextTick()
    if (activeRuntimeId.value === owner.runtimeId) await boardChat.value?.submitDraft()
  })
}

async function createBoardDraft(input: import("@/lib/kanban").KanbanCreatePayload) {
  if (creatingBoardDraft.value) return
  creatingBoardDraft.value = true
  board.error = ""
  try {
    const draft = await board.createDraft(input)
    if (!draft || !input.startImmediately) return
    const card = board.cards.find(card => card.draftId === draft.id)
    if (card) startBoardDraft(card)
  } catch (error) {
    board.error = tBackendError(error)
    ui.pushToast(tBackendError(error), "error")
  } finally {
    creatingBoardDraft.value = false
  }
}

async function ensureBoardStarted(selection?: import("@/api/piClient").WorkspaceSelection | null) {
  const owner = sessionFor(activeRuntimeId.value)
  if (!owner.started) {
    const status = await loadTrustStatus(owner.cwd || project.value, config.value.sshConnections ?? [], {
      trustStatus,
      sshTrustStatus,
    })
    if (status.needsDecision && !(await requestWorkspaceTrust(status, isRemoteProject(owner.cwd) ? owner.cwd : null)))
      return false
  }
  return startSession(owner.runtimeId, selection)
}

async function openBoardConversationInChat() {
  const card = board.selectedCard
  const target: SidebarSessionTarget = {
    cwd: card?.cwd || card?.project || session.cwd || project.value,
    file: card ? card.file : session.sessionFile,
    runtimeId: card?.runtimeId || card?.draftId || activeRuntimeId.value,
  }
  sidebarRevealTarget.value = null
  workspaceLayout.value = "chat"
  // Splitter panels register on mount; expand only after the sidebar is attached again.
  await nextTick()
  sidebarOpen.value = true
  await nextTick()
  sidebarRevealTarget.value = target
  focusComposer()
}

function selectBoardDraftProject(path: string) {
  const draft = board.selectedDraft
  if (draft && !draft.sessionFile && !connecting.value) {
    workspace.upsertBoardDraft({ ...draft, project: path, updatedAt: Date.now() })
    const owner = board.draftConversation(workspace.boardDrafts[draft.id]!)
    requestConversationNavigation(sessionRoute(owner.runtimeId, path), () => selectQueuedConversation(owner.runtimeId))
    return
  }
  requestConversationNavigation(projectRoute(path), () => selectProject(path))
}

async function deleteBoardDraft() {
  const draft = board.selectedDraft
  if (!draft || draft.sessionFile || connecting.value) return
  workspace.removeBoardDraft(draft.id)
  board.detailsOpen = false
  board.selection = null
  await workspace.flushPersistence().catch(error => ui.pushToast(tBackendError(error), "error"))
}

function resumeSessionFromRoute(file: string, path: string) {
  selectBoardConversation(file, path)
  requestConversationNavigation(sessionRoute(file, path), () => resumeSession(file, path))
}

function selectProjectFromRoute(path: string) {
  if (workspaceLayout.value === "board") {
    board.selectedProject = workspace.isProjectless(path) ? path : workspace.projectRoot(path)
    board.detailsOpen = false
    return
  }
  requestConversationNavigation(projectRoute(path), () => selectProject(path))
}

function newSessionFromSidebar(path: string) {
  if (workspaceLayout.value === "board") {
    boardComponent.value?.openCreate(path)
    return
  }
  requestConversationNavigation(projectRoute(path), () => newProjectSession(path))
}

function newSessionFromChat() {
  if (workspaceLayout.value === "board") {
    boardComponent.value?.openCreate(workspace.projectRoot(project.value))
    return
  }
  requestConversationNavigation(projectRoute(workspace.projectRoot(project.value)), () =>
    newProjectSession(workspace.projectRoot(project.value)),
  )
}

async function onTrustDecision(trusted: boolean, trustParent: boolean) {
  if (trustInfo.value) {
    // 恢复会话的信任决策（契约 §4.3）：远程项目经 ssh_trust_save 落到远端；
    // 恢复流程在暂停前已把 project 置为目标 URI。
    try {
      await saveTrustDecision(
        project.value,
        trustInfo.value.projectPath,
        trusted,
        trustParent,
        config.value.sshConnections ?? [],
        { trustSave, sshTrustSave },
      )
    } catch (e) {
      ui.pushToast(tBackendError(e), "error")
      return
    }
  }
  if (trusted) {
    phase.value = "chat"
    trustActivationBackup.value = null
    if (!started.value) void session.loadOfflineModels()
    const file = pendingResume.value
    pendingResume.value = null
    if (file) await resumeSession(file)
  } else {
    pendingResume.value = null
    // Rejecting trust must not leave the conversation that resumeSession
    // already activated in place; restore whatever was active before it
    // paused on the decision.
    const backup = trustActivationBackup.value
    trustActivationBackup.value = null
    if (backup) {
      backup.owner.sessionFile = backup.prevOwnerFile
      activateSession(backup.prevActive)
      project.value = backup.prevProject
    }
    phase.value = "pick"
  }
}

function selectConversationFromSidebar(runtimeId: string) {
  const cwd = sessionFor(runtimeId).cwd || project.value
  if (workspaceLayout.value === "board") {
    board.selection = board.cards.find(card => card.runtimeId === runtimeId) ?? null
    board.detailsOpen = true
  }
  requestConversationNavigation(sessionRoute(runtimeId, cwd), () => selectQueuedConversation(runtimeId))
}

// Browser history must move the drawer selection together with its runtime.
watch(route, next => {
  if (workspaceLayout.value !== "board") return
  if (next.name !== "session" || !next.params.conversation) {
    if (next.name === "home") board.detailsOpen = false
    return
  }
  const id = next.params.conversation
  const path = next.params.project || project.value
  board.selection =
    board.cards.find(
      card => card.draftId === id || card.runtimeId === id || sameSessionIdentity(card.file, card.cwd, id, path),
    ) ?? null
  board.detailsOpen = true
})

watch(
  () => workspace.persistenceError,
  error => {
    if (error) ui.pushToast(tBackendError(error), "error")
  },
)

onMounted(async () => {
  window.addEventListener("keydown", onGlobalKeydown)
  // 更新下载可能跨越页面切换，进度监听跟随应用生命周期。
  void appUpdate.startProgressListener()
  // 启动后自动检查应用更新，发现新版本时标题栏会出现更新入口
  void appUpdate.autoCheck()
  try {
    config.value = await getConfig()
    // Remote authentication may not have been available during main.ts startup.
    await initializeConfigPreferences(config.value)
  } catch {
    config.value = {}
  }
  // 解析（并由后端按需创建）无项目会话目录，让欢迎页与侧栏入口随时可用。
  void workspace.ensureProjectless().catch(e => console.warn("[pi] failed to resolve the no-project directory:", e))
  void setTrayLabels(t("tray.show"), t("tray.quit")).catch(() => {})

  try {
    await runtimeLifecycle.listen()
    await workspace.syncState()

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
      const draft = workspace.boardDrafts[initialRoute.params.conversation]
      if (draft && !draft.sessionFile) {
        const owner = board.draftConversation(draft)
        await selectQueuedConversation(owner.runtimeId)
      } else {
        await resumeSession(draft?.sessionFile || initialRoute.params.conversation, target)
      }
      if (workspaceLayout.value === "board") {
        board.detailsOpen = true
        board.selection =
          board.cards.find(card => card.file === session.sessionFile || card.draftId === draft?.id) ?? null
      }
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
    lastError.value = tBackendError(e)
    phase.value = "down"
  }
})

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown)
  disposeShortcuts()
  disposed = true
  finishWorkspaceTrust(false)
  runtimeLifecycle.dispose()
})
</script>

<template>
  <div class="desktop-shell flex h-[100dvh] overflow-hidden bg-background text-foreground" style="padding-top: 2.25rem">
    <WindowTitleBar
      :workspace-layout="workspaceLayout"
      :show-sidebar="!showKanban"
      :sidebar-open="sidebarOpen"
      :right-sidebar-open="rightSidebarOpen"
      :show-right-sidebar="phase === 'chat' && route.name !== 'settings' && route.name !== 'schedules' && !showKanban"
      :show-open-in-editor="
        phase === 'chat' &&
        route.name !== 'settings' &&
        route.name !== 'schedules' &&
        (!showKanban || (board.detailsOpen && !!board.selectedCard && boardSelectionReady))
      "
      :open-in-editor-project="session.cwd || project"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @toggle-right-sidebar="rightSidebarOpen = !rightSidebarOpen"
      @change-layout="changeWorkspaceLayout"
    />
    <!-- Settings is a standalone full-page route: the whole panel group (sidebar included) is swapped out, so route changes never trigger the collapse animation. -->
    <SettingsPage v-if="route.name === 'settings'" :project="project" />
    <ResizablePanelGroup
      v-else
      direction="horizontal"
      class="sidebar-panel-group flex-1 min-h-0 min-w-0"
      :class="{ 'sidebar-animating': sidebarAnimating }"
    >
      <ResizablePanel
        v-if="!showKanban"
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
          :reveal-session="sidebarRevealTarget"
          :inert="!sidebarVisible"
          :class="sidebarVisible ? undefined : 'max-[640px]:-translate-x-full max-[640px]:invisible'"
          :project="project"
          :ready="phase === 'chat'"
          :busy="navigating || workspace.gitBusy || phase === 'trust'"
          :navigation-busy="(workspace.gitBusy && !connecting) || phase === 'trust'"
          @switch-project="requestNavigation(() => switchProject())"
          @select-project="selectProjectFromRoute"
          @select-conversation="selectConversationFromSidebar"
          @resume-session="resumeSessionFromRoute"
          @session-action="openSessionAction"
          @new-session="newSessionFromSidebar"
          @projectless="openProjectlessFromSidebar"
          @remove-project="removeProject"
          @edit-project="editProject"
          @settings="navigate('/settings/general')"
          @schedules="navigate('/schedules')"
          @collapse="sidebarOpen = false"
        />
      </ResizablePanel>
      <ResizableHandle
        v-if="!showKanban"
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
          :style="{ '--workspace-header-left': showKanban || sidebarOpen ? undefined : '48px' }"
        >
          <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div v-if="boardVisited" v-show="showKanban" class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <KanbanBoard
                ref="boardComponent"
                class="flex-1"
                v-model:selected-project="board.selectedProject"
                :cards="board.cards"
                :projects="board.projects"
                :selected-id="board.detailsOpen ? board.selectedCard?.id : undefined"
                :loading="board.loading"
                :error="board.error ? tBackendError(board.error) : undefined"
                :busy="creatingBoardDraft"
                :navigation-busy="(workspace.gitBusy && !connecting) || phase === 'trust'"
                :column-order="workspace.boardColumnOrder"
                @reorder="
                  (column, ids) =>
                    workspace.reorderBoardColumn(kanbanColumnOrderKey(board.selectedProject, column), ids)
                "
                @reorder-columns="ids => workspace.reorderBoardColumn(kanbanStatusOrderKey, ids)"
                @open="openBoardCard"
                @start-draft="startBoardDraft"
                @card-deleted="onBoardCardDeleted"
                @export="openSessionAction($event, 'export')"
                @create="createBoardDraft"
                @open-project="requestNavigation(switchProject)"
                @retry="board.refresh"
              >
                <template #actions>
                  <Button
                    variant="outline"
                    size="sm"
                    :disabled="(workspace.gitBusy && !connecting) || phase === 'trust'"
                    @click="requestNavigation(switchProject)"
                  >
                    <FolderPlus class="size-3.5" aria-hidden="true" />
                    {{ t("kanban.createProject") }}
                  </Button>
                </template>
              </KanbanBoard>
              <Transition name="kanban-details">
                <KanbanDetailsPanel v-if="showKanban && board.detailsOpen">
                  <header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-3">
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">{{
                      board.selectedCard?.title || t("sidebar.untitled")
                    }}</span>
                    <Button
                      v-if="board.selectedDraft && !board.selectedDraft.sessionFile"
                      variant="ghost"
                      size="icon-sm"
                      :disabled="connecting || navigating"
                      :title="t('kanban.deleteDraft')"
                      :aria-label="t('kanban.deleteDraft')"
                      @click="deleteBoardDraft"
                      ><Trash2 class="size-4"
                    /></Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      :title="t('kanban.openInChat')"
                      :aria-label="t('kanban.openInChat')"
                      @click="openBoardConversationInChat"
                      ><ExternalLink class="size-4"
                    /></Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      :title="t('kanban.closeDetails')"
                      :aria-label="t('kanban.closeDetails')"
                      @click="board.detailsOpen = false"
                      ><X class="size-4"
                    /></Button>
                  </header>
                  <ChatView
                    v-if="phase === 'chat' && boardSelectionReady"
                    ref="boardChat"
                    hide-header
                    defer-read-receipt
                    :key="activeRuntimeId"
                    :session-id="activeRuntimeId"
                    :project="session.cwd || project"
                    :ensure-started="ensureBoardStarted"
                    :connecting="connecting"
                    :selecting-project="selectingProject"
                    :connected="started"
                    sidebar-target="#workspace-main"
                    v-model:right-sidebar-open="rightSidebarOpen"
                    @select-project="selectBoardDraftProject"
                    @open-project="requestNavigation(switchProject)"
                    @new-session="newSessionFromChat"
                    @resume-session="resumeSessionFromRoute"
                    @split-drop="(payload, zone) => handleSplitDrop(payload, zone, activeRuntimeId)"
                  />
                  <div
                    v-else
                    class="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground"
                    role="status"
                  >
                    {{ phase === "down" ? lastError || t("app.exited") : t("chat.historyLoading") }}
                  </div>
                </KanbanDetailsPanel>
              </Transition>
            </div>
            <ScheduledTasksPage
              v-if="route.name === 'schedules'"
              :project="project"
              @resume-session="resumeSessionFromRoute"
            />
            <WelcomeView
              v-else-if="!showKanban && (phase === 'no-pi' || phase === 'pick' || phase === 'detecting')"
              :phase
              :config
              @configured="phase = 'pick'"
              @open-project="switchProject"
              @open-projectless="openProjectless"
            />

            <div v-else-if="phase === 'trust' && trustInfo" class="flex flex-1 items-center justify-center">
              <TrustDialog :info="trustInfo" @done="onTrustDecision" />
            </div>

            <template v-else-if="phase === 'chat' && !showKanban">
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
                    @select-project="selectProjectFromRoute"
                    @open-project="requestNavigation(switchProject)"
                    @new-session="newSessionFromChat"
                    @resume-session="resumeSessionFromRoute"
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
                :ensure-started="workspace.boardDrafts[activeRuntimeId] ? ensureBoardStarted : start"
                :connecting="connecting"
                :selecting-project="selectingProject"
                :connected="started"
                @select-project="selectProjectFromRoute"
                @open-project="requestNavigation(switchProject)"
                @new-session="newSessionFromChat"
                @resume-session="resumeSessionFromRoute"
                @split-drop="(payload, zone) => handleSplitDrop(payload, zone, activeRuntimeId)"
              />
            </template>

            <div
              v-else-if="phase === 'down' && !showKanban"
              class="flex flex-1 flex-col items-center justify-center gap-4 p-8"
            >
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
/* 折叠/展开时对 reka 写入面板的内联 flex-grow 做过渡，两个面板同时过渡保证主区域同步伸缩；
   仅在折叠/展开切换后短暂开启（sidebar-animating），窗口缩放与拖拽调整保持即时。 */
:global(.sidebar-panel-group.sidebar-animating > [data-slot="resizable-panel"]) {
  transition: flex-grow 200ms ease-out;
}

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
