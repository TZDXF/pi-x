import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { rpcNotify } from "@/api/piClient"
import { tBackendError } from "@/i18n"
import type { ExtensionUiRequest } from "@/api/protocol"
import { notifyQuestion } from "@/lib/notifications"

export interface Toast {
  id: number
  message: string
  kind: "info" | "warning" | "error"
}

let toastSeq = 0

export const createUiStore = (runtimeId = "default") => defineStore(`ui:${runtimeId}`, () => {
  /** Dialog requests (select/confirm/input/editor) awaiting user input. */
  const dialogs = ref<ExtensionUiRequest[]>([])
  /** Fire-and-forget widget lines displayed above the composer. */
  const widget = ref<{ key: string, lines: string[], placement: string } | null>(null)
  /** Status bar entries keyed by extension-provided key. */
  const statusEntries = ref<Record<string, string>>({})
  const toasts = ref<Toast[]>([])
  /** Text pushed into the composer by extensions (set_editor_text). */
  const pendingEditorText = ref<string | null>(null)
  /** Tail of pi's stderr output, for diagnostics. */
  const stderrLines = ref<string[]>([])
  function pushStderr(line: string) {
    stderrLines.value.push(line)
    if (stderrLines.value.length > 50)
      stderrLines.value.splice(0, stderrLines.value.length - 50)
  }

  const activeDialog = computed(() => dialogs.value[0] ?? null)

  function handleRequest(req: ExtensionUiRequest) {
    switch (req.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        dialogs.value.push(req)
        notifyQuestion(req.title || req.message || "")
        break

      case "notify":
        pushToast(req.message ?? "", req.notifyType ?? "info")
        break

      case "setStatus":
        if (req.statusKey) {
          if (req.statusText)
            statusEntries.value[req.statusKey] = req.statusText
          else
            delete statusEntries.value[req.statusKey]
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

  function respond(
    req: ExtensionUiRequest,
    value: { value?: string, confirmed?: boolean, cancelled?: boolean },
  ) {
    const idx = dialogs.value.indexOf(req)
    if (idx >= 0)
      dialogs.value.splice(idx, 1)
    void rpcNotify({ type: "extension_ui_response", id: req.id, ...value }, runtimeId)
  }

  function pushToast(message: string, kind: Toast["kind"] = "info") {
    const id = ++toastSeq
    // 后端编码错误在此统一按当前语言翻译；普通文本原样透传。
    toasts.value.push({ id, message: tBackendError(message), kind })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, 5000)
  }

  function clear() {
    dialogs.value = []
    widget.value = null
    statusEntries.value = {}
    stderrLines.value = []
  }

  return {
    dialogs,
    widget,
    statusEntries,
    toasts,
    pendingEditorText,
    stderrLines,
    pushStderr,
    activeDialog,
    handleRequest,
    respond,
    pushToast,
    clear,
  }
})
