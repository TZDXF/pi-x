import { ref } from "vue"
import type { SessionMeta } from "@/api/piClient"

/** Archive a fresh on-disk enumeration through the same metadata update as single-session archive. */
export function useArchiveAllSessions(
  update: (session: SessionMeta, title: string | null, archived: boolean) => Promise<unknown>,
  /** Optional per-row failure hook so callers can record a diagnostic code. */
  onRowError?: (error: unknown) => void,
) {
  const archivingAll = ref(false)

  async function archiveAll(sessions: SessionMeta[]) {
    if (archivingAll.value) return { total: 0, failed: 0 }
    const unique = new Map<string, SessionMeta>()
    for (const session of sessions)
      if (!session.archived && !unique.has(session.file)) unique.set(session.file, session)
    const targets = [...unique.values()]
    if (!targets.length) return { total: 0, failed: 0 }
    archivingAll.value = true
    let failed = 0
    try {
      for (const session of targets) {
        try {
          await update(session, session.title || null, true)
        } catch (error) {
          failed++
          onRowError?.(error)
        }
      }
    } finally {
      archivingAll.value = false
    }
    return { total: targets.length, failed }
  }

  return { archivingAll, archiveAll }
}
