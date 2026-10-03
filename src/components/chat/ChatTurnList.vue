<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type UnwrapRef } from "vue"
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
import ComposerText from "@/components/ComposerText.vue"
import VirtualMessage from "@/components/VirtualMessage.vue"
import ConversationTimeline from "@/components/ConversationTimeline.vue"
import ChatUserPrompt from "./ChatUserPrompt.vue"
import ChatAssistantTurn from "./ChatAssistantTurn.vue"
import ConversationSelectionMenu from "./ConversationSelectionMenu.vue"
import ConversationSelectionPopup, { type SelectionPopupState } from "./ConversationSelectionPopup.vue"
import { useTurnChanges } from "@/composables/useTurnChanges"
import {
  CONVERSATION_SELECTION_MAX_COUNT,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  type ConversationSelectionSource,
} from "@/lib/conversationSelections"
import { boundaryRect, restoreSelection, selectionEndRect } from "@/lib/selectionAnchors"
import { useConversationSelectionsStore } from "@/stores/conversationSelections"
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
  locateSelection,
  editSelection,
})
// ---- 对话划词引用（对齐 ZCode conversation selections）：选中文本暂存 composer，
// ---- 随下一条消息以 "# userselect:" 尾块发出。引用按会话归属；
// ---- 提交后在划词结束处渲染索引数字标记，支持定位与回显编辑。 ----
const selectionStore = useConversationSelectionsStore()
const selectionScope = computed(() => session.sessionFile ?? props.project)
const selectionRoot = computed<HTMLElement | null>(() => (conversation.value?.$el as HTMLElement | undefined) ?? null)
const pendingSelections = computed(() => (selectionStore.scope === selectionScope.value ? selectionStore.items : []))
const selectionPopup = ref<(SelectionPopupState & { id?: string }) | null>(null)
function pushSelectionToast(result: { ok: boolean; reason?: string; duplicate?: boolean }) {
  if (!result.ok) {
    if (result.reason === "count")
      ui.pushToast(t("chat.selectionLimitCount", { count: CONVERSATION_SELECTION_MAX_COUNT }), "error")
    else if (result.reason === "total") ui.pushToast(t("chat.selectionLimitTotal"), "error")
    else ui.pushToast(t("chat.selectionLimitSingle"), "error")
  } else if (result.duplicate) ui.pushToast(t("chat.selectionDuplicate"))
}
// 点击"引用到输入框"立即入库：批注可选，稍后通过索引标记或摘要列表补充。
function onSelectionQuote(payload: {
  text: string
  source: ConversationSelectionSource
  messageId: number
  startOffset: number
  endOffset: number
}) {
  const result = selectionStore.add(selectionScope.value, { ...payload })
  pushSelectionToast(result)
  window.getSelection()?.removeAllRanges()
}
function onSelectionSave(comment: string) {
  const id = selectionPopup.value?.id
  if (id) selectionStore.update(id, comment)
  selectionPopup.value = null
  window.getSelection()?.removeAllRanges()
}
function onSelectionRemove() {
  const id = selectionPopup.value?.id
  if (id) selectionStore.remove(id)
  selectionPopup.value = null
  window.getSelection()?.removeAllRanges()
}
function onSelectionCancel() {
  selectionPopup.value = null
  window.getSelection()?.removeAllRanges()
}
// ---- 索引标记覆盖层：按引用在列表中的序号渲染到划词结束处（布局变化时重算） ----
const anchorOverlays = ref<Map<number, { id: string; index: number; left: number; top: number }[]>>(new Map())
async function recomputeAnchors() {
  const root = selectionRoot.value
  const map = new Map<number, { id: string; index: number; left: number; top: number }[]>()
  if (root) {
    pendingSelections.value.forEach((item, index) => {
      const wrapper = root.querySelector(`[data-message-id="${item.messageId}"] [data-selection-source]`)
      if (!wrapper) return
      const rect = boundaryRect(wrapper, item.endOffset)
      const wrapperRect = wrapper.getBoundingClientRect()
      if (!rect) return
      const list = map.get(item.messageId) ?? []
      list.push({
        id: item.id,
        index: index + 1,
        left: rect.right - wrapperRect.left + 2,
        // 徽标抬到划词末行上方，避免盖住正文文字。
        top: rect.top - wrapperRect.top - 16,
      })
      map.set(item.messageId, list)
    })
  }
  anchorOverlays.value = map
}
watch(
  [() => props.renderedEntries, pendingSelections],
  () => {
    // 编辑态弹窗对应的引用被删除/清空时同步关闭。
    const popup = selectionPopup.value
    if (popup?.id && !pendingSelections.value.some(item => item.id === popup.id)) selectionPopup.value = null
    void nextTick(recomputeAnchors)
  },
  { deep: true, immediate: true },
)
onMounted(() => {
  window.addEventListener("resize", recomputeAnchors)
})
onBeforeUnmount(() => {
  window.removeEventListener("resize", recomputeAnchors)
})
// ---- 摘要列表动作：定位（滚动到索引标记）与编辑（回显划选后打开弹窗） ----
function locateSelection(id: string) {
  const item = pendingSelections.value.find(entry => entry.id === id)
  if (!item) return
  const badge = selectionRoot.value?.querySelector(`[data-selection-anchor="${id}"]`)
  if (badge) {
    badge.scrollIntoView({ block: "center", behavior: "smooth" })
    return
  }
  conversation.value?.scrollToMessage(item.messageId)
  void nextTick(recomputeAnchors)
}
async function editSelection(id: string) {
  const item = pendingSelections.value.find(entry => entry.id === id)
  if (!item) return
  locateSelection(id)
  await nextTick()
  await new Promise(resolve => requestAnimationFrame(resolve))
  const root = selectionRoot.value
  const wrapper = root?.querySelector(`[data-message-id="${item.messageId}"] [data-selection-source]`)
  let anchor: { left: number; top: number; bottom: number } | null = null
  const badge = root?.querySelector(`[data-selection-anchor="${id}"]`)
  if (wrapper && restoreSelection(wrapper, item.startOffset, item.endOffset)) {
    const selection = window.getSelection()
    if (selection?.rangeCount) {
      const endRect = selectionEndRect(selection.getRangeAt(0))
      if (endRect) anchor = { left: endRect.right, top: endRect.top, bottom: endRect.bottom }
    }
  }
  if (!anchor && badge) {
    const badgeRect = badge.getBoundingClientRect()
    anchor = { left: badgeRect.right, top: badgeRect.top, bottom: badgeRect.bottom }
  }
  if (!anchor) return
  selectionPopup.value = {
    id: item.id,
    comment: item.comment ?? "",
    anchor,
  }
}
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
              <sup
                v-for="badge in anchorOverlays.get(entry.id) ?? []"
                :key="badge.id"
                :data-selection-anchor="badge.id"
                class="selection-anchor-badge selection-anchor-overlay"
                :title="t('chat.selectionEdit')"
                :style="{ left: `${badge.left}px`, top: `${badge.top}px` }"
                @click="editSelection(badge.id)"
                >{{ badge.index }}</sup
              >
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

<style>
/* 划词引用的索引数字标记基础样式（消息内为绝对定位覆盖层，摘要列表内为行内徽标） */
.selection-anchor-badge {
  display: inline-block;
  padding: 0 5px;
  border-radius: 9999px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  user-select: none;
}
/* 消息内覆盖层变体：定位在划词结束处，点击直接编辑 */
.selection-anchor-overlay {
  position: absolute;
  cursor: pointer;
}
</style>
