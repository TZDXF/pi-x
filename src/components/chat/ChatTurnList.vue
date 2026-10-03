<script setup lang="ts">
import { reactive, ref, watch, onBeforeUnmount, type UnwrapRef } from "vue"
import { useI18n } from "vue-i18n"
import { RefreshCw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
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
import VirtualMessage from "@/components/VirtualMessage.vue"
import ConversationTimeline from "@/components/ConversationTimeline.vue"
import ChatUserPrompt from "./ChatUserPrompt.vue"
import ChatAssistantTurn from "./ChatAssistantTurn.vue"
import { useTurnChanges } from "@/composables/useTurnChanges"
import { compactNumber } from "@/lib/format"
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
const { session, ui } = props
const changes = useTurnChanges(session, props.ui)
const { t } = useI18n()
/** 停止等待中的自动重试：取消延时并不再重试，pi 经 auto_retry_end 报告取消。 */
async function stopRetry() {
  try {
    await session.abortRetry()
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}
// Kept outside VirtualMessage: virtualization may unmount an answer, but must
// not forget that its process was already materialized.
const openedProcesses = reactive(new Set<number>())
watch(
  () => session.sessionFile,
  () => openedProcesses.clear(),
)
const conversation = ref<InstanceType<typeof Conversation> | null>(null)
defineExpose({
  historyViewport: () => conversation.value?.$el?.querySelector('[role="log"]') ?? null,
  stopScroll: () => conversation.value?.stopScroll(),
  scrollToMessage: (id: number) => conversation.value?.scrollToMessage(id),
})
// waiting-for-reply status: elapsed seconds tick while the reply has no content yet
const waitingSeconds = ref(0)
let waitingClock: ReturnType<typeof setInterval> | undefined
watch(
  () => session.isStreaming && !session.partialBlocks,
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
            <div class="flex min-w-0 flex-col" :class="entry.kind === 'user' ? 'items-end' : 'flex-1'">
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
            </div>
          </Message>
        </template>
      </VirtualMessage>

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
            <Button variant="outline" size="sm" class="h-7 shrink-0 text-xs" @click="stopRetry">
              {{ t("chat.abortRetry") }}
            </Button>
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
</template>
