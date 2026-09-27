import { i18n } from "@/i18n"
import type { Ref } from "vue"
import type { QueuedPrompt, SessionFlow } from "./types"

/** Reactive state and store callbacks the queue scheduler needs. */
export interface PromptQueueContext {
  promptQueue: Ref<QueuedPrompt[]>
  isStreaming: Ref<boolean>
  isResending: Ref<boolean>
  isCompacting: Ref<boolean>
  flow: SessionFlow
  nextId: () => number
  /** Store's send action, used to dispatch a dequeued prompt. */
  send: (text: string, images?: QueuedPrompt["images"], expandedText?: string, behavior?: "queue" | "steer") => Promise<void>
}

// ---- queue scheduling ----
export function createPromptQueue(ctx: PromptQueueContext) {
  const { promptQueue, isStreaming, isResending, isCompacting, flow, nextId, send } = ctx

  let queueTimer: ReturnType<typeof setTimeout> | undefined
  function armQueueTimer() {
    if (queueTimer !== undefined) clearTimeout(queueTimer)
    queueTimer = undefined
    const times = promptQueue.value.flatMap(item => item.sendAt && (!flow.queuePaused || item.sendAt > Date.now()) ? [item.sendAt] : [])
    if (!times.length) return
    queueTimer = setTimeout(() => {
      queueTimer = undefined
      if (!flow.queuePaused) dispatchQueuedPrompt()
      armQueueTimer()
    }, Math.min(Math.max(100, Math.min(...times) - Date.now()), 2_147_483_647))
  }

  function schedulePrompt(text: string, delayMs: number, images?: QueuedPrompt["images"], expandedText?: string) {
    if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > 365 * 24 * 60 * 60 * 1000)
      throw new Error(i18n.global.t("chat.invalidSendDelay"))
    if (!text.trim() && !images?.length) return
    promptQueue.value.push({ id: nextId(), text: text.trim(), images, expandedText, sendAt: Date.now() + delayMs })
    armQueueTimer()
  }

  function removeQueuedPrompt(id: number) {
    const index = promptQueue.value.findIndex(item => item.id === id)
    if (index < 0) return
    const item = promptQueue.value.splice(index, 1)[0]
    armQueueTimer()
    return item
  }

  function moveQueuedPrompt(id: number, targetId: number) {
    const from = promptQueue.value.findIndex(item => item.id === id)
    const to = promptQueue.value.findIndex(item => item.id === targetId)
    if (from < 0 || to < 0 || from === to) return
    promptQueue.value.splice(to, 0, promptQueue.value.splice(from, 1)[0])
  }

  function executeQueuedPrompt(id: number) {
    if (flow.stopping || isResending.value || isCompacting.value) return
    const item = removeQueuedPrompt(id)
    if (item) void send(item.text, item.images, item.expandedText, "steer")
  }

  function dispatchQueuedPrompt() {
    if (isStreaming.value || flow.stopping || isResending.value || isCompacting.value) return
    flow.queuePaused = false
    const index = promptQueue.value.findIndex(item => !item.sendAt || item.sendAt <= Date.now())
    const next = index < 0 ? undefined : removeQueuedPrompt(promptQueue.value[index].id)
    if (next) void send(next.text, next.images, next.expandedText)
  }

  function clearQueueTimer() {
    if (queueTimer !== undefined) clearTimeout(queueTimer)
    queueTimer = undefined
  }

  return { schedulePrompt, removeQueuedPrompt, moveQueuedPrompt, executeQueuedPrompt, dispatchQueuedPrompt, clearQueueTimer }
}
