import { nextTick, ref, type ComputedRef, type Ref } from "vue"
import { sessionReference, type KnownSession } from "@/lib/completion"
import { resolveDropZone, type SplitDropZone } from "@/lib/splitDropZone"
import type { SessionStore } from "@/stores/session"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"

export interface SessionDragPayload {
  file: string
  path: string
  runtimeId?: string
}

/**
 * Drag a session row from the sidebar onto the chat view. Edge zones split the
 * view (reported through onSplitDrop); the center keeps the legacy behavior of
 * appending an @session(...) reference to the composer text.
 */
export function useSessionDrop(
  session: SessionStore,
  bridge: Ref<InstanceType<typeof PromptInputBridge> | null>,
  knownSessions: ComputedRef<KnownSession[]>,
  onSplitDrop?: (payload: SessionDragPayload, zone: Exclude<SplitDropZone, "center">) => void,
) {
  const sessionDragOver = ref(false)
  /** Hot zone currently hovered during a split-capable drag; null when idle. */
  const splitZone = ref<SplitDropZone | null>(null)

  function onSessionDragOver(event: DragEvent) {
    if (event.dataTransfer?.types.includes("application/x-pix-session-drag")) {
      event.preventDefault()
      event.dataTransfer.dropEffect = "copy"
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      splitZone.value = resolveDropZone(event.clientX, event.clientY, rect)
      sessionDragOver.value = false
      return
    }
    if (!event.dataTransfer?.types.includes("application/x-pix-session")) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    sessionDragOver.value = true
  }
  function onSessionDragLeave(event: DragEvent) {
    const target = event.currentTarget as HTMLElement
    if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget)) {
      sessionDragOver.value = false
      splitZone.value = null
    }
  }
  function onSessionDrop(event: DragEvent) {
    if (event.dataTransfer?.types.includes("application/x-pix-session-drag")) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      const zone = resolveDropZone(event.clientX, event.clientY, rect)
      splitZone.value = null
      // The center keeps the @session reference behavior below.
      if (zone !== "center") {
        event.preventDefault()
        event.stopPropagation()
        try {
          const payload = JSON.parse(event.dataTransfer.getData("application/x-pix-session-drag")) as SessionDragPayload
          if (payload?.file) onSplitDrop?.(payload, zone)
        } catch {
          // Malformed payload: ignore the split attempt.
        }
      }
      return
    }
    sessionDragOver.value = false
    if (!event.dataTransfer?.types.includes("application/x-pix-session")) return
    event.preventDefault()
    event.stopPropagation()
    const file = event.dataTransfer.getData("application/x-pix-session")
    if (!file || file === session.sessionFile || !knownSessions.value.some(row => row.file === file)) return
    const reference = sessionReference(file)
    const previous = bridge.value?.textInput ?? ""
    bridge.value?.setTextInput(previous + (previous && !/\s$/.test(previous) ? " " : "") + reference + " ")
    nextTick(() => document.querySelector<HTMLElement>(".composer-dock .composer-rich-editor")?.focus())
  }

  return { sessionDragOver, splitZone, onSessionDragOver, onSessionDragLeave, onSessionDrop }
}
