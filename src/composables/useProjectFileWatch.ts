import { onScopeDispose, ref, watch } from "vue"
import {
  onProjectFilesChanged,
  setProjectFilesInterest,
  unwatchProjectFiles,
  watchProjectFiles,
} from "@/api/client/projectFiles"
import { samePath } from "@/lib/paths"
import { isRemoteProject } from "@/lib/ssh"

/** One filesystem report from the backend. */
export interface ProjectFilesChange {
  /** Project-relative paths that changed inside the browsed scope. */
  paths: string[]
  /** The watch was re-armed or lost its root: reload every loaded directory. */
  reset: boolean
}

export interface ProjectFileWatchOptions {
  /** Root to watch; "" disables the subscription. */
  project: () => string
  /** Directories and files the UI currently shows, as project-relative paths. */
  interest?: () => string[]
  onChange: (change: ProjectFilesChange) => void
}

/**
 * Subscribe to filesystem changes of one local project root.
 *
 * The front-end tells the backend what it currently shows (loaded directories
 * plus the previewed file) via `interest`; only changes inside that scope are
 * reported, so an unopened `node_modules` costs nothing while every browsable
 * directory still syncs once loaded. Watching is reference counted in the
 * backend, so several sidebar tabs on the same project share one OS watch.
 *
 * Remote projects are not watched (the backend rejects them) and keep manual
 * refresh; a missing event channel degrades the same way.
 */
export function useProjectFileWatch(options: ProjectFileWatchOptions) {
  /** Root currently watched ("" when nothing is watched). */
  const watching = ref("")
  let off: (() => void) | undefined
  /** Latest requested root; also invalidates superseded async transitions. */
  let desired = ""
  /** Serializes start/stop so rapid project switches cannot interleave. */
  let queue: Promise<void> = Promise.resolve()

  function release() {
    off?.()
    off = undefined
    const previous = watching.value
    watching.value = ""
    if (previous) void unwatchProjectFiles(previous).catch(() => undefined)
  }

  function publishInterest() {
    const root = watching.value
    if (!root) return
    const paths = options.interest?.() ?? [""]
    void setProjectFilesInterest(root, paths).catch(() => undefined)
  }

  async function start(root: string) {
    if (isRemoteProject(root)) return
    let listener: (() => void) | undefined
    try {
      // Register the listener before the watch so no change slips in between.
      listener = await onProjectFilesChanged(change => {
        if (watching.value !== root) return
        // 同一目录可能以大小写/分隔符不同的写法订阅，按路径同一性匹配事件。
        if (samePath(change.project, root)) options.onChange({ paths: change.paths, reset: change.reset })
      })
    } catch {
      return // No event channel (remote browser build): manual refresh stays available.
    }
    if (desired !== root) {
      listener()
      return
    }
    off = listener
    try {
      await watchProjectFiles(root)
    } catch {
      // Unwatchable directory or a backend without the command: stay silent.
      release()
      return
    }
    if (desired !== root) {
      release() // Superseded while awaiting the backend.
      return
    }
    watching.value = root
    publishInterest()
  }

  function apply() {
    const next = options.project() || ""
    desired = next
    queue = queue.then(async () => {
      if (next !== desired || next === watching.value) return
      release()
      if (next) await start(next)
    })
  }

  watch(options.project, apply, { immediate: true })
  if (options.interest) watch(options.interest, publishInterest, { deep: true })
  onScopeDispose(() => {
    desired = ""
    queue = queue.then(() => {
      release()
    })
  })
  return { watching }
}
