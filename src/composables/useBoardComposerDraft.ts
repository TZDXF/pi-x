import { onBeforeUnmount, watch, type Ref } from "vue"
import type { SessionStore } from "@/stores/session"
import type { useWorkspaceStore } from "@/stores/workspace"
import { boardDraftFiles, serializeBoardAttachments } from "@/lib/boardDraftAttachments"
import { modelKey } from "@/lib/modelKey"

interface BoardDraftBridge {
  textInput: string
  isLoading?: boolean
  setTextInput?: (text: string) => void
  files?: { url?: string; filename?: string; mediaType?: string; file?: File }[]
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
  const scope = `board-draft:${draftId}`
  const submitted = () =>
    !!workspace.boardDrafts[draftId]?.sessionFile ||
    session.isStreaming ||
    session.entries.some(entry => entry.kind === "user")
  // The board keeps the original message for its card after submission. It is
  // no longer an editor draft, even if the session file has not arrived yet.
  if (submitted()) return { scope }
  let savedText = draft.message
  let saveVersion = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  async function save() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const current = workspace.boardDrafts[draftId]
    const text = bridge.value?.textInput
    if (!current || submitted() || text === undefined || bridge.value?.isLoading) return
    const version = ++saveVersion
    const selection =
      session.desiredModelKey ||
      (session.currentModel ? modelKey(session.currentModel) : undefined) ||
      session.offlineDefaultModelKey
    const thinking = session.desiredThinkingLevel ?? session.thinkingLevel
    try {
      const attachments = bridge.value?.files
        ? await serializeBoardAttachments(bridge.value.files)
        : current.attachments
      if (version !== saveVersion || submitted() || bridge.value?.isLoading || !workspace.boardDrafts[draftId]) return
      const next = {
        ...workspace.boardDrafts[draftId]!,
        message: text,
        ...(selection ? { modelKey: selection } : {}),
        ...(thinking ? { thinkingLevel: thinking } : {}),
        ...(attachments ? { attachments } : {}),
      }
      if (JSON.stringify(next) !== JSON.stringify(workspace.boardDrafts[draftId]))
        workspace.upsertBoardDraft({ ...next, updatedAt: Date.now() })
    } catch (error) {
      console.warn("[pi] failed to save board attachments:", error)
    }
    savedText = text
  }
  watch(
    () => workspace.boardDrafts[draftId]?.message,
    message => {
      if (submitted() || message === undefined || bridge.value?.textInput !== savedText) return
      savedText = message
      bridge.value.setTextInput?.(message)
    },
  )
  watch(
    () => [
      bridge.value?.textInput,
      bridge.value?.isLoading,
      bridge.value?.files,
      session.desiredModelKey,
      session.currentModel,
      session.offlineDefaultModelKey,
      session.desiredThinkingLevel,
      session.thinkingLevel,
    ],
    () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void save(), 350)
    },
    { flush: "post" },
  )
  onBeforeUnmount(() => void save())
  return { scope, initialText: draft.message, initialFiles: boardDraftFiles(draft.attachments) }
}
