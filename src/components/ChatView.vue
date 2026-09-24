<script setup lang="ts">
import { ScrollArea } from "@/components/ui/scroll-area"
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ai-elements/message"
import { Loader } from "@/components/ai-elements/loader"
import {
  QueueItem,
  QueueItemContent,
  QueueList,
  QueueSection,
} from "@/components/ai-elements/queue"
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { activeRuntimeId, sessionFor, uiFor } from "@/stores/conversations"
import type { ThinkingLevel } from "@/api/protocol"
import type { LanguageModelUsage } from "ai"
import { rpcRequest as requestForRuntime } from "@/api/piClient"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  PromptInputHeader,
} from "@/components/ai-elements/prompt-input"
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextIcon,
  ContextInputUsage,
  ContextOutputUsage,
  ContextTrigger,
} from "@/components/ai-elements/context"
import ConversationModelSelect from "@/components/ConversationModelSelect.vue"
import ConversationTimeline from "@/components/ConversationTimeline.vue"
import type { TimelineTurn } from "@/lib/conversationTimeline"
import { responseTurns, type AssistantTurn } from "@/lib/responseTurns"
import AssistantBlocks from "@/components/AssistantBlocks.vue"
import StatusBar from "@/components/StatusBar.vue"
import ExtensionDialog from "@/components/ExtensionDialog.vue"
import ComposerCompletion from "@/components/ComposerCompletion.vue"
import { withFileReferences, desktopCommands } from "@/lib/completion"
import { runningBehavior } from "@/lib/runningBehavior"
import PromptInputBridge from "@/components/PromptInputBridge.vue"
import SessionTree from "@/components/SessionTree.vue"
import { openPath } from "@/api/piClient"
import { isDesktop } from "@/api/transport"
import WorkspaceContext from "@/components/WorkspaceContext.vue"
import { useWorkspaceStore } from "@/stores/workspace"
import { Copy, GitBranch, SquareTerminal, GripVertical, Pencil, Trash2 } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import TerminalPanel from "@/components/terminal/TerminalPanel.vue"

const runtimeId = activeRuntimeId.value
const session = sessionFor(runtimeId)
const ui = uiFor(runtimeId)
const rpcRequest: typeof requestForRuntime = command => requestForRuntime(command, runtimeId)
const { t, te } = useI18n()

const props = defineProps<{ project: string; ensureStarted: () => Promise<boolean>; connecting: boolean; connected: boolean }>()
const emit = defineEmits<{ selectProject: [path: string]; openProject: []; newSession: [] }>()
const workspace = useWorkspaceStore()
const currentTitle = computed(() => workspace.histories[props.project]?.find(s => s.file === session.sessionFile)?.title)


const bridge = ref<InstanceType<typeof PromptInputBridge> | null>(null)

const conversation = ref<InstanceType<typeof Conversation> | null>(null)
async function navigateToQuestion(turn: TimelineTurn) {
  // Unmaterialized turns load their history pages first, then scroll.
  const id = turn.entryId ?? await session.revealTimelineTurn(turn.id)
  if (id == null) return
  conversation.value?.stopScroll()
  conversation.value?.scrollToMessage(id)
}
let restoringHistory = false
async function onHistoryScroll(event: Event) {
  const viewport = event.target as HTMLElement
  // Prefetch before reaching the top; ignore initial positioning and duplicate events.
  if (viewport.scrollTop > 600 || session.historyLoading || props.connecting ||
      !session.hasOlderHistory || session.olderHistoryLoading || restoringHistory) return
  restoringHistory = true
  const file = session.sessionFile
  conversation.value?.stopScroll()
  const height = viewport.scrollHeight
  try {
    await session.loadOlderHistory()
    await nextTick()
    if (viewport.isConnected && file === session.sessionFile)
      viewport.scrollTop += viewport.scrollHeight - height
  } catch (error) {
    ui.pushToast(String(error), "error")
  } finally { restoringHistory = false }
}

const completion = ref<InstanceType<typeof ComposerCompletion> | null>(null)

// ---- attachments (images) ----
const attachments = computed(() => bridge.value?.files ?? [])
const previewImage = ref<string | null>(null)

function dataUrlToImage(d: string): { data: string; mimeType: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(d)
  return m ? { data: m[2]!, mimeType: m[1]! } : null
}

function isImageUrl(url?: string): boolean {
  return (
    !!url &&
    (url.startsWith("data:image/") ||
      /^https?:\/\/.*\.(png|jpe?g|gif|webp)/i.test(url))
  )
}

// ---- fork (restart from a previous prompt) ----
const forkOpen = ref(false)
const forkMessages = ref<{ entryId: string; text: string }[]>([])
const treeOpen = ref(false)

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
  treeOpen.value = false
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

// ---- settings / export / copy ----
const exporting = ref(false)

async function exportSession() {
  exporting.value = true
  try {
    const res = await rpcRequest<{ path?: string }>({ type: "export_html" })
    if (!res.success || !res.data?.path)
      throw new Error(res.error || "export failed")
    await openPath(res.data.path)
    ui.pushToast(t("chat.toastExported"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    exporting.value = false
  }
}

function blocksText(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
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
    }
    else {
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

// Process blocks render lazily on first expand: they are hidden anyway, and
// skipping them avoids a full markdown re-parse when a turn completes.
const openedProcesses = reactive(new Set<number>())
function onProcessToggle(id: number, event: Event) {
  if ((event.target as HTMLDetailsElement).open) openedProcesses.add(id)
}

function formatMessageTime(ts?: number): string {
  if (!ts) return ""
  const d = new Date(ts)
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${time}`
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ui.pushToast(t("chat.toastCopied"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}

// Sidebar session menu (tree / export) requests forwarded via the ui store.
watch(() => ui.sessionAction, (action) => {
  if (!action) return
  if (action.action === "tree") treeOpen.value = true
  else void exportSession()
})

// extensions can push text into the editor (set_editor_text))
watch(
  () => ui.pendingEditorText,
  (text) => {
    if (text !== null) {
      bridge.value?.setTextInput(text)
      ui.pendingEditorText = null
    }
  },
)

// ---- built-in terminal (desktop only) ----
const terminalOpen = ref(false)
const terminalPanel = ref<InstanceType<typeof TerminalPanel> | null>(null)
function toggleTerminal() {
  terminalOpen.value = !terminalOpen.value
  if (terminalOpen.value && !terminalPanel.value?.hasTerminals()) {
    terminalPanel.value?.openTerminal()
  }
}

// ---- context usage (ai-elements Context) ----
const contextUsage = computed(() => session.stats?.contextUsage ?? null)
const contextTokenUsage = computed<LanguageModelUsage | undefined>(() => {
  const u = session.lastUsage
  if (!u) return undefined
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    totalTokens: u.totalTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
  }
})

const modelKey = computed({
  get: () => {
    if (session.desiredModelKey) return session.desiredModelKey
    if (!props.connected && session.offlineDefaultModelKey) return session.offlineDefaultModelKey
    const m = session.currentModel
    return m ? `${m.provider}/${m.id}` : ""
  },
  set: (key: string) => {
    const [provider, ...rest] = key.split("/")
    // pi starts lazily: queue the choice until init() applies it.
    if (!props.connected) {
      session.setDesiredModel(key)
      return
    }
    session.setModel(provider, rest.join("/"))
      .catch(e => ui.pushToast(String(e), "error"))
  },
})

const draggedPrompt = ref<number | null>(null)

function startQueueDrag(event: DragEvent, id: number) {
  draggedPrompt.value = id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", String(id))
  }
}

function dropQueuedPrompt(targetId: number) {
  if (draggedPrompt.value !== null) session.moveQueuedPrompt(draggedPrompt.value, targetId)
  draggedPrompt.value = null
}

async function editQueuedPrompt(id: number) {
  const item = session.removeQueuedPrompt(id)
  if (!item || !bridge.value) return
  // Keep any draft already being composed rather than silently discarding it.
  const draft = bridge.value.textInput
  bridge.value.setTextInput([draft, item.text].filter(Boolean).join("\n\n"))
  for (const [index, image] of (item.images ?? []).entries()) {
    const bytes = Uint8Array.from(atob(image.data), char => char.charCodeAt(0))
    bridge.value.addFiles([new File([bytes], `queued-image-${index + 1}`, { type: image.mimeType })])
  }
  await nextTick()
  document.querySelector<HTMLTextAreaElement>(".composer-dock textarea")?.focus()
}

async function onSubmit(message: {
  text?: string
  files?: { url?: string }[]
}) {
  if (workspace.gitBusy || props.connecting) return
  const text = (message.text ?? "").trim()
  const images = (message.files ?? [])
    .map((f) => f.url)
    .filter((u): u is string => isImageUrl(u))
    .map((u) => dataUrlToImage(u))
    .filter((im): im is { data: string; mimeType: string } => im !== null)
  if (!text && !images.length) return
  if (!await props.ensureStarted()) {
    bridge.value?.setTextInput(text)
    throw new Error(t("completion.startFailed"))
  }
  const commandName = /^\/([^\s/]+)/.exec(text)?.[1]
  if (commandName) {
    await session.refreshCommands()
    if (!session.commands.some(c => c.name === commandName) && desktopCommands.some(name => name === commandName)) {
      const args = text.slice(commandName.length + 1).trim()
      try {
        if (images.length || (args && commandName !== 'compact')) throw new Error(t('completion.invalidArguments'))
        if (session.isStreaming && commandName === 'compact') await abort()
        if (commandName === 'new') emit('newSession')
        else if (commandName === 'compact') await session.compact(args || undefined)
        else {
          const result = await rpcRequest<{ path?: string }>({ type: 'export_html' })
          if (!result.success || !result.data?.path) throw new Error(result.error ?? 'Export failed')
          await openPath(result.data.path)
        }
      } catch (error) {
        ui.pushToast(String(error), 'error')
        throw error
      }
      return
    }
    if (!session.commands.some(c => c.name === commandName)) {
      const error = t('completion.unsupported', { name: commandName })
      ui.pushToast(error, 'error')
      throw new Error(error)
    }
  }
  const extensionCommand = commandName && session.commands.some(c => c.name === commandName && c.source === "extension")
  await session.send(text, images.length ? images : undefined, extensionCommand ? text : withFileReferences(text, workspace.projectFolders(props.project).filter(path => path !== props.project)), runningBehavior.value)
}

function thinkingLabel(lv: string) {
  const key = `chat.thinkingLevels.${lv}`
  return te(key) ? t(key) : lv
}

function onThinkingChange(v: unknown) {
  if (typeof v !== "string") return
  // pi starts lazily: queue the choice until init() applies it.
  if (!props.connected) {
    session.setDesiredThinkingLevel(v as ThinkingLevel)
    return
  }
  session.setThinkingLevel(v as ThinkingLevel)
    .catch(e => ui.pushToast(String(e), "error"))
}

async function abort() {
  const restored = await session.abortAndRestore()
  if (restored) bridge.value?.setTextInput(restored)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing) return
  if (ui.activeDialog) return // dialog handles its own cancel
  // Let our own dialogs (fork / tree / image preview) handle Escape first.
  if (forkOpen.value || treeOpen.value || previewImage.value) return
  if (session.isStreaming) {
    e.preventDefault()
    void abort()
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div class="chat-workspace">
    <header class="workspace-header">
      <div class="min-w-0">
        <h1 class="truncate text-sm font-medium">
          {{ currentTitle || session.entries.find((e) => e.kind === "user")?.text || t("chat.newSession") }}
        </h1>
        <p class="text-muted-foreground truncate text-xs">
          {{ project.split(/[\\/]/).filter(Boolean).pop() }}
          <span class="mx-1">/</span> {{ t("common.localWorkspace") }}
        </p>
      </div>
      <div class="header-actions">
        <span v-if="session.retryInfo" class="text-xs text-amber-500">{{
          session.retryInfo
        }}</span>
        <span v-if="session.isCompacting" class="text-xs animate-pulse"
          >{{ t("chat.compacting") }}</span
        >
        <Button
          v-if="isDesktop"
          type="button"
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          :title="t('terminal.toggle')"
          :class="{ 'bg-accent text-accent-foreground': terminalOpen }"
          @click="toggleTerminal"
        >
          <SquareTerminal />
        </Button>
      </div>
    </header>

    <!-- conversation -->
    <div v-if="connecting || session.historyLoading" role="status" class="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
      <Loader :size="16" /> {{ t('chat.historyLoading') }}
    </div>
    <Conversation v-else ref="conversation" :key="session.sessionFile ?? project" initial="instant" resize="instant"
      class="min-h-0 flex-1" @scroll="onHistoryScroll">
      <ConversationContent
        class="conversation-column mx-auto w-full max-w-3xl gap-5 px-6 py-6"
        :class="{ 'has-timeline': session.entries.some(entry => entry.kind === 'user') }"
      >
        <div v-if="session.hasOlderHistory" class="text-muted-foreground flex h-8 items-center justify-center gap-2 text-sm" role="status">
          <template v-if="session.olderHistoryLoading"><Loader :size="16" /> {{ t('chat.historyLoading') }}</template>
        </div>
        <ConversationEmptyState
          class="chat-empty"
          v-if="session.entries.length === 0 && !session.historyLoading"
          :title="t('workspace.emptyTitle', { project: project.split(/[\\/]/).filter(Boolean).pop() })"
          :description="t('chat.emptyDesc')"
        />

        <template v-for="entry in renderedEntries" :key="entry.id">
          <Message :data-message-id="entry.id" :from="entry.kind === 'user' ? 'user' : 'assistant'">
            <div class="flex min-w-0 flex-col" :class="{ 'items-end': entry.kind === 'user' }">
              <MessageContent>
                <div
                  v-if="entry.kind === 'user'"
                  class="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
                >
                  {{ entry.text }}
                  <div
                    v-if="entry.images?.length"
                    class="mt-1.5 flex flex-wrap gap-1.5"
                  >
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
                    class="response-process"
                    @toggle="onProcessToggle(entry.id, $event)"
                  >
                    <summary class="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      {{ entry.durationMs == null ? t('chat.durationUnknown') : t('chat.executionDuration', { seconds: (entry.durationMs / 1000).toFixed(1) }) }}
                      <span class="mx-1.5" aria-hidden="true">·</span>
                      {{ t('chat.toolCallCount', { count: entry.toolCallCount }) }}
                    </summary>
                    <AssistantBlocks v-if="openedProcesses.has(entry.id)" class="mt-3 border-l pl-3" :blocks="entry.process" :runs="session.runs" />
                  </details>
                  <AssistantBlocks
                    :blocks="hasSummary(entry) ? entry.summary : entry.blocks"
                    :key-offset="hasSummary(entry) ? entry.blocks.length - entry.summary.length : 0"
                    :runs="session.runs"
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
                <MessageAction :tooltip="t('chat.copyReply')" @click="copyText(blocksText(entry.summary.length ? entry.summary : entry.blocks))">
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

        <!-- waiting indicator before any content arrives -->
        <div
          v-if="session.isStreaming && !session.partialBlocks"
          class="text-muted-foreground flex items-center gap-2 text-sm"
        >
          <Loader />
          <span>{{ t("chat.thinking") }}</span>
        </div>


        <!-- pending steering / follow-up -->
        <QueueSection v-if="session.steering.length + session.followUp.length > 0" class="mt-2">
          <QueueList>
            <QueueItem
              v-for="(s, i) in [...session.steering, ...session.followUp]"
              :key="i"
            >
              <QueueItemContent>{{ s }}</QueueItemContent>
            </QueueItem>
          </QueueList>
        </QueueSection>
      </ConversationContent>
      <template #overlay>
        <ConversationTimeline :turns="session.timelineTurns" :partial="session.partialBlocks" @navigate="navigateToQuestion" />
        <ConversationScrollButton />
      </template>
    </Conversation>

    <!-- extension widget -->
    <div
      v-if="ui.widget"
      class="border-border bg-muted/40 border-t px-4 py-2 font-mono text-xs whitespace-pre-wrap"
    >
      {{ ui.widget.lines.join("\n") }}
    </div>

    <!-- composer -->
    <div class="composer-dock mx-auto w-full max-w-3xl px-6 pb-5 pt-3">
      <WorkspaceContext v-if="!session.entries.length && !session.isStreaming" :project="project" @select-project="emit('selectProject', $event)" @open-project="emit('openProject')" />
      <section v-if="session.promptQueue.length" class="mb-2 rounded-xl border border-border bg-card/80 px-3 py-2" :aria-label="t('chat.queuedPrompts')">
        <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{{ t('chat.queuedPrompts') }} · {{ session.promptQueue.length }}</span>
          <Button v-if="!session.isStreaming" type="button" size="sm" variant="ghost" @click="session.dispatchQueuedPrompt()">{{ t('chat.resumeQueue') }}</Button>
        </div>
        <ul class="mt-1 max-h-40 overflow-y-auto">
          <li v-for="item in session.promptQueue" :key="item.id"
            class="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted" :class="{ 'opacity-50': draggedPrompt === item.id }"
            @dragover.prevent @drop.prevent.stop="dropQueuedPrompt(item.id)">
            <span draggable="true" class="shrink-0 cursor-grab p-1" :title="t('chat.dragQueue')"
              @dragstart="startQueueDrag($event, item.id)" @dragend="draggedPrompt = null"><GripVertical class="size-4" /></span>
            <span class="min-w-0 flex-1 truncate text-muted-foreground" :title="item.text">{{ item.text }}<span v-if="item.images?.length"> · {{ t('chat.queuedImages', { count: item.images.length }) }}</span></span>
            <div class="flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="icon-xs" :aria-label="t('chat.editQueuedPrompt')" @click="editQueuedPrompt(item.id)"><Pencil class="size-3" /></Button>
              <Button type="button" variant="ghost" size="icon-xs" :aria-label="t('chat.deleteQueuedPrompt')" @click="session.removeQueuedPrompt(item.id)"><Trash2 class="size-3" /></Button>
            </div>
          </li>
        </ul>
      </section>
      <PromptInput @submit="onSubmit">
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
        <ComposerCompletion ref="completion" :project="project" :connected="connected" :ensure-started="ensureStarted" />
        <PromptInputTextarea
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
          :disabled="workspace.gitBusy || (connecting && !completion?.initiating)"
          class="min-h-14"
        />
        <div data-align="block-end" class="composer-controls flex items-center justify-between">
          <div class="composer-options flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="text-muted-foreground px-2 py-1.5 text-xs"
              :title="t('chat.attachImage')"
              @click="bridge?.openFileDialog?.()"
            >
              + {{ t("chat.attachment") }}
            </Button>
            <ConversationModelSelect v-model="modelKey" :models="session.models" :disabled="!connected && session.models.length === 0" />

            <Select
              :model-value="session.thinkingLevel"
              :disabled="!connected && session.models.length === 0"
              @update:model-value="onThinkingChange"
            >
              <SelectTrigger class="h-8 w-auto min-w-16 max-w-40 text-xs">
                <SelectValue>{{ thinkingLabel(session.thinkingLevel) }}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="lv in session.availableThinking"
                  :key="lv"
                  :value="lv"
                  class="text-xs"
                >
                  {{ thinkingLabel(lv) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex items-center gap-1">
            <Context
              v-if="contextUsage"
              :used-tokens="contextUsage.tokens"
              :max-tokens="contextUsage.contextWindow"
              :usage="contextTokenUsage"
              :model-id="session.currentModel?.id"
            >
              <ContextTrigger>
                <Button type="button" variant="ghost" class="h-8 px-2 text-xs">
                  <ContextIcon />
                </Button>
              </ContextTrigger>
              <ContextContent>
                <ContextContentHeader />
                <ContextContentBody class="space-y-2">
                  <ContextInputUsage />
                  <ContextOutputUsage />
                  <ContextCacheUsage />
                </ContextContentBody>
              </ContextContent>
            </Context>
            <PromptInputSubmit
              :status="session.isStreaming ? 'streaming' : undefined"
              :type="session.isStreaming ? 'button' : 'submit'"
              :title="session.isStreaming ? t('chat.stop') : undefined"
              :aria-label="session.isStreaming ? t('chat.stop') : undefined"
              :disabled="workspace.gitBusy || connecting"
              @click="session.isStreaming && abort()"
            />
          </div>
        </div>
      </PromptInput>
      <StatusBar />
    </div>

    <!-- built-in terminal (desktop only), expanded below the composer -->
    <TerminalPanel
      v-if="isDesktop"
      ref="terminalPanel"
      v-show="terminalOpen"
      :project="project"
      :visible="terminalOpen"
      @close="terminalOpen = false"
    />

    <!-- session tree dialog -->
    <Dialog v-model:open="treeOpen">
      <DialogContent class="flex max-h-[75dvh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{{ t("chat.sessionTreeTitle") }}</DialogTitle>
        </DialogHeader>
        <ScrollArea class="min-h-0" viewport-class="max-h-[55dvh]">
        <SessionTree
          :open="treeOpen"
          @fork="doFork"
          @close="treeOpen = false"
        />
        </ScrollArea>
      </DialogContent>
    </Dialog>

    <!-- fork dialog -->
    <Dialog v-model:open="forkOpen">
      <DialogContent class="flex max-h-[70dvh] max-w-lg flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{{ t("chat.forkTitle") }}</DialogTitle>
        </DialogHeader>
        <p class="text-muted-foreground text-xs">
          {{ t("chat.forkDesc") }}
        </p>
        <ScrollArea class="min-h-0" viewport-class="max-h-[45dvh]">
        <div class="flex flex-col gap-1">
          <Button
            type="button"
            v-for="m in forkMessages"
            :key="m.entryId"
            variant="outline"
            class="h-auto justify-start px-3 py-2 text-left text-xs"
            @click="doFork(m.entryId)"
          >
            <span class="line-clamp-2">{{ m.text }}</span>
          </Button>
          <p v-if="!forkMessages.length" class="text-muted-foreground text-xs">
            {{ t("chat.forkEmpty") }}
          </p>
        </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>

    <!-- extension UI dialogs -->
    <Dialog :open="!!previewImage" @update:open="previewImage = null">
      <DialogContent class="max-w-4xl p-2">
        <img v-if="previewImage" :src="previewImage" class="max-h-[80dvh] w-full rounded-md object-contain" alt="preview" />
      </DialogContent>
    </Dialog>

    <ExtensionDialog />
  </div>
</template>
