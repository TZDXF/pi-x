import { nextTick, ref, type ComputedRef, type Ref } from "vue"
import { sessionReference, type KnownSession } from "@/lib/completion"
import type { SessionStore } from "@/stores/session"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"

/**
 * Drag a session row from the sidebar onto the chat view: dropping it appends
 * an @session(...) reference to the composer text.
 */
export function useSessionDrop(session: SessionStore, bridge: Ref<InstanceType<typeof PromptInputBridge> | null>, knownSessions: ComputedRef<KnownSession[]>) {
  const sessionDragOver = ref(false)

  function onSessionDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('application/x-pix-session')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    sessionDragOver.value = true
  }
  function onSessionDragLeave(event: DragEvent) {
    const target = event.currentTarget as HTMLElement
    if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget)) sessionDragOver.value = false
  }
  function onSessionDrop(event: DragEvent) {
    sessionDragOver.value = false
    if (!event.dataTransfer?.types.includes('application/x-pix-session')) return
    event.preventDefault()
    event.stopPropagation()
    const file = event.dataTransfer.getData('application/x-pix-session')
    if (!file || file === session.sessionFile || !knownSessions.value.some(row => row.file === file)) return
    const reference = sessionReference(file)
    const previous = bridge.value?.textInput ?? ''
    bridge.value?.setTextInput(previous + (previous && !/\s$/.test(previous) ? ' ' : '') + reference + ' ')
    nextTick(() => document.querySelector<HTMLElement>('.composer-dock .composer-rich-editor')?.focus())
  }

  return { sessionDragOver, onSessionDragOver, onSessionDragLeave, onSessionDrop }
}
