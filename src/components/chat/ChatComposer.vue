<script setup lang="ts">
import { toRefs, type UnwrapRef } from "vue"
import { useI18n } from "vue-i18n"
import { NumberFieldInput, NumberFieldRoot } from "reka-ui"
import { Clock3, MessageSquareQuote } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { PromptInputHeader, PromptInputSubmit } from "@/components/ai-elements/prompt-input"
import PromptInputBridge from "@/components/PromptInputBridge.vue"
import ConversationSelectionSummary from "@/components/chat/ConversationSelectionSummary.vue"
import WorkspaceContext from "@/components/WorkspaceContext.vue"
import ChatQueuePanel from "./ChatQueuePanel.vue"
import ChatPromptInput from "./ChatPromptInput.vue"
import StatusBar from "@/components/StatusBar.vue"
import { baseName as commentFile } from "@/lib/paths"
import { commentLineLabel, commentPathLabel } from "@/lib/codeComments"
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
  /**
   * aux 面板用：aux 跟着父会话的 project 启动、不支持切换项目/分支，所以隐藏项目
   * 选择器（默认 false = 主会话行为不变）。
   */
  hideWorkspaceContext?: boolean
}>()
const bridge = defineModel<InstanceType<typeof PromptInputBridge> | null>("bridge", { required: true })
const workspaceSelection = defineModel<WorkspaceSelection | null>("workspaceSelection", { required: true })
const emit = defineEmits<{
  previewImage: [url: string | null]
  selectProject: [path: string]
  openProject: []
  locateSelection: [id: string]
  editSelection: [id: string]
}>()
const { t } = useI18n()
const {
  pendingComments,
  pendingSelections,
  delayedSend,
  delayedSendEnabled,
  sendDelayMinutes,
  sendDelaySeconds,
  showStopButton,
} = toRefs(props.controls)
const { codeComments, selections, onSendDelayWheel, onSubmit, abort } = props.controls
</script>

<template>
  <!-- composer -->
  <div class="composer-dock mx-auto w-full max-w-3xl px-6 pt-3 shrink-0 pb-3 max-[900px]:pl-4 max-[900px]:pr-4">
    <WorkspaceContext
      v-model="workspaceSelection"
      :initial-selection="workspaceSelection"
      :disabled="gitBusy || connecting"
      v-if="
        !hideWorkspaceContext &&
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
    <ChatPromptInput
      v-model:bridge="bridge"
      :initial-draft="initialDraft"
      :disabled="editBusy || gitBusy"
      :drag-over="sessionDragOver"
      :commands="session.commands"
      :completion-options="{ sessionId: runtimeId, project, connected, ensureStarted }"
      :submit="onSubmit"
      @error="controls.onInputError"
      @preview-image="emit('previewImage', $event)"
    >
      <template #header>
        <PromptInputHeader v-if="pendingSelections.length">
          <!-- 待发送的划词引用摘要：悬停展开列表，可定位/编辑/删除 -->
          <div class="px-1">
            <ConversationSelectionSummary
              :items="pendingSelections"
              @locate="emit('locateSelection', $event)"
              @edit="emit('editSelection', $event)"
              @remove="selections.remove($event)"
            />
          </div>
        </PromptInputHeader>
        <PromptInputHeader v-if="pendingComments.length">
          <!-- 待发送的代码批注，随下一条消息一并发给 agent -->
          <div class="flex min-w-0 flex-wrap gap-1.5 px-1">
            <div
              v-for="c in pendingComments"
              :key="c.id"
              class="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 py-1 pr-1 pl-2 text-xs"
            >
              <MessageSquareQuote class="size-3.5 shrink-0 text-muted-foreground" />
              <!-- 路径与批注都**可收缩**：`shrink-0` 的长路径曾把 chip 顶出 composer
                   容器（宽度算成 max-content，然后被父级 overflow-hidden 裁切）。
                   路径与批注从 0 起按比例增长（`basis-0` + `grow`）；行号是**独立后缀段**
                   （`shrink-0`，不跟路径一起被截断），路径单行截断、批注两行截断；
                   完整 path:行号 与批注全文由 `title` 给出。 -->
              <span class="min-w-0 basis-0 grow-[3] truncate font-mono" :title="commentPathLabel(c)">{{
                commentFile(c.path)
              }}</span>
              <span class="shrink-0 font-mono" data-code-comment-lines>{{
                commentLineLabel(c.startLine, c.endLine)
              }}</span>
              <span
                class="line-clamp-2 min-w-0 basis-0 grow-[2] break-words whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]"
                :title="c.comment"
                >{{ c.comment }}</span
              >
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
      </template>
      <template #model><slot name="model" /></template>
      <template #actions>
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
          :disabled="editBusy || gitBusy"
          @click="showStopButton && abort()"
        />
      </template>
    </ChatPromptInput>
    <StatusBar :session-id="runtimeId" />
  </div>
</template>
