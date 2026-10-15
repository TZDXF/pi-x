import { ref, watch, type Ref } from "vue"
import type { SessionStore } from "@/stores/session"
import { composerDraftFiles, composerDraftText, recordComposerDraft } from "@/stores/composerDrafts"

interface ComposerDraftBridge {
  textInput: string
  setTextInput(text: string): void
  files: { file?: File }[]
  addFiles(files: File[]): void
}

/**
 * Syncs unsent text and original attachment files into the per-session draft.
 * Preview object URLs stay owned by the composer and are recreated on remount.
 */
export function useComposerDraftSync<B extends ComposerDraftBridge>(
  session: SessionStore,
  project: () => string,
  bridge: Ref<B | null>,
) {
  const draftFile = ref<string | null>(session.sessionFile)
  const draftProject = () => session.cwd || project()
  const draftTarget = () => session.sessionFile ?? draftFile.value
  const initialDraft = composerDraftText(draftProject(), draftTarget())
  const attachmentFiles = () =>
    (bridge.value?.files ?? []).map(attachment => attachment.file).filter((file): file is File => !!file)

  function restoreDraft() {
    const composer = bridge.value
    if (!composer) return
    // Snapshot both before editing the bridge: synchronous draft updates must
    // not overwrite the saved files while the text is being restored.
    const text = composerDraftText(draftProject(), draftTarget())
    const files = composerDraftFiles(draftProject(), draftTarget())
    if (!composer.textInput && text) composer.setTextInput(text)
    if (!composer.files.length && files.length) composer.addFiles(files)
  }

  watch(bridge, restoreDraft, { immediate: true, flush: "sync" })
  watch(
    () => [bridge.value?.textInput, bridge.value?.files] as const,
    ([text]) => {
      if (text !== undefined) recordComposerDraft(draftProject(), draftTarget(), text, attachmentFiles())
    },
    // Record before an immediate navigation can unmount the composer. Reading
    // only File references also avoids retaining revoked preview object URLs.
    { deep: true, flush: "sync" },
  )
  // A deferred checkout change keeps this composer mounted; move its draft key too.
  watch(project, (next, previous) => {
    const text = bridge.value?.textInput ?? ""
    const files = attachmentFiles()
    recordComposerDraft(previous, draftTarget(), "")
    draftFile.value = session.sessionFile
    recordComposerDraft(next, draftTarget(), text, files)
  })
  // Loading an existing session can set its file after the editor has mounted.
  // Reconnecting may briefly clear sessionFile, so keep its last value as the key.
  watch(
    () => session.sessionFile,
    file => {
      if (file) draftFile.value = file
      if (!bridge.value) return
      if (file && !bridge.value.textInput && !bridge.value.files.length) restoreDraft()
      recordComposerDraft(draftProject(), draftTarget(), bridge.value.textInput, attachmentFiles())
    },
  )
  return { initialDraft }
}
