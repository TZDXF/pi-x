import { computed, onScopeDispose, ref, watch, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { getConfig, type WorkspaceSelection } from "@/api/piClient"
import { parseSendDelay, stepSendDelayWheel } from "@/lib/sendDelay"
import { dataUrlToImage, isImageAttachment, isImageUrl } from "@/lib/attachments"
import { withSessionReferences, desktopCommands, type KnownSession } from "@/lib/completion"
import { commentFilePath } from "@/lib/codeComments"
import { appendComposerText } from "@/lib/composer"
import { serializeComposerPromptContexts } from "@/lib/promptContexts"
import { runningBehavior } from "@/lib/runningBehavior"
import { auxSelectionItems, clearAuxSelectionBucket, removeAuxSelection } from "@/stores/auxSelections"
import { useCodeCommentsStore } from "@/stores/codeComments"
import { useConversationSelectionsStore } from "@/stores/conversationSelections"
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
  /**
   * 启动失败、且输入框已经不在了时的兜底（aux 面板用，TZD-155）。
   *
   * `ensureStarted` 返回 false 时 `bridge` 可能已经是 `null`：aux 的失败态把输入区换成了
   * 错误页，`setTextInput` 无处可写，本次提交的文本会丢（aux 没有 session 文件，用户输入
   * 无从找回）。调用方在这里把文本存回自己的草稿，重试回到 `ready` 后面板重新挂载时回填。
   * 主会话不传（它的输入框始终在，走原有的 `setTextInput` 回填）。
   */
  onStartFailed?: (text: string) => void
  newSession: () => void
  /** 消息实际进入对话流（非本地排队/延迟发送）后触发，用于滚动回底部。 */
  onSent?: () => void
  /**
   * 共享输入上下文的归属：
   * - `shared`（默认）：代码批注/划词引用按会话存入全局 store（主会话行为不变）；
   * - `aux`：aux 面板使用（TZD-103）。读 **本实例** 的引用桶（`session.runtimeId`），
   *   发送成功只清本桶；代码批注仍一律视为空（`projects` 级批注不被 aux 消费）；
   * - `none`：完全隔离（不读不写任何桶）。
   */
  contexts?: "shared" | "aux" | "none"
  /**
   * aux 的**父上下文**块内文（`docs/aux-chat-spec.md` §3/§4，TZD-102；气泡不展示该块）。
   *
   * 只在**首轮**返回值：调用方（`AuxChatPane`）按 aux `runtimeId` 记账，第 2/3 轮返回
   * `null`，于是块不会被重复拼上（单测钉住"连续三轮仅首轮注入"）。主会话不传。
   */
  parentContext?: () => Promise<string | null>
}) {
  const { session, ui, workspace, bridge } = deps
  const { t } = useI18n()
  // aux 面板不参与共享上下文（见 `contexts`）：代码批注一律视为空。
  const isolated = deps.contexts === "aux" || deps.contexts === "none"
  // aux 只读自己的引用桶（键是 aux 的 runtimeId，一实例一桶）。
  const auxScoped = deps.contexts === "aux"
  // ---- 代码批注（项目文件页添加）与对话划词引用（会话气泡划词添加），随下一条消息发出 ----
  const codeComments = useCodeCommentsStore()
  const pendingComments = computed(() =>
    isolated ? [] : codeComments.project === deps.project() ? codeComments.comments : [],
  )
  const conversationSelections = useConversationSelectionsStore()
  // 引用按会话归属；会话尚未落盘时退回项目维度，与划词入口的 scope 计算一致。
  const selectionScope = computed(() => session.sessionFile ?? deps.project())
  const pendingSelections = computed(() => {
    // aux：只读本实例的桶（绝不回退到主会话桶，两者互不消费）。
    if (auxScoped) return [...auxSelectionItems(session.runtimeId)]
    if (isolated) return []
    return conversationSelections.scope === selectionScope.value ? conversationSelections.items : []
  })
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

  function onInputError(error: { code: string }) {
    if (error.code === "attachment_read_error") ui.pushToast(t("chat.attachmentReadFailed"), "error")
    if (error.code === "accept") ui.pushToast(t("chat.imageAttachmentsOnly"), "error")
  }

  // Navigation owns connecting globally. Keep the editor usable, but wait before
  // dispatching to this composer's session; unmounting cancels pending submits.
  const pendingSubmits = new Set<() => void>()
  onScopeDispose(() => {
    for (const cancel of pendingSubmits) cancel()
  })

  function waitForConnection(): Promise<boolean> {
    if (!deps.connecting()) return Promise.resolve(true)
    return new Promise(resolve => {
      const finish = (ready: boolean) => {
        stop()
        pendingSubmits.delete(cancel)
        resolve(ready)
      }
      const cancel = () => finish(false)
      const stop = watch(deps.connecting, connecting => {
        if (!connecting) finish(true)
      })
      pendingSubmits.add(cancel)
    })
  }

  async function onSubmit(message: {
    text?: string
    files?: { url?: string; mediaType?: string; filename?: string }[]
  }) {
    if (workspace.gitBusy || deps.editBusy()) return
    if (!(await waitForConnection())) return
    if (workspace.gitBusy || deps.editBusy()) return
    const text = (message.text ?? "").trim()
    const files = message.files ?? []
    if (files.some(file => !isImageAttachment(file))) {
      const error = t("chat.imageAttachmentsOnly")
      ui.pushToast(error, "error")
      throw new Error(error)
    }
    const images = files
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
    const commandName = /^\/([^\s/]+)/.exec(text)?.[1]
    const desktopCommand = !!commandName && desktopCommands.some(name => name === commandName)
    // 新会话首条消息要先把 worker 冷启动（秒级）；先把消息回显到对话区，
    // 避免启动期间一片空白。桌面命令（/new、/compact）不走 send，不回显。
    const staged = !delayedSend.value && !desktopCommand && session.entries.length === 0
    if (staged)
      ui.pendingUserMessage = {
        text,
        images: images.map(im => ({ url: `data:${im.mimeType};base64,${im.data}` })),
      }
    try {
      if (!(await deps.ensureStarted(session.entries.length ? null : deps.workspaceSelection()))) {
        const currentText = bridge.value?.textInput ?? ""
        // 启动等待期间可能又引入了批注或编辑了草稿；恢复原提交时保留这些新内容。
        if (bridge.value) {
          bridge.value.setTextInput(currentText && currentText !== text ? appendComposerText(text, currentText) : text)
        } else if (text) {
          // 输入区已经卸载（aux 失败态）：交给调用方存回草稿，否则这次提交的文本会丢。
          deps.onStartFailed?.(text)
        }
        throw new Error(t("completion.startFailed"))
      }
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
      }
      const extensionCommand =
        commandName && session.commands.some(c => c.name === commandName && c.source === "extension")
      const expandedText = extensionCommand ? text : withSessionReferences(text, deps.knownSessions())
      // 上下文只拼进发给 agent 的 prompt；聊天气泡仍显示用户输入的原文。
      // 父上下文块在最前（仅 aux 首轮），其后 userselect 尾块、Code comments 尾块。
      // 跨目录批注在这里改写为带目录前缀的路径，agent 才能按自身 cwd 之外的目录寻址。
      const comments = pendingComments.value.map(comment => ({ ...comment, path: commentFilePath(comment) }))
      const selections = [...pendingSelections.value]
      // 首轮取父上下文（aux 才有；返回值只在首轮非空）。失败不得阻断发送：
      // 父上下文是“带得走就拿”的内容，不是发送的前置条件；但降级要**如实**告诉用户，
      // 不能让人只看到“没有块”而不知道原因（采集器自身已把无输入等情形做成顶部提示，
      // 走到这里的 reject 属于意外故障）。
      const parentContext = deps.parentContext
        ? await deps.parentContext().catch((error: unknown) => {
            ui.pushToast(t("chat.parentContextFailed", { reason: String(error ?? "") }), "warning")
            return null
          })
        : null
      const promptWithContexts =
        parentContext || comments.length || selections.length
          ? serializeComposerPromptContexts(expandedText, { comments, selections, parentContext })
          : expandedText
      if (delayedSend.value) {
        session.schedulePrompt(text, delayMs!, images.length ? images : undefined, promptWithContexts)
        delayedSend.value = false
        if (comments.length) codeComments.clear()
        consumeSelections()
      } else {
        // 压缩中或运行中且偏好本地排队时消息不进对话流，保持阅读位置；否则发送后回底，
        // 即使此前向上翻阅过历史，也能立刻看到新消息与即将开始的回答。
        const queuedLocally = session.isCompacting || (session.isStreaming && runningBehavior.value === "queue")
        if (comments.length) codeComments.clear()
        consumeSelections()
        await session.send(text, images.length ? images : undefined, promptWithContexts, runningBehavior.value)
        if (!queuedLocally) deps.onSent?.()
      }
    } finally {
      // 无论启动、命令校验还是发送如何退出，都清理本次首条消息的预回显。
      if (staged) ui.pendingUserMessage = null
    }
  }

  /**
   * 清掉本次已发出的引用：**只清自己那桶**。
   *
   * aux 清 `session.runtimeId` 的桶，主会话清 `conversationSelections` 单例；
   * 两者互不影响是 TZD-103 的硬约束（abort 时都不清，文本可由停止按钮恢复）。
   */
  function consumeSelections() {
    if (!pendingSelections.value.length) return
    if (auxScoped) clearAuxSelectionBucket(session.runtimeId)
    else conversationSelections.clear()
  }

  async function abort() {
    const restored = await session.abortAndRestore()
    if (restored) bridge.value?.setTextInput(restored)
  }

  return {
    attachments,
    onInputError,
    pendingComments,
    pendingSelections,
    codeComments,
    conversationSelections,
    /** 摘要列表的删除/批注编辑：aux 走桶操作，主会话仍走单例。 */
    selections: {
      remove: (id: string) => {
        if (auxScoped) removeAuxSelection(session.runtimeId, id)
        else conversationSelections.remove(id)
      },
    },
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
