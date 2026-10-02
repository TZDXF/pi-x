<script setup lang="ts">
import type { WorkspaceSelection } from "@/api/piClient"
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import ContextBreakdown from "@/components/ContextBreakdown.vue"
import ModelThinkingSelect from "@/components/ModelThinkingSelect.vue"
import { activeRuntimeId, sessionFor, uiFor } from "@/stores/conversations"
import { rpcRequest as requestForRuntime } from "@/api/piClient"
import ExtensionWidget from "@/components/chat/ExtensionWidget.vue"
import ChatDialogs from "@/components/chat/ChatDialogs.vue"
import ChatComposer from "@/components/chat/ChatComposer.vue"
import ChatTurnList from "@/components/chat/ChatTurnList.vue"
import { useChatSendControl } from "@/composables/useChatSendControl"
import { useChatTurnList, blocksText } from "@/composables/useChatTurnList"
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
import ExtensionDialog from "@/components/ExtensionDialog.vue"
import { useSessionFork } from "@/composables/useSessionFork"
import { usePromptEdit, type PromptEditTextarea } from "@/composables/usePromptEdit"
import { useSessionDrop, type SessionDragPayload } from "@/composables/useSessionDrop"
import type { SplitDropZone } from "@/lib/splitDropZone"
import { registerShortcutHandler, setShortcutsSuppressed } from "@/lib/shortcuts"
import { copyWithToast } from "@/lib/clipboard"
import { isDesktop } from "@/api/transport"
import PromptInputBridge from "@/components/PromptInputBridge.vue"
import { useWorkspaceStore } from "@/stores/workspace"
import { PanelRight, X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
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
function reorderSidebarTab(tabs: SidebarTabItem[]) {
  sidebarTabs.value = tabs
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

const conversation = ref<InstanceType<typeof ChatTurnList> | null>(null)
const { renderedEntries, navigateToQuestion, onHistoryScroll, lastAssistantTurn, scrollHistory } = useChatTurnList({
  session,
  ui,
  conversation,
  connecting: () => props.connecting,
})

const previewImage = ref<string | null>(null)

// ---- fork (restart from a previous prompt) ----
const { forkOpen, forkMessages, forkFromAnswer, doFork } = useSessionFork(session, ui, rpcRequest)

// Resend the edited question in this session, interrupting the current answer first.
const editTextarea = ref<PromptEditTextarea | null>(null)
const promptEdit = usePromptEdit({
  session,
  ui,
  workspace,
  editTextarea,
  project: () => props.project,
  connecting: () => props.connecting,
  connected: () => props.connected,
  knownSessions: () => knownSessions.value,
})
const edit = reactive(promptEdit)
const { editedPrompt, editBusy } = promptEdit

function copyText(text: string) {
  return copyWithToast(ui, text, t("chat.toastCopied"))
}

// ---- context usage and session-wide weighted cache hit rate ----
const { contextUsage, cacheRateText, contextBreakdown, refreshContextBreakdown } = useChatContextBreakdown(
  session,
  rpcRequest,
)

const { modelKey, onThinkingChange } = useConversationModel(session, {
  connected: () => props.connected,
  onError: (e: unknown) => ui.pushToast(String(e), "error"),
})

const sendControl = useChatSendControl({
  session,
  ui,
  workspace,
  bridge,
  project: () => props.project,
  connecting: () => props.connecting,
  editBusy: () => editBusy.value,
  knownSessions: () => knownSessions.value,
  workspaceSelection: () => workspaceSelection.value,
  ensureStarted: selection => props.ensureStarted(selection),
  newSession: () => emit("newSession"),
})
const controls = reactive(sendControl)
const { delayedSend, delayedSendEnabled, abort } = sendControl

// ---- keyboard shortcuts: executors for lib/shortcuts.ts actions ----

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
    if (delayedSendEnabled.value) delayedSend.value = !delayedSend.value
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

      <ChatTurnList
        ref="conversation"
        :session="session"
        :ui="ui"
        :project="project"
        :project-name="workspace.projectName(project)"
        :connecting="connecting"
        :selecting-project="selectingProject"
        :rendered-entries="renderedEntries"
        :edit="edit"
        @history-scroll="onHistoryScroll"
        @navigate="navigateToQuestion"
        @preview-image="previewImage = $event"
        @copy-text="copyText"
        @edit-textarea="editTextarea = $event"
        @open-review="openReviewAt"
        @fork="forkFromAnswer"
      />

      <!-- extension widget -->
      <ExtensionWidget v-if="ui.widget" :lines="ui.widget.lines" />

      <ChatComposer
        v-model:bridge="bridge"
        v-model:workspace-selection="workspaceSelection"
        :session="session"
        :runtime-id="runtimeId"
        :project="project"
        :git-busy="workspace.gitBusy"
        :connecting="connecting"
        :selecting-project="selectingProject"
        :connected="connected"
        :edit-busy="editBusy"
        :session-drag-over="sessionDragOver"
        :initial-draft="initialDraft"
        :ensure-started="ensureStarted"
        :controls="controls"
        @preview-image="previewImage = $event"
        @select-project="emit('selectProject', $event)"
        @open-project="emit('openProject')"
      >
        <template #model>
          <ModelThinkingSelect
            v-model="modelKey"
            :thinking-level="session.thinkingLevel"
            :available-thinking="session.availableThinking"
            :models="session.models"
            :disabled="!connected && session.models.length === 0"
            @update:thinking-level="onThinkingChange"
          />
        </template>
        <template #context>
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
        </template>
      </ChatComposer>

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
        @reorder-tabs="reorderSidebarTab"
        @close="sidebarOpen = false"
        @send-to-chat="insertIntoComposer"
      />
    </Teleport>
  </div>
</template>
