<script setup lang="ts">
import { computed, ref, toRefs, type ComponentPublicInstance } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronRight, Copy, MessageSquareQuote, Pencil, TextQuote } from "@lucide/vue"
import { MessageContent, MessageActions, MessageAction } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { parseComposerPromptContexts } from "@/lib/promptContexts"
import type { ParsedCodeComment } from "@/lib/codeComments"
import ComposerText from "@/components/ComposerText.vue"
import { formatMessageTime } from "@/lib/format"
import type { UserEntry } from "@/stores/session"
import type { usePromptEdit, PromptEditTextarea } from "@/composables/usePromptEdit"
import type { UnwrapRef } from "vue"

const props = defineProps<{ entry: UserEntry; edit: UnwrapRef<ReturnType<typeof usePromptEdit>> }>()
const emit = defineEmits<{
  previewImage: [url: string]
  copyText: [text: string]
  editTextarea: [textarea: PromptEditTextarea | null]
  openCodeComment: [comment: ParsedCodeComment]
}>()
const { t } = useI18n()
const { editedPrompt, editedText, editBusy, editBlocked, lastUserPromptId } = toRefs(props.edit)
const { startEditPrompt, cancelEditedPrompt, resendEditedPrompt } = props.edit
function bindEditTextarea(value: Element | ComponentPublicInstance | null) {
  emit("editTextarea", value as PromptEditTextarea | null)
}
// 持久化消息带会话引用附加段及 "# userselect:" / "# Code comments:" 尾块，以及 aux 的
// `<aux_parent_context>` 前置块；重载历史时解析回附件，气泡只显示用户原文
// （同 ZCode ConversationRowView 的 parseComposerPromptContexts）。
const parsedPrompt = computed(() => parseComposerPromptContexts(props.entry.contextText ?? props.entry.text))
// 折叠块内文：历史重建时已拆出来（`entry.parentContext`），实时消息则从 contextText 里解析。
const parentContext = computed(() => props.entry.parentContext ?? parsedPrompt.value.parentContext)
// 复制只给可见正文：父上下文块不属于用户写的问题（§4 验收）。
// `entry.text` 在两种形态下都已是可见正文（实时回显取用户输入、历史重建取拆分结果），
// 仍然过一遍解析器，保证与展示走同一套契约 —— 别在这里另写一份剥离逻辑。
const visibleText = computed(() => parseComposerPromptContexts(props.entry.text).visibleContent)
const parentContextOpen = ref(false)
</script>

<template>
  <!-- 图片独立排列在提问气泡上方，避免受正文宽度限制。 -->
  <div v-if="entry.images?.length" class="mb-2 flex max-w-full flex-wrap justify-end gap-2">
    <button
      v-for="(im, i) in entry.images"
      :key="i"
      type="button"
      class="border-border bg-muted relative size-16 shrink-0 cursor-zoom-in overflow-hidden rounded-md border transition-opacity hover:opacity-90"
      :title="t('chat.previewImage')"
      :aria-label="t('chat.previewImage')"
      @click="emit('previewImage', im.url)"
    >
      <img :src="im.url" class="size-full object-cover" alt="" loading="lazy" />
    </button>
  </div>
  <MessageContent>
    <div class="text-sm">
      <div v-if="editedPrompt?.id === entry.id" class="w-[min(36rem,75vw)] space-y-2">
        <Textarea
          :ref="bindEditTextarea"
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
          <Button type="button" variant="outline" size="sm" :disabled="editBusy" @click="cancelEditedPrompt">{{
            t("chat.editCancel")
          }}</Button>
          <Button
            type="button"
            size="sm"
            :disabled="editBlocked || (!editedText.trim() && !entry.images?.length)"
            @click="resendEditedPrompt"
            >{{ t("chat.editResend") }}</Button
          >
        </div>
      </div>
      <ComposerText v-else :text="parsedPrompt.visibleContent" />
      <!-- aux 父上下文折叠块：默认收起、可展开（§4 折叠块 b-1）。它在 prompt 里位于
           最前，但在气泡里放在提问正文下方，避免压住用户真正写的问题。 -->
      <div v-if="parentContext" class="mt-1.5 w-[min(36rem,75vw)]" data-aux-parent-context>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-ring"
          :aria-expanded="parentContextOpen"
          data-aux-parent-context-toggle
          @click="parentContextOpen = !parentContextOpen"
        >
          <ChevronRight
            class="size-3.5 shrink-0 transition-transform"
            :class="parentContextOpen ? 'rotate-90' : 'rotate-0'"
          />
          {{ t("chat.parentContext") }}
        </button>
        <pre
          v-if="parentContextOpen"
          class="mt-1.5 max-h-80 overflow-auto rounded-md border bg-muted/30 p-2 text-xs whitespace-pre-wrap"
          data-aux-parent-context-body
          >{{ parentContext }}</pre>
      </div>
      <!-- 历史消息里解析回的划词引用：只读展示，样式对齐 composer 的待发送 chips -->
      <div v-if="parsedPrompt.selections.length" class="mt-1.5 flex flex-wrap gap-1.5">
        <div
          v-for="s in parsedPrompt.selections"
          :key="s.id"
          class="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 py-1 pr-2 pl-2 text-xs"
        >
          <TextQuote class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 truncate" :title="s.text">{{ s.text }}</span>
          <span v-if="s.comment" class="min-w-0 truncate text-muted-foreground" :title="s.comment">{{
            s.comment
          }}</span>
        </div>
      </div>
      <!-- 即时消息与历史消息使用同一批注标签；原生按钮支持键盘打开文件。 -->
      <div v-if="parsedPrompt.comments.length" class="mt-1.5 flex flex-wrap gap-1.5">
        <button
          v-for="c in parsedPrompt.comments"
          :key="c.id"
          type="button"
          data-code-comment-tag
          class="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-ring"
          :title="[c.path, c.selectedText, c.comment].filter(Boolean).join('\n')"
          @click="emit('openCodeComment', c)"
        >
          <MessageSquareQuote class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 truncate font-mono"
            >{{ c.path }}:{{ c.startLine }}<template v-if="c.endLine !== c.startLine">-{{ c.endLine }}</template></span
          >
          <span class="min-w-0 truncate text-muted-foreground" :title="c.comment">{{ c.comment }}</span>
        </button>
      </div>
    </div>
  </MessageContent>
  <MessageActions
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
    <MessageAction :tooltip="t('chat.copyPrompt')" @click="emit('copyText', visibleText)">
      <Copy />
    </MessageAction>
    <span v-if="entry.timestamp" class="ml-1 self-center text-xs text-muted-foreground">
      {{ formatMessageTime(entry.timestamp) }}
    </span>
  </MessageActions>
</template>
