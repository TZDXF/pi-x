import { ref } from "vue"
import type { SessionMeta } from "@/api/piClient"

interface SidebarSessionActions {
  label: (session: SessionMeta) => string
  disabled: () => boolean
  navigationDisabled: () => boolean
  resume: (session: SessionMeta) => void
  update: (session: SessionMeta, title: string | null, archived: boolean) => Promise<unknown>
  onError: (error: unknown) => void
  onArchived?: (restore: () => Promise<unknown>) => void
}

/** Immediate navigation and optimistic archive state shared by both lists. */
export function useSidebarSessionActions(options: SidebarSessionActions) {
  const renaming = ref<SessionMeta | null>(null)
  const title = ref("")
  const saving = ref(false)
  const archiving = ref<Record<string, boolean>>({})
  const archivingAll = ref(false)

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
    const archived = !session.archived
    try {
      await options.update(session, session.title || null, archived)
      if (archived) options.onArchived?.(() => options.update(session, session.title || null, false))
    } catch (error) {
      options.onError(error)
    } finally {
      delete archiving.value[session.file]
    }
  }
  /** Archive saved rows through the same metadata update as the single-row action. */
  async function archiveAll(sessions: SessionMeta[]) {
    if (options.disabled() || archivingAll.value) return { total: 0, failed: 0 }
    const targets = sessions.filter(session => !session.archived && !archiving.value[session.file])
    if (!targets.length) return { total: 0, failed: 0 }
    archivingAll.value = true
    for (const session of targets) archiving.value[session.file] = true
    let failed = 0
    try {
      for (const session of targets) {
        try {
          await options.update(session, session.title || null, true)
        } catch {
          failed++
        } finally {
          // Successful rows stay hidden through their archived flag; failed rows reappear here.
          delete archiving.value[session.file]
        }
      }
    } finally {
      archivingAll.value = false
    }
    return { total: targets.length, failed }
  }
  return {
    renaming,
    title,
    saving,
    archiving,
    archivingAll,
    rename,
    openSession,
    renameOnDoubleClick,
    saveTitle,
    archive,
    archiveAll,
  }
}
