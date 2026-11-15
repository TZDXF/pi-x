<script setup lang="ts">
import { computed, nextTick, reactive, ref, type UnwrapRef } from "vue"
import { useI18n } from "vue-i18n"
import { MessageSquarePlus, RefreshCw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import ChatComposer from "@/components/chat/ChatComposer.vue"
import ChatTurnList from "@/components/chat/ChatTurnList.vue"
import ExtensionWidget from "@/components/chat/ExtensionWidget.vue"
import ExtensionDialog from "@/components/ExtensionDialog.vue"
import ModelThinkingSelect from "@/components/ModelThinkingSelect.vue"
import { useChatSendControl } from "@/composables/useChatSendControl"
import { useChatTurnList } from "@/composables/useChatTurnList"
import { useAuxDraft } from "@/composables/useAuxDraft"
import { useConversationModel } from "@/composables/useConversationModel"
import { formatCodedError } from "@/lib/backendError"
import { retryAuxSpawn, type AuxParentContext } from "@/lib/auxSpawn"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"
import type { usePromptEdit } from "@/composables/usePromptEdit"
import { useWorkspaceStore } from "@/stores/workspace"
import { auxSessionFor, auxUiFor, type AuxTab } from "@/stores/auxChat"

/**
 * aux（辅助对话）面板（`docs/aux-chat-spec.md` §3/§5）。
 *
 * 复用主会话的对话列表与输入框组件，但**不复用**主会话的行为：
 * - 不做 history 分页 / edit-retry / read-receipt（aux 无 session 文件，`--no-session`）；
 * - `ExtensionDialog` 与 `StatusBar`（经由 `ChatComposer`）都拿 **aux 自己的**
 *   `sessionId`，否则扩展询问会落到主会话的 ui store、回答发错进程；
 * - `ExtensionDialog` 只在 Tab 激活态渲染：隐藏的面板抢焦点没有意义，未答询问改由
 *   侧栏 Tab 标题上的标记提示。
 */
const props = defineProps<{
  /** 所属 aux 实例。 */
  tab: AuxTab
  /** 是否处于激活态（`v-show` 隐藏时仍挂载，但弹框不渲染）。 */
  active: boolean
  /** 父会话启动上下文（模型/工作区）；失败重试复用同一份。 */
  parent: AuxParentContext
}>()

const { t } = useI18n()
const workspace = useWorkspaceStore()

const runtimeId = computed(() => props.tab.runtimeId)
const session = auxSessionFor(props.tab.runtimeId)
const ui = auxUiFor(props.tab.runtimeId)

const bridge = ref<InstanceType<typeof PromptInputBridge> | null>(null)
const { initialDraft } = useAuxDraft(props.tab.runtimeId, bridge)

const conversation = ref<InstanceType<typeof ChatTurnList> | null>(null)
const { renderedEntries, navigateToQuestion, onHistoryScroll } = useChatTurnList({
  session,
  ui,
  conversation,
  // aux 没有冷启动等待：面板只在 `ready` 时渲染对话区（失败态显示原因）。
  connecting: () => false,
})

const project = computed(() => props.parent.project)
const workspaceSelection = ref(null)
const ready = computed(() => props.tab.status === "ready")

function jumpToBottom() {
  void nextTick().then(() => conversation.value?.scrollToBottom())
}

const sendControl = useChatSendControl({
  session,
  ui,
  workspace,
  bridge,
  project: () => project.value,
  connecting: () => false,
  editBusy: () => false,
  knownSessions: () => [],
  workspaceSelection: () => workspaceSelection.value,
  // 进程已经在跑：`ensureStarted` 只是"能不能发"的回答，不再启动任何东西。
  ensureStarted: async () => ready.value,
  newSession: () => {},
  onSent: jumpToBottom,
  // aux 不消费也不清空主会话的代码批注/划词引用桶（引用分桶是 TZD-103 的范围）。
  contexts: "none",
})
const controls = reactive(sendControl)

const { modelKey, onThinkingChange } = useConversationModel(session, {
  connected: () => ready.value,
  onError: (error: unknown) => ui.pushToast(formatCodedError(t, error), "error"),
})

/**
 * `ChatTurnList` 的编辑态桩：aux **不做** edit-retry（`rewind_prompt` 被 M0 策略拒绝、
 * 且没有 session 文件可回滚）。把 `lastUserPromptId` 恒为 `null`、`editBlocked` 恒为
 * `true`，编辑入口就不出现，同时公共组件的模板行为一字未改。
 */
const noPromptEdit: UnwrapRef<ReturnType<typeof usePromptEdit>> = {
  editedPrompt: null,
  editedText: "",
  editBusy: false,
  lastUserPromptId: null,
  editBlocked: true,
  startEditPrompt: async () => {},
  cancelEditedPrompt: () => {},
  resendEditedPrompt: async () => {},
}
const edit = reactive(noPromptEdit)

const errorText = computed(() =>
  props.tab.error ? formatCodedError(t, props.tab.error) : t("auxChat.spawnFailedUnknown"),
)

/** 失败重试：同一槽位重走一次 spawn（收尾规则与首次启动同一份实现）。 */
function retry() {
  return retryAuxSpawn(props.parent, props.tab)
}

async function copyText(text: string) {
  try {
    await navigator.clipboard?.writeText(text)
    ui.pushToast(t("chat.toastCopied"), "info")
  } catch (error) {
    ui.pushToast(String(error), "error")
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" :data-aux-runtime="runtimeId">
    <!-- 创建失败：显示原因（coded error 按当前语言翻译），不静默 -->
    <div
      v-if="tab.status === 'error'"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm"
      role="alert"
    >
      <MessageSquarePlus class="text-muted-foreground size-6 shrink-0" aria-hidden="true" />
      <p class="text-center">{{ errorText }}</p>
      <Button type="button" variant="outline" size="sm" @click="retry">
        <RefreshCw class="size-3.5 shrink-0" />{{ t("auxChat.retry") }}
      </Button>
    </div>
    <div
      v-else-if="tab.status === 'creating'"
      class="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-6 text-sm"
      role="status"
    >
      {{ t("auxChat.creating") }}
    </div>
    <template v-else>
      <ChatTurnList
        ref="conversation"
        :session="session"
        :ui="ui"
        :project="project"
        :project-name="workspace.projectName(project)"
        :connecting="false"
        :rendered-entries="renderedEntries"
        :edit="edit"
        @history-scroll="onHistoryScroll"
        @navigate="navigateToQuestion"
        @copy-text="copyText"
      />
      <ExtensionWidget v-if="ui.widget" :lines="ui.widget.lines" />
      <ChatComposer
        v-model:bridge="bridge"
        v-model:workspace-selection="workspaceSelection"
        :session="session"
        :runtime-id="runtimeId"
        :project="project"
        :git-busy="false"
        :connecting="false"
        :connected="ready"
        :edit-busy="false"
        :session-drag-over="false"
        :initial-draft="initialDraft"
        :ensure-started="async () => ready"
        :controls="controls"
        hide-workspace-context
      >
        <template #model>
          <ModelThinkingSelect
            v-model="modelKey"
            :thinking-level="session.thinkingLevel"
            :available-thinking="session.availableThinking"
            :models="session.models"
            :disabled="!ready && session.models.length === 0"
            @update:thinking-level="onThinkingChange"
          />
        </template>
      </ChatComposer>
      <!-- 只在激活态渲染：隐藏的 Tab 不该抢焦点；未答询问由侧栏标题出标记。 -->
      <ExtensionDialog v-if="active" :session-id="runtimeId" />
    </template>
  </div>
</template>
