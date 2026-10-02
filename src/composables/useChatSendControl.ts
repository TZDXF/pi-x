import { computed, ref, watch, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { getConfig, type WorkspaceSelection } from "@/api/piClient"
import { parseSendDelay, stepSendDelayWheel } from "@/lib/sendDelay"
import { dataUrlToImage, isImageUrl } from "@/lib/attachments"
import { withSessionReferences, desktopCommands, type KnownSession } from "@/lib/completion"
import { buildPromptWithCodeComments } from "@/lib/codeComments"
import { runningBehavior } from "@/lib/runningBehavior"
import { useCodeCommentsStore } from "@/stores/codeComments"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import type { useWorkspaceStore } from "@/stores/workspace"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"

/** 发送控制仅绑定调用方会话；输入上下文仍由 PromptInput/bridge 管理。 */
export function useChatSendControl(deps: {
  session: SessionStore
  ui: UiStore
  workspace: ReturnType<typeof useWorkspaceStore>
  bridge: Ref<InstanceType<typeof PromptInputBridge> | null>
  project: () => string
  connecting: () => boolean
  editBusy: () => boolean
  knownSessions: () => KnownSession[]
  workspaceSelection: () => WorkspaceSelection | null
  ensureStarted: (selection?: WorkspaceSelection | null) => Promise<boolean>
  newSession: () => void
}) {
  const { session, ui, workspace, bridge } = deps
  const { t } = useI18n()
  // ---- 代码批注（项目文件页添加，随下一条消息发出） ----
  const codeComments = useCodeCommentsStore()
  const pendingComments = computed(() => (codeComments.project === deps.project() ? codeComments.comments : []))
  const attachments = computed(() => bridge.value?.files ?? [])
  // extensions can push text into the editor (set_editor_text))
  watch(
    () => ui.pendingEditorText,
    text => {
      if (text !== null) {
        bridge.value?.setTextInput(text)
        ui.pendingEditorText = null
      }
    },
  )

  // pi's prompt/steer/follow_up disposition ("handled" / "queued") surfaces as a toast
  watch(
    () => session.dispositionNotice,
    notice => {
      if (notice) ui.pushToast(notice.message)
    },
  )

  const delayedSend = ref(false)
  // 延迟发送是内置插件，关闭后隐藏入口；配置加载失败时按缺省启用处理。
  const delayedSendEnabled = ref(true)
  void getConfig()
    .then(config => {
      if (config.builtinDelayedSend === false) {
        delayedSendEnabled.value = false
        delayedSend.value = false
      }
    })
    .catch(() => {})
  const showStopButton = computed(
    () => session.isStreaming && !delayedSend.value && !bridge.value?.textInput?.trim() && !attachments.value.length,
  )
  const sendDelayMinutes = ref<number | null>(10)
  const sendDelaySeconds = ref<number | null>(0)
  const sendDelay = computed(() =>
    sendDelayMinutes.value === null || sendDelaySeconds.value === null
      ? ""
      : `${sendDelayMinutes.value}:${String(sendDelaySeconds.value).padStart(2, "0")}`,
  )

  function onSendDelayWheel(event: WheelEvent, unit: "minutes" | "seconds") {
    const target = unit === "minutes" ? sendDelayMinutes : sendDelaySeconds
    const next = stepSendDelayWheel(target.value, event.deltaY, event.deltaX, unit === "minutes" ? 525600 : 59)
    if (next === null) return
    event.preventDefault()
    target.value = next
  }

  async function onSubmit(message: { text?: string; files?: { url?: string }[] }) {
    if (workspace.gitBusy || deps.connecting() || deps.editBusy()) return
    const text = (message.text ?? "").trim()
    const images = (message.files ?? [])
      .map(f => f.url)
      .filter((u): u is string => isImageUrl(u))
      .map(u => dataUrlToImage(u))
      .filter((im): im is { data: string; mimeType: string } => im !== null)
    if (!text && !images.length) return
    const delayMs = delayedSend.value ? parseSendDelay(sendDelay.value) : null
    if (delayedSend.value && delayMs === null) {
      ui.pushToast(t("chat.invalidSendDelay"), "error")
      throw new Error(t("chat.invalidSendDelay"))
    }
    if (!(await deps.ensureStarted(session.entries.length ? null : deps.workspaceSelection()))) {
      bridge.value?.setTextInput(text)
      throw new Error(t("completion.startFailed"))
    }
    const commandName = /^\/([^\s/]+)/.exec(text)?.[1]
    if (commandName) {
      await session.refreshCommands()
      if (!session.commands.some(c => c.name === commandName) && desktopCommands.some(name => name === commandName)) {
        if (delayedSend.value) {
          const error = t("chat.delayedCommandUnsupported", {
            commands: desktopCommands.map(name => `/${name}`).join(", "),
          })
          ui.pushToast(error, "error")
          throw new Error(error)
        }
        const args = text.slice(commandName.length + 1).trim()
        try {
          if (images.length || (args && commandName !== "compact")) throw new Error(t("completion.invalidArguments"))
          if (commandName === "new") deps.newSession()
          // /compact queues behind an active run instead of aborting it; the
          // store executes the command once the queue reaches it.
          else if (commandName === "compact") await session.send(text, undefined, undefined, runningBehavior.value)
        } catch (error) {
          ui.pushToast(String(error), "error")
          throw error
        }
        return
      }
      if (!session.commands.some(c => c.name === commandName)) {
        const error = t("completion.unsupported", { name: commandName })
        ui.pushToast(error, "error")
        throw new Error(error)
      }
    }
    const extensionCommand =
      commandName && session.commands.some(c => c.name === commandName && c.source === "extension")
    const expandedText = extensionCommand ? text : withSessionReferences(text, deps.knownSessions())
    // 批注只拼进发给 agent 的 prompt；聊天气泡仍显示用户输入的原文。
    const comments = [...pendingComments.value]
    const promptWithComments = comments.length ? buildPromptWithCodeComments(expandedText, comments) : expandedText
    if (delayedSend.value) {
      session.schedulePrompt(text, delayMs!, images.length ? images : undefined, promptWithComments)
      delayedSend.value = false
      if (comments.length) codeComments.clear()
    } else {
      if (comments.length) codeComments.clear()
      await session.send(text, images.length ? images : undefined, promptWithComments, runningBehavior.value)
    }
  }

  async function abort() {
    const restored = await session.abortAndRestore()
    if (restored) bridge.value?.setTextInput(restored)
  }

  return {
    attachments,
    pendingComments,
    codeComments,
    delayedSend,
    delayedSendEnabled,
    showStopButton,
    sendDelayMinutes,
    sendDelaySeconds,
    onSendDelayWheel,
    onSubmit,
    abort,
  }
}
