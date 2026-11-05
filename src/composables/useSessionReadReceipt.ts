import { getCurrentScope, nextTick, onScopeDispose, watch } from "vue"
import {
  acknowledgeSessionRunStatus,
  sessionRunRevision,
  sessionRunStatus,
  type SessionRunStatus,
} from "@/stores/sessionRunStatus"

interface ReadReceiptSession {
  sessionFile: string | null
  cwd: string
  historyLoading: boolean
  isStreaming: boolean
  entries: readonly { kind: string }[]
}

interface ReadReceiptView {
  viewport: () => HTMLElement | null | undefined
  enabled: () => boolean
  /** Additional loading/connecting gate; required for the explicit identity form. */
  loaded?: () => boolean
  /** Optional rendered result token; changes trigger another post-render check. */
  result?: () => unknown
  /** Keep the terminal status visible while reading; acknowledge it when this view closes. */
  deferAcknowledgement?: boolean
}

export type SessionReadReceiptOptions = ReadReceiptView &
  (
    | { session: ReadReceiptSession | (() => ReadReceiptSession); project?: () => string }
    | {
        file: () => string | null | undefined
        project: () => string
        status: () => SessionRunStatus | undefined
        loaded: () => boolean
      }
  )

/** A selection is not a receipt: require loaded content, focus and its visible bottom. */
export function useSessionReadReceipt(options: SessionReadReceiptOptions) {
  const session = () =>
    "session" in options ? (typeof options.session === "function" ? options.session() : options.session) : undefined
  const file = () => ("file" in options ? options.file() : session()?.sessionFile)
  const project = () => options.project?.() ?? session()?.cwd ?? ""
  const status = () =>
    "status" in options ? options.status() : file() ? sessionRunStatus(file()!, project()) : undefined
  const result = () => options.result?.() ?? session()?.entries[session()!.entries.length - 1]
  const loaded = () => {
    const current = session()
    if (options.loaded?.() === false) return false
    if (!current) return true
    if (current.historyLoading || current.isStreaming) return false
    // An old assistant answer is not the result of a newer unanswered prompt.
    for (let index = current.entries.length - 1; index >= 0; index--) {
      const kind = current.entries[index]?.kind
      if (kind === "assistant") return true
      if (kind === "user") return false
    }
    return false
  }
  let stopped = false
  let generation = 0
  let viewport: HTMLElement | null | undefined
  let resizeObserver: ResizeObserver | undefined
  let mutationObserver: MutationObserver | undefined
  let pendingAcknowledgement: { file: string; project: string; runId: string } | undefined
  const doc = typeof document === "undefined" ? undefined : document
  const win = doc?.defaultView

  function bindViewport() {
    const next = options.viewport()
    if (next === viewport) return
    viewport?.removeEventListener("scroll", schedule)
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    viewport = next
    viewport?.addEventListener("scroll", schedule, { passive: true })
    if (viewport && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(schedule)
      resizeObserver.observe(viewport)
      for (const child of Array.from(viewport.children)) resizeObserver.observe(child)
    }
    if (viewport && typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => {
        if (viewport && resizeObserver) {
          resizeObserver.disconnect()
          resizeObserver.observe(viewport)
          for (const child of Array.from(viewport.children)) resizeObserver.observe(child)
        }
        schedule()
      })
      mutationObserver.observe(viewport, { childList: true, subtree: true, characterData: true, attributes: true })
    }
  }

  function schedule() {
    const ticket = ++generation
    const targetFile = file()
    const targetProject = project()
    const runId = targetFile ? sessionRunRevision(targetFile, targetProject) : undefined
    // Vue's post-render tick prevents measuring the previous answer's DOM.
    void nextTick().then(() => {
      if (stopped || ticket !== generation) return
      bindViewport()
      if (
        !targetFile ||
        !runId ||
        targetFile !== file() ||
        targetProject !== project() ||
        sessionRunRevision(targetFile, targetProject) !== runId ||
        !options.enabled() ||
        !loaded()
      )
        return
      if (status() !== "completed" && status() !== "error") return
      if (!doc || doc.visibilityState !== "visible" || !doc.hasFocus()) return
      if (
        !viewport ||
        !viewport.isConnected ||
        viewport.clientHeight <= 0 ||
        viewport.scrollHeight <= 0 ||
        !viewport.getClientRects().length
      )
        return
      const rect = viewport.getBoundingClientRect()
      if (
        rect.height <= 0 ||
        rect.width <= 0 ||
        rect.bottom <= 0 ||
        (win && (rect.top >= win.innerHeight || rect.bottom > win.innerHeight + 2))
      )
        return
      if (Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) > 2) return
      if (options.deferAcknowledgement) {
        pendingAcknowledgement = { file: targetFile, project: targetProject, runId }
        return
      }
      acknowledgeSessionRunStatus(targetFile, targetProject, runId)
    })
  }

  const stopWatching = watch(
    () => [
      file(),
      project(),
      status(),
      file() ? sessionRunRevision(file()!, project()) : undefined,
      loaded(),
      options.enabled(),
      options.viewport(),
      result(),
    ],
    schedule,
    { immediate: true, deep: true, flush: "post" },
  )
  doc?.addEventListener("visibilitychange", schedule)
  win?.addEventListener("focus", schedule)
  win?.addEventListener("resize", schedule)
  const stop = () => {
    stopped = true
    ++generation
    if (pendingAcknowledgement) {
      const { file, project, runId } = pendingAcknowledgement
      pendingAcknowledgement = undefined
      acknowledgeSessionRunStatus(file, project, runId)
    }
    stopWatching()
    doc?.removeEventListener("visibilitychange", schedule)
    win?.removeEventListener("focus", schedule)
    win?.removeEventListener("resize", schedule)
    viewport?.removeEventListener("scroll", schedule)
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
  }
  if (getCurrentScope()) onScopeDispose(stop)
  return { check: schedule, stop }
}
