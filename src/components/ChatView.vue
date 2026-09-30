<script setup lang="ts">
import type { WorkspaceSelection } from "@/api/piClient"
import { compactNumber, formatMessageTime } from "@/lib/format"
import { parseSendDelay, stepSendDelayWheel } from "@/lib/sendDelay"
import ContextBreakdown from "@/components/ContextBreakdown.vue"
import PiXLogo from "@/components/PiXLogo.vue"
import WorkspaceContext from "@/components/WorkspaceContext.vue"
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { NumberFieldInput, NumberFieldRoot } from "reka-ui"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageAction, MessageActions, MessageContent } from "@/components/ai-elements/message"
import { Loader } from "@/components/ai-elements/loader"
import { QueueItem, QueueItemContent, QueueList, QueueSection } from "@/components/ai-elements/queue"
import { PromptInput, PromptInputSubmit } from "@/components/ai-elements/prompt-input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { activeRuntimeId, sessionFor, uiFor } from "@/stores/conversations"
import { rpcRequest as requestForRuntime } from "@/api/piClient"
import { PromptInputHeader } from "@/components/ai-elements/prompt-input"
import ChatQueuePanel from "@/components/chat/ChatQueuePanel.vue"
import ChatDialogs from "@/components/chat/ChatDialogs.vue"
import { useTurnChanges } from "@/composables/useTurnChanges"
import { useChatContextBreakdown } from "@/composables/useChatContextBreakdown"
import { useComposerDraftSync } from "@/composables/useComposerDraftSync"
import { useConversationModel } from "@/composables/useConversationModel"
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextIcon,
  ContextTrigger,
} from "@/components/ai-elements/context"
import ConversationModelSelect from "@/components/ConversationModelSelect.vue"
import ConversationTimeline from "@/components/ConversationTimeline.vue"
import type { TimelineTurn } from "@/lib/conversationTimeline"
import { responseTurns, type AssistantTurn } from "@/lib/responseTurns"
import TurnChangesCard from "@/components/TurnChangesCard.vue"
import VirtualMessage from "@/components/VirtualMessage.vue"
import AssistantBlocks from "@/components/AssistantBlocks.vue"
import StatusBar from "@/components/StatusBar.vue"
import ExtensionDialog from "@/components/ExtensionDialog.vue"
import ComposerCompletion from "@/components/ComposerCompletion.vue"
import ComposerRichEditor from "@/components/ComposerRichEditor.vue"
import ComposerText from "@/components/ComposerText.vue"
import { withSessionReferences, desktopCommands } from "@/lib/completion"
import { baseName } from "@/lib/paths"
import { dataUrlToImage, isImageUrl } from "@/lib/attachments"
import { buildPromptWithCodeComments } from "@/lib/codeComments"
import { useCodeCommentsStore } from "@/stores/codeComments"
import { useSessionFork } from "@/composables/useSessionFork"
import { usePromptEdit, type PromptEditTextarea } from "@/composables/usePromptEdit"
import { useSessionDrop, type SessionDragPayload } from "@/composables/useSessionDrop"
import type { SplitDropZone } from "@/lib/splitDropZone"
import { runningBehavior } from "@/lib/runningBehavior"
import { registerShortcutHandler, setShortcutsSuppressed } from "@/lib/shortcuts"
import { copyWithToast } from "@/lib/clipboard"
import { isDesktop } from "@/api/transport"
import PromptInputBridge from "@/components/PromptInputBridge.vue"

import { useWorkspaceStore } from "@/stores/workspace"
import { Copy, GitBranch, MessageSquareQuote, PanelRight, X, Paperclip, Pencil, RefreshCw, Clock3 } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

import RightSidebar, { type SidebarTabItem, type SidebarTabType } from "@/components/RightSidebar.vue"

const localSidebarOpen = ref(false)
const sidebarOpen = computed({
  get: () => (props.sidebarTarget ? !!props.rightSidebarOpen : localSidebarOpen.value),
  set: value => {
    localSidebarOpen.value = value
    emit("update:rightSidebarOpen", value)
  },
})
const sidebarVisible = computed(
  () => sidebarOpen.value && (!props.sidebarTarget || activeRuntimeId.value === runtimeId),
)
const sidebarTabs = ref<SidebarTabItem[]>([])
const activeTabId = ref<number | null>(null)
let nextTabId = 1
const reviewFocus = ref<string | null>(null)
function addSidebarTab(type: SidebarTabType) {
  const id = nextTabId++
  sidebarTabs.value.push({ id, type })
  activeTabId.value = id
  sidebarOpen.value = true
}
function closeSidebarTab(id: number) {
  const index = sidebarTabs.value.findIndex(tab => tab.id === id)
  if (index < 0) return
  sidebarTabs.value.splice(index, 1)
  if (activeTabId.value === id)
    activeTabId.value = sidebarTabs.value[Math.min(index, sidebarTabs.value.length - 1)]?.id ?? null
}
function openReviewAt(path: string) {
  reviewFocus.value = path
  const existing = sidebarTabs.value.find(tab => tab.type === "review")
  if (existing) activeTabId.value = existing.id
  else addSidebarTab("review")
}
// Browser panel annotations are appended to the composer as a structured block.
function insertIntoComposer(text: string) {
  if (!bridge.value) return
  const existing = bridge.value.textInput || ""
  const separator = existing ? (existing.endsWith("\n") ? "\n" : "\n\n") : ""
  bridge.value.setTextInput(existing + separator + text)
}

const changeTotals = computed(() =>
  session.fileChanges.reduce(
    (sum, change) => ({
      added: sum.added + change.added,
      removed: sum.removed + change.removed,
      unknown: sum.unknown || change.unknownBefore,
    }),
    { added: 0, removed: 0, unknown: false },
  ),
)

const { t } = useI18n()

const props = defineProps<{
  project: string
  /** 所属会话 id；缺省跟随当前激活会话，分屏时由父层传入各窗格的会话。 */
  sessionId?: string
  splitPane?: boolean
  /** Render the session's tools outside the split tree, in the workspace shell. */
  sidebarTarget?: string
  rightSidebarOpen?: boolean
  ensureStarted: (selection?: WorkspaceSelection | null) => Promise<boolean>
  connecting: boolean
  selectingProject?: boolean
  connected: boolean
}>()

// 组件按会话 id 定向绑定（单屏由 App 以 :key 重挂载切换），分屏时每个窗格各自持有 id。
const runtimeId = props.sessionId ?? activeRuntimeId.value
const session = sessionFor(runtimeId)
const ui = uiFor(runtimeId)
const rpcRequest: typeof requestForRuntime = command => requestForRuntime(command, runtimeId)
const emit = defineEmits<{
  "update:rightSidebarOpen": [open: boolean]
  closePane: []
  selectProject: [path: string]
  openProject: []
  newSession: []
  splitDrop: [payload: SessionDragPayload, zone: Exclude<SplitDropZone, "center">]
}>()
const workspace = useWorkspaceStore()
const workspaceSelection = ref<WorkspaceSelection | null>(null)
const currentTitle = computed(
  () => workspace.histories[props.project]?.find(s => s.file === session.sessionFile)?.title,
)

const bridge = ref<InstanceType<typeof PromptInputBridge> | null>(null)
const { initialDraft } = useComposerDraftSync(session, () => props.project, bridge)
// Dragging a session row onto the view appends an @session reference to the composer.
const knownSessions = computed(() => Object.values(workspace.histories).flat())
const { sessionDragOver, splitZone, onSessionDragOver, onSessionDragLeave, onSessionDrop } = useSessionDrop(
  session,
  bridge,
  knownSessions,
  (payload, zone) => emit("splitDrop", payload, zone),
)

const conversation = ref<InstanceType<typeof Conversation> | null>(null)
async function navigateToQuestion(turn: TimelineTurn) {
  // Unmaterialized turns load their history pages first, then scroll.
  const id = turn.entryId ?? (await session.revealTimelineTurn(turn.id))
  if (id == null) return
  conversation.value?.stopScroll()
  conversation.value?.scrollToMessage(id)
}
let restoringHistory = false
async function onHistoryScroll(event: Event) {
  const viewport = event.target as HTMLElement
  // Prefetch before reaching the top; ignore initial positioning and duplicate events.
  if (
    viewport.scrollTop > 600 ||
    session.historyLoading ||
    props.connecting ||
    !session.hasOlderHistory ||
    session.olderHistoryLoading ||
    restoringHistory
  )
    return
  restoringHistory = true
  const file = session.sessionFile
  conversation.value?.stopScroll()
  const height = viewport.scrollHeight
  try {
    await session.loadOlderHistory()
    await nextTick()
    if (viewport.isConnected && file === session.sessionFile) viewport.scrollTop += viewport.scrollHeight - height
  } catch (error) {
    ui.pushToast(String(error), "error")
  } finally {
    restoringHistory = false
  }
}

const completion = ref<InstanceType<typeof ComposerCompletion> | null>(null)

// ---- 代码批注（项目文件页添加，随下一条消息发出） ----
const codeComments = useCodeCommentsStore()
const pendingComments = computed(() => (codeComments.project === props.project ? codeComments.comments : []))
function commentFile(path: string) {
  return baseName(path)
}

// ---- attachments (images) ----
const attachments = computed(() => bridge.value?.files ?? [])
const previewImage = ref<string | null>(null)

// ---- fork (restart from a previous prompt) ----
const { forkOpen, forkMessages, forkFromAnswer, doFork } = useSessionFork(session, ui, rpcRequest)

// Resend the edited question in this session, interrupting the current answer first.
const editTextarea = ref<PromptEditTextarea | null>(null)
const {
  editedPrompt,
  editedText,
  editBusy,
  lastUserPromptId,
  editBlocked,
  startEditPrompt,
  cancelEditedPrompt,
  resendEditedPrompt,
} = usePromptEdit({
  session,
  ui,
  workspace,
  editTextarea,
  project: () => props.project,
  connecting: () => props.connecting,
  connected: () => props.connected,
  knownSessions: () => knownSessions.value,
})

// ---- settings / export / copy ----
function blocksText(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter(b => b.type === "text")
    .map(b => b.text ?? "")
    .join("\n\n")
}

const renderedEntries = computed(() => {
  const streaming = session.isStreaming || !!session.partialBlocks
  const turns = responseTurns(session.entries, streaming)
  const partial = session.partialBlocks
  if (partial?.length) {
    const last = turns[turns.length - 1]
    if (last?.kind === "assistant") {
      turns[turns.length - 1] = { ...last, blocks: [...last.blocks, ...partial], complete: false }
    } else {
      // Nothing committed yet: render the stream in place under the reserved
      // turn id so completion keeps the same v-for key (no remount flash).
      turns.push({
        kind: "assistant",
        id: session.streamingTurnId ?? -1,
        lastIndex: session.entries.length,
        blocks: [...partial],
        process: [],
        summary: [],
        complete: false,
        durationMs: null,
        toolCallCount: 0,
      })
    }
  }
  return turns
})

/** Completed turns show only the trailing answer; the process collapses. */
function hasSummary(entry: AssistantTurn): boolean {
  return entry.complete && !!blocksText(entry.summary).trim()
}

const {
  changesForTurn,
  artifactsForTurn,
  checkpointForTurn,
  onTurnReverted,
  onTurnRevertedAll,
  turnArtifactsReverted,
} = useTurnChanges(session, ui)

// Process blocks render lazily on first expand: they are hidden anyway, and
// skipping them avoids a full markdown re-parse when a turn completes.
const openedProcesses = reactive(new Set<number>())
function onProcessToggle(id: number, event: Event) {
  if ((event.target as HTMLDetailsElement).open) openedProcesses.add(id)
}

function copyText(text: string) {
  return copyWithToast(ui, text, t("chat.toastCopied"))
}

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

// ---- context usage and session-wide weighted cache hit rate ----
const { contextUsage, cacheRateText, contextBreakdown, refreshContextBreakdown } = useChatContextBreakdown(
  session,
  rpcRequest,
)

const { modelKey, thinkingLabel, onThinkingChange } = useConversationModel(session, {
  connected: () => props.connected,
  onError: (e: unknown) => ui.pushToast(String(e), "error"),
})

const delayedSend = ref(false)
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
  if (workspace.gitBusy || props.connecting || editBusy.value) return
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
  if (!(await props.ensureStarted(session.entries.length ? null : workspaceSelection.value))) {
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
        if (commandName === "new") emit("newSession")
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
  const extensionCommand = commandName && session.commands.some(c => c.name === commandName && c.source === "extension")
  const expandedText = extensionCommand ? text : withSessionReferences(text, knownSessions.value)
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

// ---- keyboard shortcuts: executors for lib/shortcuts.ts actions ----

function lastAssistantTurn(): AssistantTurn | undefined {
  const turns = renderedEntries.value
  for (let index = turns.length - 1; index >= 0; index--) {
    const entry = turns[index]
    if (entry.kind === "assistant") return entry
  }
  return undefined
}

function historyViewport(): HTMLElement | null {
  const root = conversation.value as unknown as { $el?: HTMLElement } | null
  return root?.$el?.querySelector<HTMLElement>('[role="log"]') ?? null
}

function scrollHistory(direction: -1 | 1) {
  const viewport = historyViewport()
  if (!viewport) return
  conversation.value?.stopScroll()
  viewport.scrollTo({ top: direction < 0 ? 0 : viewport.scrollHeight })
}

function cycleSidebarTab(offset: number) {
  if (!sidebarTabs.value.length) return
  const index = sidebarTabs.value.findIndex(tab => tab.id === activeTabId.value)
  const next = sidebarTabs.value[(index + offset + sidebarTabs.value.length) % sidebarTabs.value.length]
  if (next) activeTabId.value = next.id
}

const offShortcutHandlers = [
  registerShortcutHandler("chat.stop", () => {
    if (session.isStreaming) void abort()
  }),
  registerShortcutHandler("chat.forkLast", () => {
    const entry = lastAssistantTurn()
    if (entry) void forkFromAnswer(entry.lastIndex)
  }),
  registerShortcutHandler("chat.copyLastAnswer", () => {
    const entry = lastAssistantTurn()
    if (entry) void copyText(blocksText(entry.summary.length ? entry.summary : entry.blocks))
  }),
  registerShortcutHandler("chat.scrollTop", () => scrollHistory(-1)),
  registerShortcutHandler("chat.scrollBottom", () => scrollHistory(1)),
  registerShortcutHandler("editor.attachFile", () => bridge.value?.openFileDialog?.()),
  registerShortcutHandler("editor.toggleDelayedSend", () => {
    delayedSend.value = !delayedSend.value
  }),
  registerShortcutHandler("sidebar.review", () => addSidebarTab("review")),
  registerShortcutHandler("sidebar.files", () => addSidebarTab("files")),
  registerShortcutHandler("sidebar.terminal", () => {
    if (isDesktop) addSidebarTab("terminal")
  }),
  registerShortcutHandler("sidebar.browser", () => addSidebarTab("browser")),
  registerShortcutHandler("sidebar.closeTab", () => {
    if (activeTabId.value !== null) closeSidebarTab(activeTabId.value)
  }),
  registerShortcutHandler("sidebar.nextTab", () => cycleSidebarTab(1)),
  registerShortcutHandler("sidebar.prevTab", () => cycleSidebarTab(-1)),
]

// Our own dialogs (fork / image preview / prompt edit) swallow shortcuts so
// their inputs keep every key; extension dialogs are gated via ui.activeDialog.
watch(
  () => Boolean(forkOpen.value || previewImage.value || editedPrompt.value),
  active => setShortcutsSuppressed("chat-dialogs", active),
  { immediate: true },
)

onBeforeUnmount(() => {
  offShortcutHandlers.forEach(off => off())
  setShortcutsSuppressed("chat-dialogs", false)
})
</script>

<template>
  <div
    class="chat-review-layout flex flex-1 min-w-0 min-h-0 relative overflow-hidden"
    :class="{ 'session-drop-active': sessionDragOver }"
    @dragover.capture="onSessionDragOver"
    @dragleave="onSessionDragLeave"
    @drop.capture="onSessionDrop"
  >
    <!-- 分屏投放热区预览：边缘高亮，中心保留 @引用 行为 -->
    <div v-if="splitZone" class="pointer-events-none absolute inset-0 z-50">
      <div
        v-if="splitZone === 'left'"
        class="border-primary bg-primary/15 absolute inset-y-0 left-0 w-1/4 rounded-r-md border-l-4"
      />
      <div
        v-else-if="splitZone === 'right'"
        class="border-primary bg-primary/15 absolute inset-y-0 right-0 w-1/4 rounded-l-md border-r-4"
      />
      <div
        v-else-if="splitZone === 'top'"
        class="border-primary bg-primary/15 absolute inset-x-0 top-0 h-1/4 rounded-b-md border-t-4"
      />
      <div
        v-else-if="splitZone === 'bottom'"
        class="border-primary bg-primary/15 absolute inset-x-0 bottom-0 h-1/4 rounded-t-md border-b-4"
      />
    </div>
    <div class="chat-workspace min-w-0 flex flex-1 flex-col min-h-0 h-full">
      <header
        class="workspace-header flex items-center justify-between gap-4 min-h-12 py-1.5 pl-[var(--workspace-header-left,20px)] pr-5 shrink-0 border-b border-border max-[900px]:flex-wrap max-[900px]:gap-1.5"
      >
        <div class="min-w-0">
          <h1 class="max-w-[42vw] truncate text-sm font-medium leading-[1.8]">
            {{ currentTitle || session.entries.find(e => e.kind === "user")?.text || t("chat.newSession") }}
          </h1>
        </div>
        <div class="header-actions flex items-center gap-1 shrink-0 max-[900px]:flex-wrap max-[640px]:gap-0">
          <Button
            v-if="!sidebarTarget && !sidebarOpen"
            type="button"
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            :title="t('sidebarTabs.toggle')"
            :aria-label="t('sidebarTabs.toggle')"
            :aria-expanded="sidebarOpen"
            @click="sidebarOpen = !sidebarOpen"
          >
            <PanelRight />
          </Button>
          <Button
            v-if="splitPane"
            type="button"
            variant="ghost"
            size="icon-sm"
            :title="t('split.closePane')"
            :aria-label="t('split.closePane')"
            @mousedown.stop
            @click.stop="emit('closePane')"
          >
            <X />
          </Button>
        </div>
      </header>

      <!-- conversation: loading (session start / history load) is kept silent;
         the area renders immediately and history appears once ready -->
      <Conversation
        ref="conversation"
        :key="session.sessionFile ?? project"
        initial="instant"
        resize="instant"
        class="min-h-0 flex-1"
        @scroll="onHistoryScroll"
      >
        <ConversationContent
          class="conversation-column has-[[data-slot=conversation-empty-state]]:justify-center mx-auto w-full max-w-3xl gap-5 px-6 py-6 min-h-full max-[640px]:pl-4 max-[640px]:pr-4"
          :class="{ 'pl-[42px] max-[640px]:pl-[42px]': session.entries.some(entry => entry.kind === 'user') }"
        >
          <div
            v-if="session.hasOlderHistory"
            class="text-muted-foreground flex h-8 items-center justify-center gap-2 text-sm"
            role="status"
          >
            <template v-if="session.olderHistoryLoading"><Loader :size="16" /> {{ t("chat.historyLoading") }}</template>
          </div>
          <ConversationEmptyState
            class="chat-empty flex-1 min-h-60"
            v-if="session.entries.length === 0 && !session.historyLoading && (!connecting || selectingProject)"
            :title="t('workspace.emptyTitle', { project: workspace.projectName(project) })"
          >
            <template #icon>
              <PiXLogo style="width: 120px; height: 56px" />
            </template>
          </ConversationEmptyState>

          <VirtualMessage
            v-for="(entry, entryIndex) in renderedEntries"
            :key="entry.id"
            :data-message-id="entry.id"
            :enabled="renderedEntries.length > 40"
            :pinned="entryIndex >= renderedEntries.length - 4"
            :live="entry.kind === 'assistant' && !entry.complete"
            v-slot="{ animate }"
          >
            <!-- compaction marker: a divider at the position history collapsed -->
            <details v-if="entry.kind === 'compaction'" class="group">
              <summary
                class="flex cursor-pointer list-none items-center gap-3 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"
              >
                <span class="h-px flex-1 bg-border"></span>
                <span class="flex items-center gap-1.5">
                  {{ t("chat.compacted") }}
                  <template v-if="entry.tokensBefore">
                    <span aria-hidden="true">&middot;</span>
                    {{ compactNumber(entry.tokensBefore)
                    }}<template v-if="entry.tokensAfter"> &rarr; {{ compactNumber(entry.tokensAfter) }}</template>
                  </template>
                </span>
                <span class="h-px flex-1 bg-border"></span>
              </summary>
              <p
                class="mt-2 whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]"
              >
                {{ entry.summary }}
              </p>
            </details>
            <!-- context edit: light marker that an earlier message was edited
                 or omitted for future model context; history stays unchanged -->
            <div
              v-else-if="entry.kind === 'context_edit'"
              class="flex items-center gap-3 text-xs text-muted-foreground"
              role="status"
            >
              <span class="h-px flex-1 bg-border"></span>
              <span class="flex items-center gap-1.5">
                {{ entry.replaced ? t("chat.contextReplaced") : t("chat.contextEdited") }}
              </span>
              <span class="h-px flex-1 bg-border"></span>
            </div>
            <!-- unknown extension entry: low-key placeholder so custom session
                 entries neither break nor clutter the conversation -->
            <div
              v-else-if="entry.kind === 'custom'"
              class="flex items-center gap-3 text-xs text-muted-foreground/70"
              role="status"
            >
              <span class="h-px flex-1 bg-border"></span>
              <span>{{ t("chat.customEntry", { type: entry.customType }) }}</span>
              <span class="h-px flex-1 bg-border"></span>
            </div>
            <template v-else>
              <div
                v-if="entry.kind === 'user' && entry.modelChange"
                class="text-muted-foreground my-3 text-center text-xs"
                role="status"
              >
                {{ t("chat.modelChanged", entry.modelChange) }}
              </div>
              <Message :data-message-id="entry.id" :from="entry.kind === 'user' ? 'user' : 'assistant'">
                <div class="flex min-w-0 flex-col" :class="{ 'items-end': entry.kind === 'user' }">
                  <MessageContent>
                    <div v-if="entry.kind === 'user'" class="text-sm">
                      <div v-if="editedPrompt?.id === entry.id" class="w-[min(36rem,75vw)] space-y-2">
                        <Textarea
                          ref="editTextarea"
                          v-model="editedText"
                          :disabled="editBusy"
                          :aria-label="t('chat.editPrompt')"
                          class="min-h-32 max-h-80 resize-y"
                          @keydown.esc.stop="cancelEditedPrompt"
                          @keydown.ctrl.enter.prevent="resendEditedPrompt"
                        />
                        <p v-if="entry.images?.length" class="text-xs text-muted-foreground">
                          {{ t("chat.editKeepImages") }}
                        </p>
                        <div class="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            :disabled="editBusy"
                            @click="cancelEditedPrompt"
                            >{{ t("chat.editCancel") }}</Button
                          >
                          <Button
                            type="button"
                            size="sm"
                            :disabled="editBlocked || (!editedText.trim() && !entry.images?.length)"
                            @click="resendEditedPrompt"
                            >{{ t("chat.editResend") }}</Button
                          >
                        </div>
                      </div>
                      <ComposerText v-else :text="entry.text" />
                      <div v-if="entry.images?.length" class="mt-1.5 flex flex-wrap gap-1.5">
                        <img
                          v-for="(im, i) in entry.images"
                          :key="i"
                          :src="im.url"
                          class="max-h-40 max-w-xs rounded-md border object-contain"
                        />
                      </div>
                    </div>
                    <div v-else class="min-w-0 space-y-3">
                      <!-- The answer keeps one stable render path: while streaming it
                       is the flat block list, on completion only the trailing
                       summary stays visible (same keys via keyOffset), so the
                       markdown below never remounts and re-flashes. -->
                      <details
                        v-if="entry.complete && entry.process.length && blocksText(entry.summary).trim()"
                        class="response-process border-b border-border pb-3"
                        @toggle="onProcessToggle(entry.id, $event)"
                      >
                        <summary class="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          {{
                            entry.durationMs == null
                              ? t("chat.durationUnknown")
                              : t("chat.executionDuration", { seconds: (entry.durationMs / 1000).toFixed(1) })
                          }}
                          <template v-if="entry.toolCallCount > 0">
                            <span class="mx-1.5" aria-hidden="true">·</span>
                            {{ t("chat.toolCallCount", { count: entry.toolCallCount }) }}
                          </template>
                        </summary>
                        <AssistantBlocks
                          v-if="openedProcesses.has(entry.id)"
                          class="mt-3 border-l pl-3"
                          :blocks="entry.process"
                          :runs="session.runs"
                          :animate="false"
                          @open-review="openReviewAt"
                        />
                      </details>
                      <AssistantBlocks
                        :animate="animate"
                        :blocks="hasSummary(entry) ? entry.summary : entry.blocks"
                        :key-offset="hasSummary(entry) ? entry.blocks.length - entry.summary.length : 0"
                        :runs="session.runs"
                        @open-review="openReviewAt"
                      />
                      <TurnChangesCard
                        v-if="entry.complete && changesForTurn(entry).length"
                        :files="changesForTurn(entry)"
                        :artifacts="artifactsForTurn(entry)"
                        :was-reverted="turnArtifactsReverted(entry)"
                        :project="session.cwd || project"
                        :checkpoint="checkpointForTurn(entry)"
                        @open-review="openReviewAt"
                        @reverted="onTurnReverted"
                        @reverted-all="onTurnRevertedAll(entry)"
                      />
                    </div>
                  </MessageContent>
                  <MessageActions
                    v-if="entry.kind === 'assistant' && entry.complete"
                    class="invisible mt-1 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 focus-within:visible focus-within:opacity-100"
                  >
                    <MessageAction :tooltip="t('chat.fork')" @click="forkFromAnswer(entry.lastIndex)">
                      <GitBranch />
                    </MessageAction>
                    <MessageAction
                      :tooltip="t('chat.copyReply')"
                      @click="copyText(blocksText(entry.summary.length ? entry.summary : entry.blocks))"
                    >
                      <Copy />
                    </MessageAction>
                    <span v-if="entry.timestamp" class="ml-1 self-center text-xs text-muted-foreground">
                      {{ formatMessageTime(entry.timestamp) }}
                    </span>
                  </MessageActions>
                  <MessageActions
                    v-else-if="entry.kind === 'user'"
                    class="invisible mt-1 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 focus-within:visible focus-within:opacity-100"
                  >
                    <MessageAction
                      v-if="entry.id === lastUserPromptId && editedPrompt?.id !== entry.id"
                      :tooltip="t('chat.editPrompt')"
                      :disabled="editBlocked"
                      @click="startEditPrompt(entry)"
                    >
                      <Pencil />
                    </MessageAction>
                    <MessageAction :tooltip="t('chat.copyPrompt')" @click="copyText(entry.text)">
                      <Copy />
                    </MessageAction>
                    <span v-if="entry.timestamp" class="ml-1 self-center text-xs text-muted-foreground">
                      {{ formatMessageTime(entry.timestamp) }}
                    </span>
                  </MessageActions>
                </div>
              </Message>
            </template>
          </VirtualMessage>

          <!-- waiting indicator before any content arrives -->
          <div
            v-if="session.isStreaming && !session.partialBlocks"
            class="text-muted-foreground flex items-center gap-2 text-sm"
          >
            <Loader />
            <span>{{ t("chat.thinking") }}</span>
          </div>

          <!-- Keep retry errors next to the conversation, not in the header. -->
          <Message v-if="session.retryInfo" from="assistant" role="status" aria-live="polite">
            <MessageContent class="w-full">
              <div
                class="flex w-full items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 text-amber-800 shadow-sm dark:border-amber-400/20 dark:bg-amber-400/[0.08] dark:text-amber-200"
              >
                <span
                  class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                >
                  <RefreshCw :size="14" class="animate-spin" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p class="text-sm font-medium">{{ t("chat.retrying") }}</p>
                    <span
                      class="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                    >
                      {{
                        t("chat.retryAttempt", {
                          attempt: session.retryInfo.attempt,
                          maxAttempts: session.retryInfo.maxAttempts,
                        })
                      }}
                    </span>
                  </div>
                  <p
                    class="mt-1 whitespace-pre-wrap text-xs leading-5 text-amber-700/85 [overflow-wrap:anywhere] dark:text-amber-200/80"
                  >
                    {{ session.retryInfo.errorMessage || t("chat.retryUnknownError") }}
                  </p>
                </div>
              </div>
            </MessageContent>
          </Message>

          <!-- pending steering / follow-up (pi-owned queue) -->
          <QueueSection v-if="session.steering.length + session.followUp.length > 0" class="mt-2">
            <QueueList>
              <QueueItem v-for="(s, i) in session.steering" :key="`steer-${i}`">
                <QueueItemContent>{{ t("chat.pendingSteering") }} · {{ s }}</QueueItemContent>
              </QueueItem>
              <QueueItem v-for="(s, i) in session.followUp" :key="`follow-up-${i}`">
                <QueueItemContent>{{ t("chat.pendingFollowUp") }} · {{ s }}</QueueItemContent>
              </QueueItem>
            </QueueList>
          </QueueSection>

          <!-- compaction progress: a divider inside the conversation -->
          <div
            v-if="session.isCompacting"
            class="mt-2 flex items-center gap-3 text-xs text-muted-foreground"
            role="status"
          >
            <span class="h-px flex-1 bg-border"></span>
            <span class="flex items-center gap-1.5">
              <Loader :size="12" />
              {{ t("chat.compacting") }}
            </span>
            <span class="h-px flex-1 bg-border"></span>
          </div>
        </ConversationContent>
        <template #overlay>
          <ConversationTimeline
            :turns="session.timelineTurns"
            :partial="session.partialBlocks"
            @navigate="navigateToQuestion"
          />
          <ConversationScrollButton />
        </template>
      </Conversation>

      <!-- extension widget -->
      <div v-if="ui.widget" class="border-border bg-muted/40 border-t px-4 py-2 font-mono text-xs whitespace-pre-wrap">
        {{ ui.widget.lines.join("\n") }}
      </div>

      <!-- composer -->
      <div class="composer-dock mx-auto w-full max-w-3xl px-6 pt-3 shrink-0 pb-3 max-[900px]:pl-4 max-[900px]:pr-4">
        <WorkspaceContext
          v-model="workspaceSelection"
          :disabled="workspace.gitBusy || connecting"
          v-if="
            !session.promptQueue.length &&
            !session.entries.length &&
            !session.isStreaming &&
            (!connecting || selectingProject || workspace.gitBusy) &&
            !session.historyLoading
          "
          :project="project"
          @select-project="emit('selectProject', $event)"
          @open-project="emit('openProject')"
        />
        <p v-if="workspace.gitBusy" role="status" class="px-2 py-1 text-xs text-muted-foreground">
          {{ t("workspace.preparing") }}
        </p>
        <ChatQueuePanel
          v-if="session.promptQueue.length"
          :session="session"
          :bridge="bridge"
          :git-busy="workspace.gitBusy"
          :connecting="connecting"
          :connected="connected"
          :edit-busy="editBusy"
        />
        <PromptInput
          :group-class="[
            'relative rounded-[22px] bg-card p-2 shadow-[var(--composer-shadow)]',
            sessionDragOver && 'outline-2 outline-dashed outline-primary outline-offset-[3px]',
          ]"
          :initial-input="initialDraft"
          @submit="onSubmit"
        >
          <PromptInputBridge ref="bridge" />
          <PromptInputHeader v-if="attachments.length">
            <!-- pending image attachments -->
            <div class="flex flex-wrap gap-2 px-1">
              <div
                v-for="f in attachments"
                :key="f.id"
                class="border-border bg-muted relative size-16 overflow-hidden rounded-md border"
              >
                <img
                  v-if="isImageUrl(f.url)"
                  :src="f.url"
                  class="size-full cursor-zoom-in object-cover"
                  alt="attachment"
                  :title="t('chat.previewImage')"
                  @click="previewImage = f.url ?? null"
                />
                <span
                  v-else
                  class="text-muted-foreground flex h-full items-center justify-center p-1 text-[10px] break-all"
                >
                  {{ f.filename ?? "file" }}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  class="bg-background/80 absolute top-0.5 right-0.5 size-4 rounded-full text-[10px] leading-none"
                  :title="t('chat.removeAttachment')"
                  @click="bridge?.removeFile?.(f.id)"
                >
                  ×
                </Button>
              </div>
            </div>
          </PromptInputHeader>
          <PromptInputHeader v-if="pendingComments.length">
            <!-- 待发送的代码批注，随下一条消息一并发给 agent -->
            <div class="flex flex-wrap gap-1.5 px-1">
              <div
                v-for="c in pendingComments"
                :key="c.id"
                class="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 py-1 pr-1 pl-2 text-xs"
              >
                <MessageSquareQuote class="size-3.5 shrink-0 text-muted-foreground" />
                <span class="shrink-0 font-mono"
                  >{{ commentFile(c.path) }}:{{ c.startLine
                  }}<template v-if="c.endLine !== c.startLine">-{{ c.endLine }}</template></span
                >
                <span class="min-w-0 truncate text-muted-foreground" :title="c.comment">{{ c.comment }}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  class="size-4 shrink-0 rounded-full text-[10px] leading-none"
                  :title="t('projectFiles.annotateRemove')"
                  :aria-label="t('projectFiles.annotateRemove')"
                  @click="codeComments.remove(c.id)"
                  >×</Button
                >
              </div>
            </div>
          </PromptInputHeader>
          <ComposerCompletion
            ref="completion"
            :session-id="runtimeId"
            :project="project"
            :connected="connected"
            :ensure-started="ensureStarted"
          />
          <ComposerRichEditor
            @input="completion?.onEditorEvent($event)"
            @click="completion?.onEditorEvent($event)"
            @keyup="completion?.onEditorEvent($event)"
            @select="completion?.onEditorEvent($event)"
            @focus="completion?.onEditorEvent($event)"
            @blur="completion?.onEditorEvent($event)"
            @compositionstart="completion?.onEditorEvent($event)"
            @compositionend="completion?.onEditorEvent($event)"
            @keydown.capture="completion?.onKeydown($event)"
            :placeholder="t('chat.inputPlaceholder')"
            :disabled="editBusy || workspace.gitBusy || (connecting && !selectingProject && !completion?.initiating)"
            class="min-h-14"
          />
          <div
            data-align="block-end"
            class="composer-controls flex items-center justify-between w-full pt-0 pr-[5px] pb-[5px] pl-[5px] gap-1.5"
          >
            <div class="composer-options flex items-center gap-1 min-w-0 flex-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="text-muted-foreground size-8"
                :title="t('chat.attachImage')"
                :aria-label="t('chat.attachImage')"
                @click="bridge?.openFileDialog?.()"
              >
                <Paperclip class="size-4.5" />
              </Button>

              <ConversationModelSelect
                trigger-class="h-8 w-auto min-w-0 max-w-47.5 border-0 text-xs shadow-none max-[900px]:max-w-35 overflow-hidden [&>[data-slot=select-value]]:min-w-0 [&>[data-slot=select-value]]:overflow-hidden"
                v-model="modelKey"
                :models="session.models"
                :disabled="!connected && session.models.length === 0"
                :show-provider="false"
                open-above
              />

              <Select
                :model-value="session.thinkingLevel"
                :disabled="!connected && session.models.length === 0"
                @update:model-value="onThinkingChange"
              >
                <SelectTrigger
                  class="h-8 w-auto min-w-0 max-w-47.5 border-0 text-xs shadow-none max-[900px]:max-w-35 overflow-hidden [&>[data-slot=select-value]]:min-w-0 [&>[data-slot=select-value]]:overflow-hidden"
                >
                  <SelectValue>{{ thinkingLabel(session.thinkingLevel) }}</SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" side="top" align="start" :side-offset="0" :side-flip="false">
                  <SelectItem v-for="lv in session.availableThinking" :key="lv" :value="lv" class="text-xs">
                    {{ thinkingLabel(lv) }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="ml-auto flex max-w-full items-center justify-end gap-1">
              <div
                v-if="delayedSend"
                class="flex h-8 items-center rounded-md border border-border bg-background px-1 text-sm font-mono tabular-nums text-foreground focus-within:ring-1 focus-within:ring-ring"
                role="group"
                :aria-label="t('chat.sendDelay')"
              >
                <NumberFieldRoot
                  v-model="sendDelayMinutes"
                  :min="0"
                  :max="525600"
                  disable-wheel-change
                  :format-options="{ minimumIntegerDigits: 2, useGrouping: false }"
                  @wheel="onSendDelayWheel($event, 'minutes')"
                >
                  <NumberFieldInput
                    class="min-w-0 bg-transparent text-right outline-none"
                    :style="{ width: `${Math.max(2, String(sendDelayMinutes ?? 0).length) + 0.5}ch` }"
                    :aria-label="t('chat.sendDelayMinutes')"
                  />
                </NumberFieldRoot>
                <span aria-hidden="true">:</span>
                <NumberFieldRoot
                  v-model="sendDelaySeconds"
                  :min="0"
                  :max="59"
                  disable-wheel-change
                  :format-options="{ minimumIntegerDigits: 2, useGrouping: false }"
                  @wheel="onSendDelayWheel($event, 'seconds')"
                >
                  <NumberFieldInput
                    class="w-[2.5ch] bg-transparent text-left outline-none"
                    :aria-label="t('chat.sendDelaySeconds')"
                  />
                </NumberFieldRoot>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="size-8 shrink-0 text-muted-foreground"
                :class="{ 'bg-muted text-foreground': delayedSend }"
                :title="t('chat.delayedSendHint')"
                :aria-label="t('chat.delayedSend')"
                :aria-pressed="delayedSend"
                @click="delayedSend = !delayedSend"
              >
                <Clock3 class="size-4" />
              </Button>
              <Context
                v-if="contextUsage"
                :used-tokens="contextUsage.tokens"
                :max-tokens="contextUsage.contextWindow"
                @update:open="(open: boolean) => open && refreshContextBreakdown()"
              >
                <ContextTrigger>
                  <Button type="button" variant="ghost" class="h-8 px-2 text-xs">
                    <ContextIcon />
                  </Button>
                </ContextTrigger>
                <ContextContent>
                  <ContextContentHeader />
                  <ContextContentBody class="space-y-2">
                    <ContextBreakdown v-if="contextBreakdown?.length" :parts="contextBreakdown" />
                    <div class="flex items-center justify-between gap-3 text-xs">
                      <span class="text-muted-foreground">{{ t("chat.averageCacheRate") }}</span>
                      <span class="font-mono">{{ cacheRateText }}</span>
                    </div>
                  </ContextContentBody>
                </ContextContent>
              </Context>
              <PromptInputSubmit
                :status="showStopButton ? 'streaming' : undefined"
                :type="showStopButton ? 'button' : 'submit'"
                :title="showStopButton ? t('chat.stop') : delayedSend ? t('chat.delayedSend') : undefined"
                :aria-label="
                  showStopButton ? t('chat.stop') : delayedSend ? t('chat.delayedSend') : t('chat.sendMessage')
                "
                :disabled="editBusy || workspace.gitBusy || connecting"
                @click="showStopButton && abort()"
              />
            </div>
          </div>
        </PromptInput>
        <StatusBar :session-id="runtimeId" />
      </div>

      <ChatDialogs
        v-model:fork-open="forkOpen"
        :fork-messages="forkMessages"
        @fork="doFork"
        v-model:preview-image="previewImage"
      />

      <ExtensionDialog :session-id="runtimeId" />
    </div>
    <Teleport :to="sidebarTarget || 'body'" :disabled="!sidebarTarget" defer>
      <RightSidebar
        v-show="sidebarVisible"
        :open="sidebarVisible"
        :tabs="sidebarTabs"
        :active-id="activeTabId"
        :changes="session.fileChanges"
        :project="session.cwd || project"
        :focus="reviewFocus"
        :totals="changeTotals"
        :checkpoints="session.turnCheckpointRecords"
        @update:active-id="activeTabId = $event"
        @add-tab="addSidebarTab"
        @close-tab="closeSidebarTab"
        @close="sidebarOpen = false"
        @send-to-chat="insertIntoComposer"
      />
    </Teleport>
  </div>
</template>
