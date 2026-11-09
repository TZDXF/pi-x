import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { rpcNotify } from "@/api/piClient"
import { tBackendError } from "@/i18n"
import type { ExtensionUiRequest } from "@/api/protocol"
import { notifyQuestion, type SessionNotificationTarget } from "@/lib/notifications"

export interface Toast {
  id: number
  message: string
  kind: "info" | "warning" | "error"
  action?: { label: string; onClick: () => Promise<unknown> }
  pending?: boolean
}

let toastSeq = 0

export const createUiStore = (
  runtimeId = "default",
  notificationTarget: () => SessionNotificationTarget = () => ({ runtimeId }),
) =>
  defineStore(`ui:${runtimeId}`, () => {
    /** Dialog requests (select/confirm/input/editor) awaiting user input. */
    const dialogs = ref<ExtensionUiRequest[]>([])
    const responding = new Set<string>()
    /** Fire-and-forget widget lines displayed above the composer. */
    const widget = ref<{ key: string; lines: string[]; placement: string } | null>(null)
    /** Status bar entries keyed by extension-provided key. */
    const statusEntries = ref<Record<string, string>>({})
    const toasts = ref<Toast[]>([])
    const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
    /** Text pushed into the composer by extensions (set_editor_text). */
    const pendingEditorText = ref<string | null>(null)
    /** 首条消息发送时 worker 尚未启动（冷启动需数秒）；先在对话区回显这条
     *  消息，等 send() 真正入列后清除，避免启动期间对话区一片空白。 */
    const pendingUserMessage = ref<{ text: string; images: { url: string }[] } | null>(null)
    /** Tail of pi's stderr output, for diagnostics. */
    const stderrLines = ref<string[]>([])
    function pushStderr(line: string) {
      stderrLines.value.push(line)
      if (stderrLines.value.length > 50) stderrLines.value.splice(0, stderrLines.value.length - 50)
    }

    const activeDialog = computed(() => dialogs.value[0] ?? null)

    function handleRequest(req: ExtensionUiRequest) {
      switch (req.method) {
        case "select":
        case "confirm":
        case "input":
        case "editor":
          if (dialogs.value.some(dialog => dialog.id === req.id)) break
          dialogs.value.push(req)
          notifyQuestion(req.title || req.message || "", notificationTarget())
          break

        case "notify":
          pushToast(req.message ?? "", req.notifyType ?? "info")
          break

        case "setStatus":
          if (req.statusKey) {
            if (req.statusText) statusEntries.value[req.statusKey] = req.statusText
            else delete statusEntries.value[req.statusKey]
          }
          break

        case "setWidget":
          widget.value = req.widgetLines
            ? {
                key: req.widgetKey ?? "widget",
                lines: req.widgetLines,
                placement: req.widgetPlacement ?? "aboveEditor",
              }
            : null
          break

        case "set_editor_text":
          pendingEditorText.value = req.text ?? ""
          break

        case "setTitle":
          // window title; harmless in-app
          document.title = req.text ?? document.title
          break
      }
    }

    function resolveRequest(id: string) {
      dialogs.value = dialogs.value.filter(dialog => dialog.id !== id)
    }

    function restoreRequests(requests: ExtensionUiRequest[]) {
      const ids = new Set(requests.map(request => request.id))
      dialogs.value = dialogs.value.filter(dialog => ids.has(dialog.id))
      for (const request of requests) handleRequest(request)
    }

    async function respond(
      req: ExtensionUiRequest,
      value: { value?: string; confirmed?: boolean; cancelled?: boolean },
    ) {
      if (responding.has(req.id)) return
      responding.add(req.id)
      try {
        await rpcNotify({ type: "extension_ui_response", id: req.id, ...value }, runtimeId)
        resolveRequest(req.id)
      } catch (error) {
        pushToast(String(error), "error")
      } finally {
        responding.delete(req.id)
      }
    }

    function dismissToast(id: number) {
      clearTimeout(toastTimers.get(id))
      toastTimers.delete(id)
      toasts.value = toasts.value.filter(t => t.id !== id)
    }

    function expireToast(toast: Toast) {
      toastTimers.set(
        toast.id,
        setTimeout(() => dismissToast(toast.id), toast.action ? 10000 : 5000),
      )
    }

    function pushToast(message: string, kind: Toast["kind"] = "info", action?: Toast["action"]) {
      const id = ++toastSeq
      // 后端编码错误在此统一按当前语言翻译；普通文本原样透传。
      const toast = { id, message: tBackendError(message), kind, action }
      toasts.value.push(toast)
      expireToast(toast)
    }

    async function runToastAction(id: number) {
      const toast = toasts.value.find(t => t.id === id)
      if (!toast?.action || toast.pending) return
      toast.pending = true
      clearTimeout(toastTimers.get(id))
      try {
        await toast.action.onClick()
        dismissToast(id)
      } catch (error) {
        pushToast(String(error), "error")
        toast.pending = false
        expireToast(toast)
      }
    }

    function clear() {
      dialogs.value = []
      widget.value = null
      statusEntries.value = {}
      stderrLines.value = []
      pendingUserMessage.value = null
    }

    return {
      dialogs,
      widget,
      statusEntries,
      toasts,
      pendingEditorText,
      pendingUserMessage,
      stderrLines,
      pushStderr,
      activeDialog,
      handleRequest,
      resolveRequest,
      restoreRequests,
      respond,
      pushToast,
      runToastAction,
      clear,
    }
  })

/** Store instance type for composables and helpers that operate on UI state. */
export type UiStore = ReturnType<ReturnType<typeof createUiStore>>
