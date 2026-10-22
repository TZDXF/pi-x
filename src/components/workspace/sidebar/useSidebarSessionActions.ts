import { ref } from "vue"
import type { SessionMeta } from "@/api/piClient"

interface SidebarSessionActions {
  label: (session: SessionMeta) => string
  disabled: () => boolean
  navigationDisabled: () => boolean
  resume: (session: SessionMeta) => void
  update: (session: SessionMeta, title: string | null, archived: boolean) => Promise<unknown>
  onError: (error: unknown) => void
}

/** Immediate navigation and optimistic archive state shared by both lists. */
export function useSidebarSessionActions(options: SidebarSessionActions) {
  const renaming = ref<SessionMeta | null>(null)
  const title = ref("")
  const saving = ref(false)
  const archiving = ref<Record<string, boolean>>({})

  function rename(session: SessionMeta) {
    renaming.value = session
    title.value = options.label(session)
  }
  function openSession(session: SessionMeta) {
    if (!options.navigationDisabled()) options.resume(session)
  }
  function renameOnDoubleClick(session: SessionMeta) {
    // Opening on the first click must not wait for the double-click window.
    if (!options.navigationDisabled()) rename(session)
  }

  async function saveTitle() {
    if (!renaming.value || !title.value.trim() || saving.value) return
    saving.value = true
    try {
      await options.update(renaming.value, title.value.trim(), !!renaming.value.archived)
      renaming.value = null
    } catch (error) {
      options.onError(error)
    } finally {
      saving.value = false
    }
  }
  async function archive(session: SessionMeta) {
    if (options.disabled() || archiving.value[session.file]) return
    // Hide immediately; clearing the marker on failure restores the row without reordering it.
    archiving.value[session.file] = true
    try {
      await options.update(session, session.title || null, !session.archived)
    } catch (error) {
      options.onError(error)
    } finally {
      delete archiving.value[session.file]
    }
  }
  return { renaming, title, saving, archiving, rename, openSession, renameOnDoubleClick, saveTitle, archive }
}
