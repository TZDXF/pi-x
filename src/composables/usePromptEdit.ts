import { computed, nextTick, ref, watch, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { withFileReferences, withSessionReferences } from "@/lib/completion"
import { dataUrlToImage } from "@/lib/attachments"
import type { KnownSession } from "@/lib/completion"
import type { SessionStore, UserEntry } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"

type WorkspaceStore = ReturnType<typeof useWorkspaceStore>

/** Handle of the inline edit textarea rendered inside the user message. */
export interface PromptEditTextarea {
  $el: HTMLTextAreaElement
}

/**
 * Inline editing of the last question: replaces it at its original position
 * via the store's resendPrompt, without creating a session fork.
 */
export function usePromptEdit(deps: {
  session: SessionStore
  ui: UiStore
  workspace: WorkspaceStore
  /** Textarea element handle, owned by the view (bound via ref="editTextarea"). */
  editTextarea: Ref<PromptEditTextarea | null>
  /** Reactive props of the chat view, read through getters to stay live. */
  project: () => string
  connecting: () => boolean
  connected: () => boolean
  knownSessions: () => KnownSession[]
}) {
  const { t } = useI18n()
  const { session, ui, workspace, editTextarea } = deps
  const { project, connecting, connected, knownSessions } = deps

  // Resend the edited question in this session, interrupting the current answer first.
  const editedPrompt = ref<UserEntry | null>(null)
  const editedText = ref("")
  const editBusy = ref(false)
  const lastUserPromptId = computed(() => {
    for (let i = session.entries.length - 1; i >= 0; i--) {
      if (session.entries[i]?.kind === "user") return session.entries[i].id
    }
    return null
  })
  const editBlocked = computed(
    () =>
      editBusy.value ||
      connecting() ||
      !connected() ||
      workspace.gitBusy ||
      session.isResending ||
      session.historyLoading,
  )

  async function startEditPrompt(entry: UserEntry) {
    if (editBlocked.value || entry.id !== lastUserPromptId.value) return
    editedPrompt.value = entry
    editedText.value = entry.text
    await nextTick()
    editTextarea.value?.$el.focus()
  }

  function cancelEditedPrompt() {
    if (!editBusy.value) editedPrompt.value = null
  }

  watch(
    () => session.sessionFile,
    () => {
      editedPrompt.value = null
    },
  )
  watch(lastUserPromptId, id => {
    if (editedPrompt.value?.id !== id) cancelEditedPrompt()
  })

  async function resendEditedPrompt() {
    const entry = editedPrompt.value
    const text = editedText.value.trim()
    if (!entry || entry.id !== lastUserPromptId.value || editBlocked.value || (!text && !entry.images?.length)) return
    // Validate attachments before stopping the current answer.
    const images = (entry.images ?? []).map(image => dataUrlToImage(image.url))
    if (images.some(image => image === null)) {
      ui.pushToast(t("chat.editAttachmentError"), "error")
      return
    }
    editBusy.value = true
    try {
      await session.resendPrompt(
        text,
        images.length ? (images as { data: string; mimeType: string }[]) : undefined,
        withFileReferences(
          withSessionReferences(text, knownSessions()),
          workspace.projectFolders(project()).filter(path => path !== project()),
        ),
      )
      editedPrompt.value = null
    } catch (error) {
      ui.pushToast(String(error), "error")
    } finally {
      editBusy.value = false
    }
  }

  return {
    editedPrompt,
    editedText,
    editBusy,
    lastUserPromptId,
    editBlocked,
    startEditPrompt,
    cancelEditedPrompt,
    resendEditedPrompt,
  }
}
