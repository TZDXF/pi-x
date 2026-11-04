import { nextTick, watch, type Ref } from "vue"
import { sameSessionIdentity } from "@/lib/sessionIdentity"
import { isRemoteProject } from "@/lib/ssh"

/** Remote metadata may contain a bare POSIX cwd; retain its list's endpoint in that case. */
export function sidebarSessionProject(cwd: string, path: string) {
  return isRemoteProject(path) && !isRemoteProject(cwd) ? path : cwd
}

export interface SidebarSessionTarget {
  cwd: string
  file?: string | null
  runtimeId?: string
}

/** Match opaque file/runtime identities without interpolating paths into CSS selectors. */
export function findSidebarSessionRow(root: HTMLElement, target: SidebarSessionTarget): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>(".session-row")].find(row =>
    target.file
      ? !!row.dataset.file && sameSessionIdentity(target.file, target.cwd, row.dataset.file, row.dataset.cwd)
      : !!target.runtimeId && row.dataset.runtimeId === target.runtimeId,
  )
}

/** Expanded lists and asynchronously refreshed histories may materialize the row after the sidebar mounts. */
export function useSidebarSessionReveal(
  root: Ref<HTMLElement | null>,
  target: () => SidebarSessionTarget | null | undefined,
  expand: (target: SidebarSessionTarget) => void,
) {
  watch(
    [root, target],
    ([element, request], _previous, onCleanup) => {
      if (!element || !request) return
      let disposed = false
      let revealed = false
      const observer = new MutationObserver(() => void nextTick(reveal))
      function reveal() {
        if (disposed || revealed) return
        const row = findSidebarSessionRow(element!, request!)
        if (!row) return
        row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })
        revealed = true
        observer.disconnect()
      }
      onCleanup(() => {
        disposed = true
        observer.disconnect()
      })
      observer.observe(element, { childList: true, subtree: true })
      expand(request)
      void nextTick(reveal)
    },
    { immediate: true, flush: "post" },
  )
}
