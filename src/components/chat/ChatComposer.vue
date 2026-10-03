<script setup lang="ts">
import { ref, toRefs, type UnwrapRef, type ComponentPublicInstance } from "vue"
import { useI18n } from "vue-i18n"
import { NumberFieldInput, NumberFieldRoot } from "reka-ui"
import { Clock3, MessageSquareQuote, Paperclip, TextQuote } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { PromptInput, PromptInputHeader, PromptInputSubmit } from "@/components/ai-elements/prompt-input"
import PromptInputBridge from "@/components/PromptInputBridge.vue"
import WorkspaceContext from "@/components/WorkspaceContext.vue"
import ChatQueuePanel from "./ChatQueuePanel.vue"
import ComposerCompletion from "@/components/ComposerCompletion.vue"
import ComposerRichEditor from "@/components/ComposerRichEditor.vue"
import StatusBar from "@/components/StatusBar.vue"
import { baseName as commentFile } from "@/lib/paths"
import { isImageAttachment } from "@/lib/attachments"
import type { WorkspaceSelection } from "@/api/piClient"
import type { SessionStore } from "@/stores/session"
import type { useChatSendControl } from "@/composables/useChatSendControl"

const props = defineProps<{
  session: SessionStore
  runtimeId: string
  project: string
  gitBusy: boolean
  connecting: boolean
  selectingProject?: boolean
  connected: boolean
  editBusy: boolean
  sessionDragOver: boolean
  initialDraft: string
  ensureStarted: (selection?: WorkspaceSelection | null) => Promise<boolean>
  controls: UnwrapRef<ReturnType<typeof useChatSendControl>>
}>()
const bridge = defineModel<InstanceType<typeof PromptInputBridge> | null>("bridge", { required: true })
const workspaceSelection = defineModel<WorkspaceSelection | null>("workspaceSelection", { required: true })
const emit = defineEmits<{ previewImage: [url: string | null]; selectProject: [path: string]; openProject: [] }>()
const { t } = useI18n()
const completion = ref<InstanceType<typeof ComposerCompletion> | null>(null)
const {
  attachments,
  pendingComments,
  pendingSelections,
  delayedSend,
  delayedSendEnabled,
  sendDelayMinutes,
  sendDelaySeconds,
  showStopButton,
} = toRefs(props.controls)
const { codeComments, conversationSelections, onSendDelayWheel, onSubmit, abort } = props.controls
function bindBridge(value: Element | ComponentPublicInstance | null) {
  bridge.value = value as InstanceType<typeof PromptInputBridge> | null
}
</script>

<template>
  <!-- composer -->
  <div class="composer-dock mx-auto w-full max-w-3xl px-6 pt-3 shrink-0 pb-3 max-[900px]:pl-4 max-[900px]:pr-4">
    <WorkspaceContext
      v-model="workspaceSelection"
      :disabled="gitBusy || connecting"
      v-if="
        !session.promptQueue.length &&
        !session.entries.length &&
        !session.isStreaming &&
        (!connecting || selectingProject || gitBusy) &&
        !session.historyLoading
      "
      :project="project"
      @select-project="emit('selectProject', $event)"
      @open-project="emit('openProject')"
    />
    <ChatQueuePanel
      v-if="session.promptQueue.length"
      :session="session"
      :bridge="bridge"
      :git-busy="gitBusy"
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
      <PromptInputBridge :ref="bindBridge" />
      <PromptInputHeader v-if="attachments.length">
        <!-- pending image attachments -->
        <div class="flex flex-wrap gap-2 px-1">
          <div
            v-for="f in attachments"
            :key="f.id"
            class="border-border bg-muted relative size-16 overflow-hidden rounded-md border"
          >
            <img
              v-if="isImageAttachment(f)"
              :src="f.url"
              class="size-full cursor-zoom-in object-cover"
              alt="attachment"
              :title="t('chat.previewImage')"
              @click="emit('previewImage', f.url ?? null)"
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
      <PromptInputHeader v-if="pendingSelections.length">
        <!-- 待发送的对话划词引用，随下一条消息一并发给 agent -->
        <div class="flex flex-wrap gap-1.5 px-1">
          <div
            v-for="s in pendingSelections"
            :key="s.id"
            class="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 py-1 pr-1 pl-2 text-xs"
          >
            <TextQuote class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="shrink-0 text-muted-foreground">{{
              s.source === "user" ? t("chat.selectionFromUser") : t("chat.selectionFromAssistant")
            }}</span>
            <span class="min-w-0 truncate" :title="s.text">{{ s.text }}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              class="size-4 shrink-0 rounded-full text-[10px] leading-none"
              :title="t('chat.selectionRemove')"
              :aria-label="t('chat.selectionRemove')"
              @click="conversationSelections.remove(s.id)"
              >×</Button
            >
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
        :disabled="editBusy || gitBusy || (connecting && !selectingProject && !completion?.initiating)"
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

          <slot name="model" />
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
            v-if="delayedSendEnabled"
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
          <slot name="context" />
          <PromptInputSubmit
            :status="showStopButton ? 'streaming' : undefined"
            :type="showStopButton ? 'button' : 'submit'"
            :title="showStopButton ? t('chat.stop') : delayedSend ? t('chat.delayedSend') : undefined"
            :aria-label="showStopButton ? t('chat.stop') : delayedSend ? t('chat.delayedSend') : t('chat.sendMessage')"
            :disabled="editBusy || gitBusy || connecting"
            @click="showStopButton && abort()"
          />
        </div>
      </div>
    </PromptInput>
    <StatusBar :session-id="runtimeId" />
  </div>
</template>
