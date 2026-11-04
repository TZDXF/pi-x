import { onBeforeUnmount, watch, type Ref } from "vue"
import type { SessionStore } from "@/stores/session"
import type { useWorkspaceStore } from "@/stores/workspace"

interface BoardDraftBridge {
  textInput: string
  isLoading?: boolean
  setTextInput?: (text: string) => void
}

/** Keep each todo's input independent; submitting must not persist the transient empty editor. */
export function useBoardComposerDraft(
  session: SessionStore,
  workspace: ReturnType<typeof useWorkspaceStore>,
  bridge: Ref<BoardDraftBridge | null>,
) {
  const draft = Object.values(workspace.boardDrafts ?? {}).find(
    draft => (draft.runtimeId || draft.id) === session.runtimeId,
  )
  if (!draft) return {}
  const draftId = draft.id
  let savedText = draft.message
  let timer: ReturnType<typeof setTimeout> | undefined
  function save() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const current = workspace.boardDrafts[draftId]
    const text = bridge.value?.textInput
    if (
      !current ||
      current.sessionFile ||
      text === undefined ||
      bridge.value?.isLoading ||
      session.isStreaming ||
      session.entries.some(entry => entry.kind === "user") ||
      text === savedText
    )
      return
    workspace.upsertBoardDraft({ ...current, message: text, updatedAt: Date.now() })
    savedText = text
  }
  watch(
    () => workspace.boardDrafts[draftId]?.message,
    message => {
      if (message === undefined || bridge.value?.textInput !== savedText) return
      savedText = message
      bridge.value.setTextInput?.(message)
    },
  )
  watch(
    () => [bridge.value?.textInput, bridge.value?.isLoading],
    () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(save, 350)
    },
    { flush: "post" },
  )
  onBeforeUnmount(save)
  return { scope: `board-draft:${draftId}`, initialText: draft.message }
}
