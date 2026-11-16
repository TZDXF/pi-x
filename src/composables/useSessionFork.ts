import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { duplicateSessionFile } from "@/api/piClient"
import type { RpcResponse } from "@/api/protocol"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"

/**
 * Fork dialog: restart the conversation from a previous prompt of the
 * current session.
 */
export function useSessionFork(
  session: SessionStore,
  ui: UiStore,
  rpcRequest: <T = unknown>(command: Record<string, unknown>) => Promise<RpcResponse<T>>,
  openSession: (file: string, project: string) => void,
) {
  const { t } = useI18n()
  const forkOpen = ref(false)
  const forkMessages = ref<{ entryId: string; text: string }[]>([])
  let forking = false

  async function openFork() {
    try {
      const res = await rpcRequest<{
        messages: { entryId: string; text: string }[]
      }>({ type: "get_fork_messages" })
      if (!res.success) throw new Error(res.error ?? t("chat.forkFailedList"))
      forkMessages.value = (res.data?.messages ?? []).slice().reverse()
      forkOpen.value = true
    } catch (e) {
      ui.pushToast(String(e), "error")
    }
  }

  /**
   * Branch right AFTER the answer at entryIndex: the new branch keeps this
   * answer and drops the questions (and everything else) that follow it.
   * Copy the branch before the next question, then open it in its own worker.
   * Without a later question, duplicate the whole saved session.
   */
  async function forkFromAnswer(entryIndex: number) {
    if (forking) return
    forking = true
    const list = session.entries
    let questionText: string | null = null
    let questionIndex = -1
    for (let i = entryIndex + 1; i < list.length; i++) {
      const e = list[i]
      if (e.kind === "user") {
        questionText = e.text
        questionIndex = i
        break
      }
    }
    try {
      if (questionText === null) {
        await createFork()
        return
      }
      const res = await rpcRequest<{
        messages: { entryId: string; text: string }[]
      }>({ type: "get_fork_messages" })
      if (!res.success) throw new Error(res.error ?? t("chat.forkFailedList"))
      const chronological = res.data?.messages ?? []
      // Resolve duplicates by occurrence rank: the n-th identical question on
      // this branch maps to the n-th identical entry in the fork list.
      let rank = 0
      for (let i = 0; i <= questionIndex; i++) {
        const e = list[i]
        if (e.kind === "user" && e.text === questionText) rank++
      }
      const matches = chronological.filter(m => m.text === questionText)
      const target = matches[rank - 1] ?? matches[matches.length - 1]
      if (target) await createFork(target.entryId)
      else await openFork() // fall back to the prompt picker
    } catch (e) {
      ui.pushToast(String(e), "error")
    } finally {
      forking = false
    }
  }

  async function doFork(entryId: string) {
    if (forking) return
    forking = true
    try {
      await createFork(entryId)
    } catch (e) {
      ui.pushToast(String(e), "error")
    } finally {
      forking = false
    }
  }

  async function createFork(beforeEntryId?: string) {
    const file = session.sessionFile
    const project = session.cwd
    if (!file) throw new Error(t("chat.forkFailed"))
    const copy = await duplicateSessionFile(file, beforeEntryId, session.runtimeId)
    forkOpen.value = false
    ui.pushToast(t("chat.toastForked"), "info")
    openSession(copy, project)
  }

  return { forkOpen, forkMessages, openFork, forkFromAnswer, doFork }
}
