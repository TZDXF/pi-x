import type { Ref } from "vue"
import type { AppConfig, RunningSession } from "@/api/piClient"
import type { SessionStore } from "@/stores/session"

export type WorkspacePhase = "detecting" | "no-pi" | "pick" | "trust" | "chat" | "down"
type Api = typeof import("@/api/piClient")
type Conversations = typeof import("@/stores/conversations")
interface RuntimeContext {
  api: Pick<
    Api,
    | "listRunningSessions"
    | "killPi"
    | "onPiEvent"
    | "onPiExit"
    | "onPiStderr"
    | "onReconnected"
    | "onSessionsChanged"
    | "pixLog"
    | "sessionMtime"
  >
  conversations: Pick<
    Conversations,
    "sessionFor" | "uiFor" | "findConversation" | "activateSession" | "activeRuntimeId"
  >
  workspace: ReturnType<typeof import("@/stores/workspace").useWorkspaceStore>
  phase: Ref<WorkspacePhase>
  config: Ref<AppConfig>
  project: Ref<string>
  connecting: Ref<boolean>
  navigating: Ref<boolean>
  lastError: Ref<string | null>
  isDisposed(): boolean
  spawnWorkspacePi(project: string, file: string, runtimeId: string): Promise<void>
  translateError(line: string): string
  registerSessionMtimeSync(sync: (file: string, mtime: number) => void): void
}

/** Backend event subscriptions, reconnect recovery and external transcript synchronization. */
export function createWorkspaceRuntime(context: RuntimeContext) {
  const {
    workspace,
    phase,
    config,
    project,
    connecting,
    navigating,
    lastError,
    spawnWorkspacePi,
    registerSessionMtimeSync,
    isDisposed,
    translateError: tBackendError,
  } = context
  const {
    listRunningSessions,
    killPi,
    onPiEvent,
    onPiExit,
    onPiStderr,
    onReconnected,
    onSessionsChanged,
    pixLog,
    sessionMtime,
  } = context.api
  const { sessionFor, uiFor, findConversation, activateSession, activeRuntimeId } = context.conversations
  let unlisteners: Array<() => void> = []
  let listenerVersion = 0
  function removeListeners() {
    unlisteners.forEach(off => off())
    unlisteners = []
  }

  async function listen() {
    const version = ++listenerVersion
    removeListeners()
    try {
      await Promise.all(
        [
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
            if (isDisposed()) return
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
        ].map(async registration => {
          const off = await registration
          if (isDisposed() || version !== listenerVersion) off()
          else unlisteners.push(off)
        }),
      )
    } catch (error) {
      if (version === listenerVersion) {
        ++listenerVersion
        removeListeners()
      }
      throw error
    }
    if (isDisposed() || version !== listenerVersion) return

    // Metadata writes (rename/archive) by this app must not look external.
    registerSessionMtimeSync((file, mtime) => findConversation(file)?.syncSessionMtime(mtime))
  }

  /** Reattach to runtimes already alive on the backend (UI reload, remote
   *  reconnect) without spawning duplicates. Returns the restored runtime. */
  async function reattachRunningSessions(): Promise<RunningSession | null> {
    const running = await listRunningSessions()
    if (isDisposed()) return null
    for (const runtime of running) {
      const owner = sessionFor(runtime.runtimeId)
      owner.started = true
      await owner.init(runtime.project)
      owner.isStreaming = runtime.state.isStreaming ?? false
      await owner.loadHistory()
      if (owner.isStreaming) owner.markRunning()
      if (isDisposed()) return null
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

  const pendingReloads = new Map<string, ReturnType<typeof setTimeout>>()
  function scheduleExternalReload(file: string) {
    if (pendingReloads.has(file)) return
    // Let in-flight own writes settle and their mtimes sync first.
    const timer = setTimeout(() => {
      pendingReloads.delete(file)
      void reloadExternalConversation(file).catch(error => {
        const owner = findConversation(file)
        uiFor(owner?.runtimeId ?? activeRuntimeId.value).pushToast(String(error), "error")
      })
    }, 800)
    pendingReloads.set(file, timer)
  }

  /** Restart a conversation's worker so it picks up history appended elsewhere;
   *  `get_messages` reads worker memory, so a reload alone is not enough. */
  async function rebuildConversation(owner: SessionStore) {
    const file = owner.sessionFile
    const dir = owner.cwd
    if (!file || !dir) return
    pixLog(`rebuild: kill+respawn file=${file} streaming=${owner.isStreaming}`, owner.runtimeId)
    const active = owner.runtimeId === activeRuntimeId.value
    const wasConnecting = connecting.value
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
      throw e
    } finally {
      if (active) connecting.value = wasConnecting
    }
  }

  async function reloadExternalConversation(file: string) {
    if (isDisposed() || connecting.value || navigating.value) return
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

  function dispose() {
    ++listenerVersion
    removeListeners()
    if (sessionsListTimer) clearTimeout(sessionsListTimer)
    for (const timer of pendingReloads.values()) clearTimeout(timer)
    pendingReloads.clear()
  }
  return {
    listen,
    dispose,
    reattachRunningSessions,
    rebuildConversation,
    refreshVisibleHistories,
    handleExternalSessionChanges,
  }
}
