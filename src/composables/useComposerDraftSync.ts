import { ref, watch, type Ref } from "vue"
import type { SessionStore } from "@/stores/session"
import { composerDraftText, recordComposerDraft } from "@/stores/composerDrafts"

/**
 * Syncs the composer text into the draft store. The draft key follows the
 * session file so each session keeps its own unsent text.
 */
export function useComposerDraftSync<B extends { textInput: string; setTextInput(text: string): void }>(
  session: SessionStore,
  project: () => string,
  bridge: Ref<B | null>,
) {
  const draftFile = ref<string | null>(session.sessionFile)
  const draftProject = () => session.cwd || project()
  const draftTarget = () => session.sessionFile ?? draftFile.value
  const initialDraft = composerDraftText(draftProject(), draftTarget())
  watch(
    () => bridge.value?.textInput,
    text => {
      if (text !== undefined) recordComposerDraft(draftProject(), draftTarget(), text)
    },
  )
  // A deferred checkout change keeps this composer mounted; move its draft key too.
  watch(project, (next, previous) => {
    const text = bridge.value?.textInput ?? ""
    recordComposerDraft(previous, draftTarget(), "")
    draftFile.value = session.sessionFile
    recordComposerDraft(next, draftTarget(), text)
  })
  // Loading an existing session can set its file after the editor has mounted.
  // Reconnecting may briefly clear sessionFile, so keep its last value as the key.
  watch(
    () => session.sessionFile,
    file => {
      if (file) draftFile.value = file
      if (!bridge.value) return
      if (file && !bridge.value.textInput) {
        const saved = composerDraftText(draftProject(), file)
        if (saved) bridge.value.setTextInput(saved)
      }
      recordComposerDraft(draftProject(), draftTarget(), bridge.value.textInput)
    },
  )
  return { initialDraft }
}
