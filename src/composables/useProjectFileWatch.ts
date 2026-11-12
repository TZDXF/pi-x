import { onScopeDispose, ref, watch } from "vue"
import { onProjectFilesChanged, unwatchProjectFiles, watchProjectFiles } from "@/api/client/projectFiles"
import { samePath } from "@/lib/paths"
import { isRemoteProject } from "@/lib/ssh"

/**
 * Subscribe to filesystem changes of one local project root.
 *
 * `project` returns the root to watch, or an empty string while no watch should
 * run (no project yet, a static resource list, or a remote project — the backend
 * rejects those and the UI keeps manual refresh). Watching is reference counted
 * in the backend, so several sidebar tabs on the same project share one OS
 * watch, and switching roots releases the previous one.
 */
export function useProjectFileWatch(project: () => string, onChange: (paths: string[]) => void) {
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

  async function start(root: string) {
    if (isRemoteProject(root)) return
    let listener: (() => void) | undefined
    try {
      // Register the listener before the watch so no change slips in between.
      listener = await onProjectFilesChanged(change => {
        if (watching.value !== root) return
        // 同一目录可能以大小写/分隔符不同的写法订阅，按路径同一性匹配事件。
        if (samePath(change.project, root)) onChange(change.paths)
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
  }

  function apply() {
    const next = project() || ""
    desired = next
    queue = queue.then(async () => {
      if (next !== desired || next === watching.value) return
      release()
      if (next) await start(next)
    })
  }

  watch(project, apply, { immediate: true })
  onScopeDispose(() => {
    desired = ""
    queue = queue.then(() => {
      release()
    })
  })
  return { watching }
}
