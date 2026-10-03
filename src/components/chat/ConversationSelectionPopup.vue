<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Check, Trash2 } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

/**
 * 划词批注弹窗（编辑态）：单行布局——输入框 + 删除/保存图标按钮；
 * Esc 或点击外部等同取消（不做修改）。位置由父层传入的划词结束锚点（视口坐标）决定。
 */
export interface SelectionPopupState {
  comment: string
  anchor: { left: number; top: number; bottom: number }
}
const props = defineProps<{ state: (SelectionPopupState & { id?: string }) | null }>()
const emit = defineEmits<{
  save: [comment: string]
  remove: []
  cancel: []
}>()
const { t } = useI18n()

const comment = ref("")
const card = ref<HTMLElement | null>(null)

watch(
  () => props.state,
  state => {
    comment.value = state?.comment ?? ""
    if (state) void nextTick(() => card.value?.querySelector("textarea")?.focus())
  },
  { immediate: true },
)

function save() {
  emit("save", comment.value)
}
function onCancel() {
  emit("cancel")
}
function onDocumentMousedown(event: MouseEvent) {
  if (!props.state || !card.value) return
  if (card.value.contains(event.target as Node)) return
  onCancel()
}
document.addEventListener("mousedown", onDocumentMousedown)
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocumentMousedown))

// 卡片固定宽 288px（w-72），横向钳制在视口内；默认在划词末行下方，空间不足翻到上方。
const style = computed(() => {
  const anchor = props.state?.anchor
  if (!anchor) return null
  const margin = 8
  const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - 288 - margin))
  const flip = window.innerHeight - anchor.bottom < 90
  return {
    left: `${left}px`,
    ...(flip ? { bottom: `${window.innerHeight - anchor.top + 6}px` } : { top: `${anchor.bottom + 6}px` }),
  }
})
</script>

<template>
  <div v-if="state && style" ref="card" class="fixed z-50 w-72" :style="style" @mousedown.prevent>
    <div class="flex items-center gap-1 rounded-lg border bg-background p-1 shadow-md">
      <Textarea
        v-model="comment"
        data-selection-draft
        :placeholder="t('chat.selectionCommentPlaceholder')"
        rows="1"
        class="max-h-24 min-h-8 flex-1 resize-none text-xs"
        @keydown.esc.stop="onCancel"
        @keydown.ctrl.enter.prevent="save"
        @keydown.meta.enter.prevent="save"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        class="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        :title="t('chat.selectionDelete')"
        :aria-label="t('chat.selectionDelete')"
        @click="emit('remove')"
        ><Trash2 class="size-4"
      /></Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        class="text-primary size-7 shrink-0"
        :title="t('chat.selectionSave')"
        :aria-label="t('chat.selectionSave')"
        @click="save"
        ><Check class="size-4"
      /></Button>
    </div>
  </div>
</template>
