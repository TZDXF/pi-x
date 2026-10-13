<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch, type UnwrapRef } from "vue"
import { useI18n } from "vue-i18n"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageContent } from "@/components/ai-elements/message"
import { Loader } from "@/components/ai-elements/loader"
import { QueueItem, QueueItemContent, QueueList, QueueSection } from "@/components/ai-elements/queue"
import PiXLogo from "@/components/PiXLogo.vue"
import ComposerText from "@/components/ComposerText.vue"
import VirtualMessage from "@/components/VirtualMessage.vue"
import ConversationTimeline from "@/components/ConversationTimeline.vue"
import ChatUserPrompt from "./ChatUserPrompt.vue"
import ChatErrorRecord from "./ChatErrorRecord.vue"
import ChatAssistantTurn from "./ChatAssistantTurn.vue"
import ChatCompactionMarker from "./ChatCompactionMarker.vue"
import ChatModelChangeMarker from "./ChatModelChangeMarker.vue"
import RetryBanner from "./RetryBanner.vue"
import SelectionAnchorBadges from "./SelectionAnchorBadges.vue"
import ConversationSelectionMenu from "./ConversationSelectionMenu.vue"
import ConversationSelectionPopup from "./ConversationSelectionPopup.vue"
import { useSelectionQuotes } from "@/composables/useSelectionQuotes"
import { useTurnChanges } from "@/composables/useTurnChanges"
import { CONVERSATION_SELECTION_MAX_TEXT_LENGTH } from "@/lib/conversationSelections"
import { formatCodedError } from "@/lib/backendError"
import type { TimelineTurn } from "@/lib/conversationTimeline"
import type { useChatTurnList } from "@/composables/useChatTurnList"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import type { usePromptEdit, PromptEditTextarea } from "@/composables/usePromptEdit"

const props = defineProps<{
  session: SessionStore
  ui: UiStore
  project: string
  projectName: string
  connecting: boolean
  selectingProject?: boolean
  renderedEntries: ReturnType<typeof useChatTurnList>["renderedEntries"]["value"]
  edit: UnwrapRef<ReturnType<typeof usePromptEdit>>
}>()
const emit = defineEmits<{
  historyScroll: [event: Event]
  navigate: [turn: TimelineTurn]
  previewImage: [url: string]
  copyText: [text: string]
  editTextarea: [textarea: PromptEditTextarea | null]
  openReview: [path: string]
  fork: [index: number]
}>()
const changes = useTurnChanges(props.session, props.ui)
const { t } = useI18n()
/** 停止等待中的自动重试：取消延时并不再重试，pi 经 auto_retry_end 报告取消。 */
async function stopRetry() {
  try {
    await props.session.abortRetry()
  } catch (e) {
    props.ui.pushToast(formatCodedError(t, e), "error")
  }
}
// Kept outside VirtualMessage: virtualization may unmount an answer, but must
// not forget that its process was already materialized.
const openedProcesses = reactive(new Set<number>())
watch(
  () => props.session.sessionFile,
  () => openedProcesses.clear(),
)
const conversation = ref<InstanceType<typeof Conversation> | null>(null)
const {
  selectionRoot,
  anchorOverlays,
  selectionPopup,
  locateSelection,
  editSelection,
  onSelectionQuote,
  onSelectionSave,
  onSelectionRemove,
  onSelectionCancel,
} = useSelectionQuotes({
  session: props.session,
  ui: props.ui,
  project: () => props.project,
  renderedEntries: () => props.renderedEntries,
  conversation,
})
defineExpose({
  historyViewport: () => conversation.value?.$el?.querySelector('[role="log"]') ?? null,
  stopScroll: () => conversation.value?.stopScroll(),
  scrollToBottom: () => conversation.value?.scrollToBottom(),
  scrollToMessage: (id: number) => conversation.value?.scrollToMessage(id),
  locateSelection,
  editSelection,
})
// waiting-for-reply status: elapsed seconds tick while the reply has no content yet
const waitingSeconds = ref(0)
/** 会话是否已有用户消息：决定消息列的缩进布局（模板内联计算提为 computed）。 */
const hasUserEntries = computed(() => props.session.entries.some(entry => entry.kind === "user"))
let waitingClock: ReturnType<typeof setInterval> | undefined
watch(
  () => props.session.isStreaming && !props.session.partialBlocks,
  waiting => {
    if (waiting && waitingClock === undefined) {
      waitingSeconds.value = 0
      const since = Date.now()
      waitingClock = setInterval(() => {
        waitingSeconds.value = Math.floor((Date.now() - since) / 1000)
      }, 1000)
    } else if (!waiting && waitingClock !== undefined) {
      clearInterval(waitingClock)
      waitingClock = undefined
    }
  },
)
onBeforeUnmount(() => {
  if (waitingClock !== undefined) clearInterval(waitingClock)
})
</script>

<template>
  <!-- conversation: loading (session start / history load) is kept silent;
         the area renders immediately and history appears once ready -->
  <Conversation
    ref="conversation"
    :key="session.sessionFile ?? project"
    initial="instant"
    resize="instant"
    class="min-h-0 flex-1"
    @scroll="emit('historyScroll', $event)"
  >
    <ConversationContent
      class="conversation-column has-[[data-slot=conversation-empty-state]]:justify-center mx-auto w-full max-w-3xl gap-5 px-6 py-6 min-h-full max-[640px]:pl-4 max-[640px]:pr-4"
      :class="{ 'pl-[42px] max-[640px]:pl-[42px]': hasUserEntries }"
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
        :title="t('workspace.emptyTitle', { project: projectName })"
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
        <ChatCompactionMarker v-if="entry.kind === 'compaction'" :entry="entry" />
        <ChatModelChangeMarker v-else-if="entry.kind === 'model_change'" :entry="entry" />
        <template v-else>
          <Message :data-message-id="entry.id" :from="entry.kind === 'user' ? 'user' : 'assistant'">
            <div
              class="relative flex min-w-0 flex-col"
              :class="entry.kind === 'user' ? 'items-end' : 'flex-1'"
              :data-selection-source="entry.kind === 'user' ? 'user' : 'assistant'"
            >
              <ChatUserPrompt
                v-if="entry.kind === 'user'"
                :entry="entry"
                :edit="edit"
                @preview-image="emit('previewImage', $event)"
                @copy-text="emit('copyText', $event)"
                @edit-textarea="emit('editTextarea', $event)"
              />
              <ChatAssistantTurn
                v-else-if="entry.kind === 'assistant'"
                :entry="entry"
                :session="session"
                :changes="changes"
                :process-opened="openedProcesses.has(entry.id)"
                @process-opened="openedProcesses.add(entry.id)"
                :project="project"
                :animate="animate"
                @open-review="emit('openReview', $event)"
                @fork="emit('fork', $event)"
                @copy-text="emit('copyText', $event)"
              />
              <!-- 划词引用的索引数字标记：绝对定位在划词结束处，点击直接编辑 -->
              <SelectionAnchorBadges :badges="anchorOverlays.get(entry.id) ?? []" @edit="editSelection" />
            </div>
          </Message>
        </template>
      </VirtualMessage>

      <!-- 冷启动回显：worker 尚未就绪时先把首条消息画出来，避免对话区空白 -->
      <template v-if="ui.pendingUserMessage">
        <Message from="user">
          <div class="relative flex min-w-0 flex-col items-end">
            <MessageContent>
              <div class="text-sm">
                <ComposerText :text="ui.pendingUserMessage.text" />
                <div v-if="ui.pendingUserMessage.images.length" class="mt-1.5 flex flex-wrap gap-2">
                  <button
                    v-for="(im, i) in ui.pendingUserMessage.images"
                    :key="i"
                    type="button"
                    class="border-border bg-muted relative size-16 cursor-zoom-in overflow-hidden rounded-md border transition-opacity hover:opacity-90"
                    :title="t('chat.previewImage')"
                    :aria-label="t('chat.previewImage')"
                    @click="emit('previewImage', im.url)"
                  >
                    <img :src="im.url" class="size-full object-cover" alt="" />
                  </button>
                </div>
              </div>
            </MessageContent>
          </div>
        </Message>
        <div
          v-if="connecting && !selectingProject"
          class="text-muted-foreground mt-2 flex items-center gap-2 text-sm"
          role="status"
        >
          <Loader :size="14" />
          <span>{{ t("chat.startingSession") }}</span>
        </div>
      </template>

      <!-- waiting indicator before any content arrives: icon on the left,
               loading status (with elapsed seconds) on the right -->
      <div
        v-if="session.isStreaming && !session.partialBlocks"
        class="text-muted-foreground flex items-center gap-2 text-sm"
        role="status"
      >
        <Loader :size="14" />
        <span class="tabular-nums">{{
          waitingSeconds > 0 ? t("chat.thinkingSeconds", { seconds: waitingSeconds }) : t("chat.thinking")
        }}</span>
      </div>

      <RetryBanner v-if="session.retryInfo" :retry="session.retryInfo" @stop="stopRetry" />

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

      <ChatErrorRecord
        v-if="session.compactionError"
        :text="session.compactionError"
        :title="t('chat.compactionFailed')"
        class="mt-2"
      />

      <!-- compaction progress: a divider inside the conversation -->
      <div v-if="session.isCompacting" class="mt-2 flex items-center gap-3 text-xs text-muted-foreground" role="status">
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
        @navigate="emit('navigate', $event)"
      />
      <ConversationScrollButton />
    </template>
  </Conversation>
  <!-- 划词菜单与批注弹窗放会话容器外：fixed 定位不受滚动/变换影响 -->
  <ConversationSelectionMenu
    :root="selectionRoot"
    :max-text-length="CONVERSATION_SELECTION_MAX_TEXT_LENGTH"
    @quote="onSelectionQuote"
  />
  <ConversationSelectionPopup
    :state="selectionPopup"
    @save="onSelectionSave"
    @remove="onSelectionRemove"
    @cancel="onSelectionCancel"
  />
</template>
