<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronUp, Pencil, TextQuote, Trash2 } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import type { PendingConversationSelection } from "@/lib/conversationSelections"

/**
 * composer 上方的划词引用摘要：折叠时只显示"N 条注释"，悬停展开列表——
 * 点击条目定位到消息里的索引标记，可编辑、删除。
 * 列表 Teleport 到 body 用 fixed 定位，避免被 composer 输入框遮挡。
 */
const props = defineProps<{ items: PendingConversationSelection[] }>()
const emit = defineEmits<{
  locate: [id: string]
  edit: [id: string]
  remove: [id: string]
}>()
const { t } = useI18n()
const open = ref(false)
const trigger = ref<HTMLElement | null>(null)
let closeTimer: ReturnType<typeof setTimeout> | undefined
function openList() {
  if (closeTimer !== undefined) {
    clearTimeout(closeTimer)
    closeTimer = undefined
  }
  open.value = true
}
function scheduleClose() {
  if (closeTimer !== undefined) clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    open.value = false
    closeTimer = undefined
  }, 150)
}
function locate(id: string) {
  open.value = false
  emit("locate", id)
}
function edit(id: string) {
  open.value = false
  emit("edit", id)
}
function remove(id: string) {
  open.value = false
  emit("remove", id)
}
// 列表固定宽 320px（w-80），默认在触发按钮上方展开，空间不足翻到下方。
const style = computed(() => {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect || !open.value) return null
  const margin = 8
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - 320 - margin))
  const flip = rect.top < 300
  return {
    left: `${left}px`,
    ...(flip ? { top: `${rect.bottom + 4}px` } : { bottom: `${window.innerHeight - rect.top + 4}px` }),
  }
})
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 py-1 pr-2 pl-2 text-xs hover:bg-accent"
    :aria-expanded="open"
    @mouseenter="openList"
    @mouseleave="scheduleClose"
    @click="open ? scheduleClose() : openList()"
  >
    <TextQuote class="size-3.5 shrink-0 text-muted-foreground" />
    <span class="shrink-0">{{ t("chat.selectionSummary", { count: items.length }) }}</span>
    <ChevronUp class="size-3 shrink-0 text-muted-foreground" :class="{ 'rotate-180': open }" />
  </button>
  <Teleport to="body">
    <div
      v-if="open && style"
      class="fixed z-50 max-h-72 w-80 overflow-auto rounded-lg border bg-background p-1 shadow-md"
      :style="style"
      @mouseenter="openList"
      @mouseleave="scheduleClose"
    >
      <div
        v-for="(item, index) in items"
        :key="item.id"
        class="group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent"
      >
        <span class="selection-anchor-badge" aria-hidden="true">{{ index + 1 }}</span>
        <button type="button" class="min-w-0 flex-1 text-left" :title="item.text" @click="locate(item.id)">
          <span class="block text-[10px] text-muted-foreground">{{
            item.source === "user" ? t("chat.selectionFromUser") : t("chat.selectionFromAssistant")
          }}</span>
          <span class="block truncate text-xs">{{ item.text }}</span>
          <span v-if="item.comment" class="block truncate text-xs text-muted-foreground">{{ item.comment }}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground size-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          :title="t('chat.selectionEdit')"
          :aria-label="t('chat.selectionEdit')"
          @click="edit(item.id)"
          ><Pencil class="size-3.5"
        /></Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground size-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          :title="t('chat.selectionDelete')"
          :aria-label="t('chat.selectionDelete')"
          @click="remove(item.id)"
          ><Trash2 class="size-3.5"
        /></Button>
      </div>
    </div>
  </Teleport>
</template>
