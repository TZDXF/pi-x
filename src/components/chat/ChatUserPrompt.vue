<script setup lang="ts">
import { computed, toRefs, type ComponentPublicInstance } from "vue"
import { useI18n } from "vue-i18n"
import { Copy, MessageSquareQuote, Pencil, TextQuote } from "@lucide/vue"
import { MessageContent, MessageActions, MessageAction } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { parseComposerPromptContexts } from "@/lib/promptContexts"
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
}>()
const { t } = useI18n()
const { editedPrompt, editedText, editBusy, editBlocked, lastUserPromptId } = toRefs(props.edit)
const { startEditPrompt, cancelEditedPrompt, resendEditedPrompt } = props.edit
function bindEditTextarea(value: Element | ComponentPublicInstance | null) {
  emit("editTextarea", value as PromptEditTextarea | null)
}
// 持久化消息的正文带 "# userselect:" / "# Code comments:" 尾块；重载历史时解析回附件，
// 气泡只显示用户原文（同 ZCode ConversationRowView 的 parseComposerPromptContexts）。
const parsedPrompt = computed(() => parseComposerPromptContexts(props.entry.text))
</script>

<template>
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
      <!-- 历史消息里解析回的代码批注：只读展示，样式对齐 composer 的待发送 chips -->
      <div v-if="parsedPrompt.comments.length" class="mt-1.5 flex flex-wrap gap-1.5">
        <div
          v-for="c in parsedPrompt.comments"
          :key="c.id"
          class="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 py-1 pr-2 pl-2 text-xs"
        >
          <MessageSquareQuote class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="shrink-0 font-mono"
            >{{ c.path }}:{{ c.startLine }}<template v-if="c.endLine !== c.startLine">-{{ c.endLine }}</template></span
          >
          <span class="min-w-0 truncate text-muted-foreground" :title="c.comment">{{ c.comment }}</span>
        </div>
      </div>
      <!-- sent attachments keep the composer's chip look: a small
           thumbnail, click to zoom, instead of large inline images -->
      <div v-if="entry.images?.length" class="mt-1.5 flex flex-wrap gap-2">
        <button
          v-for="(im, i) in entry.images"
          :key="i"
          type="button"
          class="border-border bg-muted relative size-16 cursor-zoom-in overflow-hidden rounded-md border transition-opacity hover:opacity-90"
          :title="t('chat.previewImage')"
          :aria-label="t('chat.previewImage')"
          @click="emit('previewImage', im.url)"
        >
          <img :src="im.url" class="size-full object-cover" alt="" loading="lazy" />
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
    <MessageAction :tooltip="t('chat.copyPrompt')" @click="emit('copyText', entry.text)">
      <Copy />
    </MessageAction>
    <span v-if="entry.timestamp" class="ml-1 self-center text-xs text-muted-foreground">
      {{ formatMessageTime(entry.timestamp) }}
    </span>
  </MessageActions>
</template>
