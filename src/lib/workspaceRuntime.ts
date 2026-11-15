import type { Ref } from "vue"
import { copySshProjectConnection } from "@/lib/ssh"
import type { AppConfig, RunningSession } from "@/api/piClient"
import type { SessionStore } from "@/stores/session"
import { debounce } from "@/lib/timing"
import { auxEventSink } from "@/lib/auxEventSink"
import { isAuxRuntimeId } from "@/lib/auxRuntime"
import { setSessionRunStatus } from "@/stores/sessionRunStatus"
import { sessionIdentityKey } from "@/lib/sessionIdentity"

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
    | "onSshPathBound"
    | "onReconnected"
    | "onWorkspaceStateChanged"
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
    onSshPathBound,
    onReconnected,
    onWorkspaceStateChanged,
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
            // aux 的 runtime 不属于主会话：墓碑命中直接丢弃，**绝不** `sessionFor(id)`
            // 重建（那会留下无人释放的孤儿 store）；存活实例只写 aux 自己的 store。
            if (isAuxRuntimeId(id)) {
              const aux = auxEventSink()
              if (!aux) return
              // 墓碑命中直接丢弃：迟到事件不得复活一个已关闭实例。
              if (aux.isClosed(id)) return
              if (ev.type === "extension_ui_resolved") {
                aux.resolveRequest(id, ev.id)
                return
              }
              if (ev.type === "extension_ui_request") {
                aux.handleRequest(id, ev)
                return
              }
              if (!aux.hasSession(id)) return
              aux.handleEvent(id, ev)
              if (ev.type === "agent_settled") aux.restoreRequests(id, [])
              return
            }
            if (ev.type === "extension_ui_resolved") {
              uiFor(id).resolveRequest(ev.id)
              return
            }
            if (ev.type === "extension_ui_request") {
              uiFor(id).handleRequest(ev as any)
              return
            }
            const owner = sessionFor(id)
            if (!owner.cwd && typeof ev.pixProject === "string") owner.cwd = ev.pixProject
            if (!owner.sessionFile && typeof ev.pixSessionFile === "string") owner.sessionFile = ev.pixSessionFile
            if (ev.type === "scheduled_session_created") {
              owner.cwd = ev.project
              owner.sessionFile = ev.sessionFile
              owner.state = ev.state
              owner.started = true
              // Metadata requests do not replace live entries accumulated below.
              void owner.init(ev.project).catch(console.warn)
            }
            owner.handleEvent(ev)
            if (ev.type === "agent_settled") uiFor(id).restoreRequests([])
            if ((ev.type === "agent_end" || ev.type === "agent_settled") && owner.cwd)
              void workspace.refresh(owner.cwd).catch(console.warn)
          }),
          onSessionsChanged(files => handleExternalSessionChanges(files)),
          onWorkspaceStateChanged(state => {
            if (!isDisposed()) workspace.applyState(state)
          }),
          onPiExit((runtimeId, activity) => {
            pixLog(`pi exit: runtimeId=${runtimeId ?? "<transport>"}`, runtimeId ?? null)
            // An unscoped exit is a transport disconnect; it is not an agent exit.
            if (!runtimeId) {
              if (phase.value === "chat") phase.value = "down"
              return
            }
            // aux：迟到 exit（含关闭后到达的）一律按墓碑丢弃；存活实例只收尾自己的
            // store，不触碰主会话 phase/project 选择。
            if (isAuxRuntimeId(runtimeId)) {
              const aux = auxEventSink()
              // 迟到 exit（含关闭后到达的）按墓碑丢弃，不重建、不碰主会话状态。
              if (!aux || aux.isClosed(runtimeId)) return
              aux.onExit(runtimeId, activity)
              return
            }
            const owner = sessionFor(runtimeId)
            if (activity)
              setSessionRunStatus(
                activity.file,
                activity.status === "idle" ? null : activity.status,
                activity.project,
                activity,
              )
            if (!activity || activity.status === "error") owner.markInterrupted()
            owner.started = false
            owner.isStreaming = false
            owner.isCompacting = false
            owner.partialBlocks = null
            uiFor(runtimeId).restoreRequests([])
            if (runtimeId === activeRuntimeId.value && phase.value === "chat" && !connecting.value) phase.value = "down"
          }),
          onPiStderr((line, runtimeId) => {
            const id = runtimeId ?? activeRuntimeId.value
            // aux 的 stderr 不落到主会话的 ui store（否则面板里会出现别的进程的报错）。
            if (isAuxRuntimeId(id)) {
              const aux = auxEventSink()
              if (!aux || aux.isClosed(id)) return
              aux.pushStderr(id, tBackendError(line))
              return
            }
            uiFor(id).pushStderr(tBackendError(line))
          }),
          onSshPathBound(({ runtimeId, project: rebound }) => {
            // aux 的父会话回绑由父会话自己处理（它持有 project/cwd）；aux runtime
            // 只是跟着同一个 project 启动，不需要在这里再改一次。
            if (isAuxRuntimeId(runtimeId)) return
            // 重连 realpath 回绑（契约 §3.8）：符号链接别名归一化后与原 URI path
            // 不同时，后端回报回绑后的展示 URI。仅更新展示与项目归属，
            // 不中断会话；失败场景后端不发该事件。
            const owner = sessionFor(runtimeId ?? activeRuntimeId.value)
            const previous = owner.cwd
            if (!previous || previous === rebound) return
            pixLog(`ssh path rebound: ${previous} -> ${rebound}`, owner.runtimeId)
            copySshProjectConnection(previous, rebound, config.value.sshConnections ?? [])
            owner.cwd = rebound
            workspace.remember(rebound)
            if (project.value === previous) {
              project.value = rebound
              config.value.lastProject = rebound
            }
          }),
          onReconnected(() => {
            if (isDisposed()) return
            // Recover metadata before reattachment so newly removed projects cannot auto-activate.
            void (async () => {
              await workspace.syncState()
              if (isDisposed()) return
              if (phase.value === "down") {
                const restored = await reattachRunningSessions()
                if (restored) return
                phase.value = "pick"
              } else {
                // Events during a remote transport gap are lost, including UI resolutions.
                await reattachRunningSessions(false)
              }
              refreshVisibleHistories()
            })().catch(error => {
              lastError.value = String(error)
            })
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
  async function reattachRunningSessions(activate = true): Promise<RunningSession | null> {
    const running = await listRunningSessions()
    if (isDisposed()) return null
    // aux 实例关闭即销毁、不参与重连恢复：这里只按 aux 注册表校验存活，
    // 绝不 `sessionFor` 重建，也不把它们的 pending UI 灌进主会话。
    const aux = auxEventSink()
    if (aux)
      for (const runtime of running.filter(item => isAuxRuntimeId(item.runtimeId))) {
        if (aux.isClosed(runtime.runtimeId) || !aux.hasSession(runtime.runtimeId)) continue
        aux.restoreRequests(runtime.runtimeId, runtime.pendingUiRequests ?? [])
        if (runtime.state.isStreaming) aux.handleEvent(runtime.runtimeId, { type: "agent_start" })
      }
    for (const runtime of running.filter(item => !isAuxRuntimeId(item.runtimeId))) {
      const owner = sessionFor(runtime.runtimeId)
      owner.started = true
      await owner.init(runtime.project)
      owner.isStreaming = runtime.state.isStreaming ?? false
      await owner.loadHistory()
      const file = owner.sessionFile || runtime.state.sessionFile
      if (runtime.activity && file) {
        setSessionRunStatus(
          file,
          runtime.activity.status === "idle" ? null : runtime.activity.status,
          runtime.project,
          runtime.activity,
        )
      } else if (owner.isStreaming) owner.markRunning()
      if (runtime.pendingUiRequests) uiFor(runtime.runtimeId).restoreRequests(runtime.pendingUiRequests)
      if (isDisposed()) return null
    }
    const activeFiles = new Set(
      running
        .filter(runtime => runtime.state.isStreaming || runtime.activity?.status === "running")
        .flatMap(runtime =>
          runtime.state.sessionFile ? [sessionIdentityKey(runtime.state.sessionFile, runtime.project)] : [],
        ),
    )
    // A desktop restart kills workers. Persisted running cards must not stay
    // running forever after their worker disappears.
    for (const activity of Object.values(workspace.sessionActivities ?? {})) {
      if (activity.status !== "running" || activeFiles.has(sessionIdentityKey(activity.file, activity.project)))
        continue
      setSessionRunStatus(activity.file, "error", activity.project, {
        runId: activity.runId,
        updatedAt: Math.max(Date.now(), activity.updatedAt + 1),
      })
    }
    // Never auto-activate a project the user explicitly removed, even when its
    // conversations keep running in the background.
    const restorable = running.filter(
      runtime => !isAuxRuntimeId(runtime.runtimeId) && !workspace.isRemovedProject(runtime.project),
    )
    const restored = restorable.find(runtime => runtime.project === config.value.lastProject) ?? restorable[0]
    if (restored && activate) {
      activateSession(restored.runtimeId)
      project.value = restored.project
      phase.value = "chat"
    }
    return restored ?? null
  }

  // ---- external session changes (e.g. the session continued in a terminal) ----

  const refreshVisibleHistories = debounce(() => {
    // Refresh the sidebar lists so previews/titles/timestamps follow the disk.
    const projects = new Set<string>(Object.keys(workspace.histories))
    if (project.value) projects.add(project.value)
    for (const p of projects) void workspace.refresh(p).catch(console.warn)
  }, 600)
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
      owner.clear({ preserveHistory: true })
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
    refreshVisibleHistories.cancel()
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
