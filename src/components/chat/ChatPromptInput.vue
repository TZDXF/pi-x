<script setup lang="ts">
import { computed, ref, type ComponentPublicInstance } from "vue"
import { useI18n } from "vue-i18n"
import { Paperclip } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { PromptInput, PromptInputHeader } from "@/components/ai-elements/prompt-input"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input/types"
import PromptInputBridge from "@/components/PromptInputBridge.vue"
import ComposerCompletion from "@/components/ComposerCompletion.vue"
import ComposerRichEditor from "@/components/ComposerRichEditor.vue"
import { isImageAttachment } from "@/lib/attachments"
import type { CommandInfo } from "@/api/protocol"
import type { WorkspaceSelection } from "@/api/piClient"

const props = defineProps<{
  initialDraft?: string
  placeholder?: string
  disabled?: boolean
  dragOver?: boolean
  commands?: CommandInfo[]
  completionOptions?: {
    sessionId: string
    project: string
    connected: boolean
    ensureStarted: (selection?: WorkspaceSelection | null) => Promise<boolean>
  }
  submit: (message: PromptInputMessage) => void | Promise<void>
}>()
const bridge = defineModel<InstanceType<typeof PromptInputBridge> | null>("bridge", { required: true })
const emit = defineEmits<{
  previewImage: [url: string | null]
  error: [error: { code: string; message: string }]
}>()
const { t } = useI18n()
const completion = ref<InstanceType<typeof ComposerCompletion> | null>(null)
const attachments = computed(() => bridge.value?.files ?? [])
function bindBridge(value: Element | ComponentPublicInstance | null) {
  bridge.value = value as InstanceType<typeof PromptInputBridge> | null
}
</script>

<template>
  <PromptInput
    :group-class="[
      'relative rounded-[22px] bg-card dark:bg-card p-2 shadow-[var(--composer-shadow)]',
      dragOver && 'outline-2 outline-dashed outline-primary outline-offset-[3px]',
    ]"
    :initial-input="initialDraft"
    @submit="props.submit"
    @error="emit('error', $event)"
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
          <span v-else class="text-muted-foreground flex h-full items-center justify-center p-1 text-[10px] break-all">
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
    <slot name="header" />
    <ComposerCompletion
      v-if="completionOptions"
      ref="completion"
      :session-id="completionOptions.sessionId"
      :project="completionOptions.project"
      :connected="completionOptions.connected"
      :ensure-started="completionOptions.ensureStarted"
    />
    <ComposerRichEditor
      :commands="commands ?? []"
      @input="completion?.onEditorEvent($event)"
      @click="completion?.onEditorEvent($event)"
      @keyup="completion?.onEditorEvent($event)"
      @select="completion?.onEditorEvent($event)"
      @focus="completion?.onEditorEvent($event)"
      @blur="completion?.onEditorEvent($event)"
      @compositionstart="completion?.onEditorEvent($event)"
      @compositionend="completion?.onEditorEvent($event)"
      @keydown.capture="completion?.onKeydown($event)"
      :placeholder="placeholder ?? t('chat.inputPlaceholder')"
      :disabled="disabled"
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
          :disabled="disabled"
          :title="t('chat.attachImage')"
          :aria-label="t('chat.attachImage')"
          @click="bridge?.openFileDialog?.()"
        >
          <Paperclip class="size-4.5" />
        </Button>
        <slot name="model" />
      </div>
      <div class="ml-auto flex max-w-full items-center justify-end gap-1">
        <slot name="actions" />
      </div>
    </div>
  </PromptInput>
</template>
