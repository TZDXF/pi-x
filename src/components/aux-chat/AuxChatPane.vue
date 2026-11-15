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
import { useAuxParentContext } from "@/composables/useAuxParentContext"
import { useChatTurnList } from "@/composables/useChatTurnList"
import { useAuxDraft } from "@/composables/useAuxDraft"
import { useConversationModel } from "@/composables/useConversationModel"
import { formatCodedError } from "@/lib/backendError"
import { retryAuxSpawn, type AuxParentContext } from "@/lib/auxSpawn"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"
import type { usePromptEdit } from "@/composables/usePromptEdit"
import { useWorkspaceStore } from "@/stores/workspace"
import type { AuxAskPayload } from "@/lib/auxSelection"
import { describeAuxAskResult } from "@/lib/auxAsk"
import { auxSessionFor, auxUiFor, type AuxTab } from "@/stores/auxChat"
import { addAuxSelection } from "@/stores/auxSelections"

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
/**
 * 面板是否还"连着进程"：`ready` **且** session store 认为进程在跑。
 *
 * 为什么不能只看 `tab.status`：后端确认退出后（`pi://exit`）`session.started` 会被
 * 置 false，但实例注册表里的 status 仍是 `ready`（关闭/销毁由关闭动作负责）。若只判
 * `ready`，用户会看到一个"能发但发不出去"的输入框 —— 那正是复审第四轮观察到的
 * "streaming 被清但 Tab 仍可发"的中间态。这里把两处状态绑在一起，退出即禁用发送。
 */
const connected = computed(() => ready.value && session.started)

// 父上下文只在**首轮**拼进 prompt（记账按 aux runtimeId；第 2/3 轮返回 null）。
const { parentContext } = useAuxParentContext({
  auxRuntimeId: props.tab.runtimeId,
  parentRuntimeId: props.parent.runtimeId,
  session,
})

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
  ensureStarted: async () => connected.value,
  newSession: () => {},
  onSent: jumpToBottom,
  // aux 读**自己的**引用桶（TZD-103）：代码批注（projects 级）仍一律视为空，
  // 发送成功后只清本桶，主会话的批注/引用互不影响。
  contexts: "aux",
  // 首轮带父会话已提交分支（`<aux_parent_context>` 折叠块，默认收起，TZD-102）。
  parentContext,
})
const controls = reactive(sendControl)

const { modelKey, onThinkingChange } = useConversationModel(session, {
  connected: () => connected.value,
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

/**
 * 面板内划词"在辅助对话中提问"：直接进**本实例**的桶。
 *
 * 同一个 Tab 内的两处入口（"引用到输入框"与"在辅助对话中提问"）必须落在同一桶，
 * 否则摘要会显示在另一个面板里。
 */
function onAuxAsk(payload: AuxAskPayload) {
  const result = addAuxSelection(props.tab.runtimeId, { ...payload, sourceRuntimeId: props.tab.runtimeId })
  const notice = result.ok
    ? describeAuxAskResult(t, { ok: true, duplicate: result.duplicate })
    : describeAuxAskResult(t, { ok: false, reason: "append", appendReason: result.reason })
  if (notice) ui.pushToast(notice.message, notice.kind)
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
        :aux-runtime-id="runtimeId"
        @history-scroll="onHistoryScroll"
        @navigate="navigateToQuestion"
        @copy-text="copyText"
        @aux-ask="onAuxAsk"
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
        :connected="connected"
        :edit-busy="false"
        :session-drag-over="false"
        :initial-draft="initialDraft"
        :ensure-started="async () => connected"
        :controls="controls"
        hide-workspace-context
        @locate-selection="conversation?.locateSelection($event)"
        @edit-selection="conversation?.editSelection($event)"
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
      </ChatComposer>
      <!-- 只在激活态渲染：隐藏的 Tab 不该抢焦点；未答询问由侧栏标题出标记。 -->
      <ExtensionDialog v-if="active" :session-id="runtimeId" />
    </template>
  </div>
</template>
