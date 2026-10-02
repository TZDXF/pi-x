<script setup lang="ts">
import { useI18n } from "vue-i18n"
defineProps<{ height: number }>()
defineEmits<{
  "resize-start": [event: PointerEvent]
  "resize-move": [event: PointerEvent]
  "resize-end": []
}>()
const { t } = useI18n()
</script>

<template>
  <div class="absolute inset-x-0 bottom-0 z-20 flex flex-col border-t bg-background" :style="{ height: `${height}px` }">
    <div
      class="absolute inset-x-0 -top-1.5 z-20 h-3 cursor-row-resize touch-none"
      :title="t('browser.resizeDrawer')"
      @pointerdown="$emit('resize-start', $event)"
      @pointermove="$emit('resize-move', $event)"
      @pointerup="$emit('resize-end')"
      @pointercancel="$emit('resize-end')"
    >
      <div class="mx-auto h-1 w-10 translate-y-1 rounded-full bg-muted-foreground/30"></div>
    </div>
    <slot />
  </div>
</template>
