import { ref } from "vue"
import { useI18n } from "vue-i18n"
import type { RpcResponse } from "@/api/protocol"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"

/**
 * Fork dialog: restart the conversation from a previous prompt of the
 * current session.
 */
export function useSessionFork(session: SessionStore, ui: UiStore,
  rpcRequest: <T = unknown>(command: Record<string, unknown>) => Promise<RpcResponse<T>>) {
  const { t } = useI18n()
  const forkOpen = ref(false)
  const forkMessages = ref<{ entryId: string; text: string }[]>([])

  async function openFork() {
    try {
      const res = await rpcRequest<{
        messages: { entryId: string; text: string }[]
      }>({ type: "get_fork_messages" })
      if (!res.success) throw new Error(res.error ?? "fork list failed")
      forkMessages.value = (res.data?.messages ?? []).slice().reverse()
      forkOpen.value = true
    } catch (e) {
      ui.pushToast(String(e), "error")
    }
  }

  /**
   * Branch right AFTER the answer at entryIndex: the new branch keeps this
   * answer and drops the questions (and everything else) that follow it.
   * pi forks *before* a user message, so we fork at the next question.
   */
  async function forkFromAnswer(entryIndex: number) {
    const list = session.entries
    let questionText: string | null = null
    let questionIndex = -1
    for (let i = entryIndex + 1; i < list.length; i++) {
      const e = list[i]
      if (e.kind === "user") { questionText = e.text; questionIndex = i; break }
    }
    if (questionText === null) {
      ui.pushToast(t("chat.toastForkNoLater"), "info")
      return
    }
    try {
      const res = await rpcRequest<{
        messages: { entryId: string; text: string }[]
      }>({ type: "get_fork_messages" })
      if (!res.success) throw new Error(res.error ?? "fork list failed")
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
      if (target) await doFork(target.entryId)
      else await openFork() // fall back to the prompt picker
    } catch (e) {
      ui.pushToast(String(e), "error")
    }
  }

  async function doFork(entryId: string) {
    forkOpen.value = false
    try {
      const res = await rpcRequest<{ text?: string; cancelled?: boolean }>({
        type: "fork",
        entryId,
      })
      if (!res.success) throw new Error(res.error ?? "fork failed")
      if (res.data?.cancelled) {
        ui.pushToast(t("chat.toastForkCancelled"), "info")
        return
      }
      session.clear()
      await session.refreshState()
      await session.loadHistory()
      ui.pushToast(t("chat.toastForked"), "info")
    } catch (e) {
      ui.pushToast(String(e), "error")
    }
  }

  return { forkOpen, forkMessages, openFork, forkFromAnswer, doFork }
}
