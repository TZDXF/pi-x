import { sameSessionIdentity } from "@/lib/sessionIdentity"
import { isRemoteProject } from "@/lib/ssh"

/** Worker operations shared by regular navigation and split-pane loading. */
export interface LoadableConversation {
  runtimeId: string
  cwd: string
  sessionFile: string | null
  syncedSessionMtime: number | null
  started: boolean
  isStreaming: boolean
  isResending: boolean
  clear(): void
  init(project: string): Promise<void>
  loadHistory(): Promise<void>
  markRunning(): void
}

interface RunningConversation {
  runtimeId: string
  project: string
  state: { sessionFile?: string | null; isStreaming: boolean }
}

export interface ConversationLoaderDependencies<T extends LoadableConversation> {
  listRunning(): Promise<RunningConversation[]>
  sessionFor(runtimeId: string): T
  spawn(project: string, file: string, runtimeId: string): Promise<void>
  kill(runtimeId: string): Promise<unknown>
  mtime(file: string): Promise<number>
  rebuild(owner: T): Promise<void>
}

/** Never activates a conversation; navigation and trust decisions belong to callers. */
export function createConversationLoader<T extends LoadableConversation>(deps: ConversationLoaderDependencies<T>) {
  async function reconcile(owner: T) {
    if (!owner.started || !owner.sessionFile || owner.isStreaming || owner.isResending || isRemoteProject(owner.cwd)) return
    const file = owner.sessionFile
    const disk = await deps.mtime(file).catch(() => null)
    // A turn may have started while the filesystem request was in flight.
    if (
      disk != null &&
      disk !== owner.syncedSessionMtime &&
      owner.sessionFile === file &&
      !owner.isStreaming &&
      !owner.isResending
    )
      await deps.rebuild(owner)
  }

  async function load(owner: T, file: string, project: string): Promise<T> {
    let ownedWorker = false
    let loadedHistory = false
    try {
      owner.sessionFile = file
      if (!owner.started) {
        const running = await deps.listRunning()
        const runtime = running.find(
          item => sameSessionIdentity(item.state.sessionFile, item.project, file, project),
        )
        if (runtime) {
          const placeholder = owner
          owner = deps.sessionFor(runtime.runtimeId)
          if (!owner.started) {
            owner.sessionFile = file
            // Mark streaming before history supplementation so a running failure
            // is not presented as the final stop reason of the conversation.
            owner.isStreaming = runtime.state.isStreaming
            await owner.init(runtime.project)
            await owner.loadHistory()
            owner.started = true
            loadedHistory = true
            if (owner.isStreaming) owner.markRunning()
          }
          if (placeholder !== owner) placeholder.sessionFile = null
        }
      }
      if (!owner.started) {
        owner.clear()
        owner.sessionFile = file
        ownedWorker = true
        await deps.spawn(project, file, owner.runtimeId)
        await Promise.all([owner.init(project), owner.loadHistory()])
        owner.started = true
        loadedHistory = true
      }
      if (!loadedHistory) await reconcile(owner)
      return owner
    } catch (error) {
      // Never kill a worker owned by the scheduler or another window on attach failure.
      if (ownedWorker) {
        await deps.kill(owner.runtimeId).catch(() => {})
        owner.started = false
      }
      throw error
    }
  }

  return { load, reconcile }
}
