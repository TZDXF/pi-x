<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
import { computed, onMounted, onUnmounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  detectPi,
  exportSessionFileHtml,
  listRunningSessions,
  getConfig,
  killPi,
  onPiEvent,
  onPiExit,
  onPiStderr,
  onReconnected,
  onSessionsChanged,
  saveConfig,
  sessionMtime,
  spawnPi,
  trustSave,
  trustStatus,
} from "@/api/piClient"
import type { AppConfig, RunningSession, TrustStatus, WorkspaceContext } from "@/api/piClient"
import { useSessionStore, sessionFor, uiFor, activeRuntimeId, activateSession, createConversation, findConversation } from "@/stores/conversations"
import { useWorkspaceStore, registerSessionMtimeSync, type ProjectGroup } from "@/stores/workspace"
import { useUiStore } from "@/stores/conversations"
import WelcomeView from "@/components/WelcomeView.vue"
import CreateProjectDialog from "@/components/CreateProjectDialog.vue"
import TrustDialog from "@/components/TrustDialog.vue"
import WorkspaceSidebar from "@/components/WorkspaceSidebar.vue"
import SettingsPage from "@/components/SettingsPage.vue"
import { PanelLeft } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import ChatView from "@/components/ChatView.vue"
import { useRoute, navigate } from "@/lib/router"
import { acknowledgeSessionRunStatus, sessionRunStatus } from "@/stores/sessionRunStatus"

const route = useRoute()

type Phase = "detecting" | "no-pi" | "pick" | "trust" | "chat" | "down"

const session = useSessionStore()
const workspace = useWorkspaceStore()
const navigating = ref(false)
const pendingResume = ref<string | null>(null)
const ui = useUiStore()
const { t } = useI18n()

const sidebarOpen = ref(true)
const projectDialogOpen = ref(false)
const editingProjectPath = ref<string | null>(null)

const phase = ref<Phase>("detecting")
const config = ref<AppConfig>({})
const project = ref("")
const trustInfo = ref<TrustStatus | null>(null)
const lastError = ref<string | null>(null)

const started = computed({ get: () => session.started, set: value => { session.started = value } })
const connecting = ref(false)
const selectingProject = ref(false)
// A terminal badge represents an unread result, not a permanent session state.
watch(() => {
  if (phase.value !== "chat" || route.value.name !== "home" || connecting.value || navigating.value) return null
  const file = session.sessionFile
  const status = file ? sessionRunStatus(file) : undefined
  return status === "completed" || status === "error" ? file : null
}, file => acknowledgeSessionRunStatus(file), { immediate: true })
const runtimeWorkspaces = new Map<string, string>()
function contextFor(dir: string): WorkspaceContext | undefined {
  const group = workspace.projectGroups[workspace.projectRoot(dir)]
  return group ? { name: group.name, primary: group.primary, roots: [...group.folders] } : undefined
}
function contextSignature(dir: string) { return JSON.stringify(contextFor(dir) ?? null) }
async function spawnWorkspacePi(dir: string, file?: string, runtimeId = activeRuntimeId.value) {
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

  try {
    const handlers = await Promise.all([
      onPiEvent((ev) => {
        const id = ev.runtimeId ?? "default"
        if (ev.type === "extension_ui_request") {
          uiFor(id).handleRequest(ev as any)
          return
        }
        const owner = sessionFor(id)
        owner.handleEvent(ev)
        if ((ev.type === "agent_end" || ev.type === "agent_settled") && owner.cwd) void workspace.refresh(owner.cwd).catch(console.warn)
      }),
      onSessionsChanged((files) => handleExternalSessionChanges(files)),
      onPiExit((runtimeId) => {
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
      onPiStderr((line, runtimeId) => uiFor(runtimeId ?? activeRuntimeId.value).pushStderr(line)),
      onReconnected(() => {
        if (disposed) return
        // Events during the disconnect gap are lost; restore from the backend.
        if (phase.value === "down") {
          void reattachRunningSessions()
            .then((restored) => {
              if (restored) return
              phase.value = "pick"
              refreshVisibleHistories()
            })
            .catch((e) => { lastError.value = String(e) })
          return
        }
        refreshVisibleHistories()
      }),
    ])
    if (disposed) {
      handlers.forEach((off) => off())
      return
    }
    unlisteners = handlers

    // Metadata writes (rename/archive) by this app must not look external.
    registerSessionMtimeSync((file, mtime) => findConversation(file)?.syncSessionMtime(mtime))

    // Reattach after UI reload / remote connection without spawning duplicates.
    const restored = await reattachRunningSessions()
    if (restored) return
    // Restore the workspace only; start pi when a conversation is opened.
    if (config.value.lastProject) {
      project.value = config.value.lastProject
      await selectProject(project.value)
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
      }
      catch (error) { ui.pushToast(String(error), "error") }
    }
  } finally { navigationRunning.value = false }
}
watch([connecting, navigating], () => { void drainNavigation() })

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
  const restored = running.find(runtime => runtime.project === config.value.lastProject) ?? running[0]
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
  await rebuildConversation(owner)
}

async function selectProject(dir: string) {
  if (workspace.gitBusy || connecting.value) return
  connecting.value = true
  selectingProject.value = true
  phase.value = "chat"
  try {
    // Selecting a project creates an independent, lazily started draft.
    createConversation(dir)
    project.value = dir
    config.value.lastProject = dir
    // Await so quick successive selections cannot persist out of order.
    await saveConfig({ ...config.value })
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
  }
  finally {
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

async function start(): Promise<boolean> {
  // Completion can request a runtime while the draft remains editable.
  if (selectingProject.value || phase.value !== "chat") return false
  const owner = sessionFor(activeRuntimeId.value)
  if (owner.started && runtimeWorkspaces.get(owner.runtimeId) === contextSignature(owner.cwd || project.value)) return true
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
    await spawnWorkspacePi(project.value, undefined, owner.runtimeId)
    await owner.init(project.value, true)
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
  } catch (e) { ui.pushToast(String(e), "error") }
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
  try {
    const dir = targetProject || owner?.cwd || project.value
    const changingProject = dir !== project.value
    if (!owner) owner = createConversation(dir)
    // Select the saved identity before any asynchronous work, never a draft.
    owner.sessionFile = file
    activateSession(owner.runtimeId)
    project.value = dir
    if (changingProject) {
      config.value.lastProject = dir
      await saveConfig({ ...config.value })
      const status = await trustStatus(dir)
      if (status.needsDecision) {
        trustInfo.value = status
        pendingResume.value = file
        phase.value = "trust"
        return
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
    if (owner) {
      await killPi(owner.runtimeId).catch(() => {})
      owner.started = false
    }
    lastError.value = String(e)
    ui.pushToast(String(e), "error")
    phase.value = "down"
  }
  finally { connecting.value = false }
}

/** Export a sidebar session directly from its saved file. Never change the
 * active project or conversation just to perform an action on that file. */
async function openSessionAction(file: string, action: "export") {
  if (action !== "export") return
  try {
    if (await exportSessionFileHtml(file, t("chat.exportDirectory")))
      ui.pushToast(t("chat.toastExported"), "info")
  } catch (error) {
    ui.pushToast(String(error), "error")
  }
}

async function newProjectSession(path: string) {
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
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { navigating.value = false }
}

// Removing a project only removes its navigation entry, never files or logs.
async function removeProject(path: string) {
  if (workspace.gitBusy || navigating.value || connecting.value) return
  navigating.value = true
  try {
    if (workspace.projectRoot(project.value) === path) {
      const nextConfig = { ...config.value, lastProject: undefined }
      // Persist before altering UI so a failure does not silently re-open the project.
      await saveConfig(nextConfig)
      // Removing a navigation entry does not cancel background conversations.
      config.value = nextConfig
      pendingResume.value = null
      trustInfo.value = null
      project.value = ""
      phase.value = "pick"
    }
    workspace.removeProject(path)
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { navigating.value = false }
}

onUnmounted(() => {
  disposed = true
  unlisteners.forEach((off) => off())
  unlisteners = []
})
</script>

<template>
  <div class="desktop-shell flex h-[100dvh] overflow-hidden bg-background text-foreground">
    <!-- Settings is a standalone full-page route: it covers the entire shell. -->
    <WorkspaceSidebar
      v-show="sidebarOpen && route.name !== 'settings'"
      :project="project"
      :ready="phase === 'chat'"
      :busy="navigating || workspace.gitBusy || connecting || phase === 'trust'"
      :navigation-busy="workspace.gitBusy || phase === 'trust'"
      @switch-project="requestNavigation(switchProject)"
      @select-project="path => requestNavigation(() => selectProject(path))"
      @select-conversation="id => requestNavigation(() => selectQueuedConversation(id))"
      @resume-session="(file, path) => requestNavigation(() => resumeSession(file, path))"
      @session-action="(file, action) => openSessionAction(file, action)"
      @new-session="path => requestNavigation(() => newProjectSession(path))"
      @remove-project="removeProject"
      @edit-project="editProject"
      @settings="navigate('/settings/general')"
      @collapse="sidebarOpen = false"
    />
    <main class="workspace-main flex-1 min-w-0 flex flex-col relative overflow-hidden" :style="{ '--workspace-header-left': sidebarOpen ? undefined : '48px' }">
      <template v-if="route.name === 'settings'">
        <SettingsPage :project="project" />
      </template>
      <template v-else>
      <Button
        v-if="!sidebarOpen"
        variant="quiet"
        size="toolbar"
        class="sidebar-restore absolute top-[17px] left-2.5 z-[10] bg-sidebar"
        :title="t('app.expandSidebar')"
        :aria-label="t('app.expandSidebar')"
        @click="sidebarOpen = true"
      >
        <PanelLeft :size="18" />
      </Button>
      <WelcomeView
        v-if="phase === 'no-pi' || phase === 'pick' || phase === 'detecting'"
        :phase
        :config
        @configured="phase = 'pick'"
        @open-project="switchProject"
      />

      <div
        v-else-if="phase === 'trust' && trustInfo"
        class="flex flex-1 items-center justify-center"
      >
        <TrustDialog :info="trustInfo" @done="onTrustDecision" />
      </div>

      <template v-else-if="phase === 'chat'">
        <ChatView :key="activeRuntimeId" :project="project" :ensure-started="start" :connecting="connecting" :selecting-project="selectingProject" :connected="started" @select-project="path => requestNavigation(() => selectProject(path))" @open-project="requestNavigation(switchProject)" @new-session="requestNavigation(() => newProjectSession(workspace.projectRoot(project)))" />
      </template>

      <div
        v-else-if="phase === 'down'"
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
          <ScrollArea viewport-class="max-h-48"><pre class="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{{
            ui.stderrLines.slice(-12).join("\n")
          }}</pre></ScrollArea>
        </div>
        <div class="flex gap-2">
          <Button variant="outline" @click="switchProject">
            {{ t("app.chooseProject") }}
          </Button>
        </div>
      </div>
      </template>
    </main>
    <CreateProjectDialog :open="projectDialogOpen" :edit-path="editingProjectPath" @close="projectDialogOpen = false; editingProjectPath = null" @save="saveProject" />
    <!-- global toasts -->
    <div class="pointer-events-none fixed right-4 bottom-4 z-[100] flex flex-col gap-2">
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="pointer-events-auto max-w-sm rounded-md border px-4 py-3 text-sm shadow-lg"
        :class="{
          'bg-background text-foreground': t.kind === 'info',
          'border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100':
            t.kind === 'warning',
          'border-red-500/50 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100':
            t.kind === 'error',
        }"
      >
        {{ t.message }}
      </div>
    </div>
  </div>
</template>
