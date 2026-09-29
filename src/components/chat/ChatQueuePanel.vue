<script setup lang="ts">
import { nextTick, ref } from "vue"
import { useI18n } from "vue-i18n"
import { GripVertical, Pencil, Trash2 } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { focusComposer } from "@/lib/composer"
import { sendCountdown } from "@/lib/sendCountdown"
import { useCountdownNow } from "@/composables/useCountdownNow"
import type { SessionStore } from "@/stores/session"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"

const props = defineProps<{
  session: SessionStore
  bridge: InstanceType<typeof PromptInputBridge> | null
  gitBusy: boolean
  connecting: boolean
  connected: boolean
  editBusy: boolean
}>()

const { t } = useI18n()

const draggedPrompt = ref<number | null>(null)

function startQueueDrag(event: DragEvent, id: number) {
  draggedPrompt.value = id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", String(id))
  }
}

function dropQueuedPrompt(targetId: number) {
  if (draggedPrompt.value !== null) props.session.moveQueuedPrompt(draggedPrompt.value, targetId)
  draggedPrompt.value = null
}

async function editQueuedPrompt(id: number) {
  const item = props.session.removeQueuedPrompt(id)
  const bridge = props.bridge
  if (!item || !bridge) return
  // Keep any draft already being composed rather than silently discarding it.
  const draft = bridge.textInput
  bridge.setTextInput([draft, item.text].filter(Boolean).join("\n\n"))
  for (const [index, image] of (item.images ?? []).entries()) {
    const bytes = Uint8Array.from(atob(image.data), char => char.charCodeAt(0))
    bridge.addFiles([new File([bytes], `queued-image-${index + 1}`, { type: image.mimeType })])
  }
  await nextTick()
  focusComposer()
}

const queueNow = useCountdownNow(() => props.session.promptQueue.some(item => item.sendAt !== undefined))
</script>

<template>
  <section class="mb-2 rounded-xl border border-border bg-card/80 px-3 py-2" :aria-label="t('chat.queuedPrompts')">
    <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{{ t("chat.queuedPrompts") }} · {{ session.promptQueue.length }}</span>
      <Button
        v-if="!session.isStreaming"
        type="button"
        size="sm"
        variant="ghost"
        @click="session.dispatchQueuedPrompt()"
        >{{ t("chat.resumeQueue") }}</Button
      >
    </div>
    <ul class="mt-1 max-h-40 overflow-y-auto">
      <li
        v-for="item in session.promptQueue"
        :key="item.id"
        class="flex min-w-0 flex-wrap items-center gap-2 rounded-lg px-1 py-2 text-sm hover:bg-muted"
        :class="{ 'opacity-50': draggedPrompt === item.id }"
        @dragover.prevent
        @drop.prevent.stop="dropQueuedPrompt(item.id)"
      >
        <span
          draggable="true"
          class="shrink-0 cursor-grab p-1"
          :title="t('chat.dragQueue')"
          @dragstart="startQueueDrag($event, item.id)"
          @dragend="draggedPrompt = null"
          ><GripVertical class="size-4"
        /></span>
        <div class="min-w-0 flex-1 basis-40 space-y-1">
          <p class="truncate text-foreground" :title="item.text">
            {{ item.text || t("chat.queuedImages", { count: item.images?.length ?? 0 }) }}
          </p>
          <p v-if="item.text && item.images?.length" class="text-xs text-muted-foreground">
            {{ t("chat.queuedImages", { count: item.images.length }) }}
          </p>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-1">
          <span
            v-if="item.sendAt !== undefined"
            class="mr-1 text-xs tabular-nums text-muted-foreground"
            :title="t('chat.scheduledSendAt', { time: new Date(item.sendAt).toLocaleString() })"
            :aria-label="t('chat.sendCountdown', { time: sendCountdown(item.sendAt, queueNow) })"
            >{{ sendCountdown(item.sendAt, queueNow) }}</span
          >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :disabled="gitBusy || connecting || !connected || editBusy || session.isResending || session.isCompacting"
            @click="session.executeQueuedPrompt(item.id)"
            >{{ t("chat.executeQueuedPrompt") }}</Button
          >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            :aria-label="t('chat.editQueuedPrompt')"
            @click="editQueuedPrompt(item.id)"
            ><Pencil class="size-3"
          /></Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            :aria-label="t('chat.deleteQueuedPrompt')"
            @click="session.removeQueuedPrompt(item.id)"
            ><Trash2 class="size-3"
          /></Button>
        </div>
      </li>
    </ul>
  </section>
</template>
