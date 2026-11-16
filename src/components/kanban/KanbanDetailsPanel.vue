<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"

const { t } = useI18n()
const panel = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
const ratio = ref(1 / 3)
const drag = ref<{ pointerId: number; x: number; width: number } | null>(null)
let observer: ResizeObserver | undefined

const minWidth = computed(() => Math.min(280, containerWidth.value))
const maxWidth = computed(() => Math.max(minWidth.value, containerWidth.value - 280))
const width = computed(() => clamp(containerWidth.value * ratio.value))

function clamp(value: number) {
  return Math.min(maxWidth.value, Math.max(minWidth.value, value))
}

function resize(value: number) {
  if (containerWidth.value > 0) ratio.value = clamp(value) / containerWidth.value
}

function startDrag(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return
  event.preventDefault()
  drag.value = { pointerId: event.pointerId, x: event.clientX, width: width.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function moveDrag(event: PointerEvent) {
  const start = drag.value
  if (start?.pointerId === event.pointerId) resize(start.width + start.x - event.clientX)
}

function stopDrag(event: PointerEvent) {
  if (drag.value?.pointerId !== event.pointerId) return
  drag.value = null
  const handle = event.currentTarget as HTMLElement
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
}

function resizeWithKeyboard(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  const step = event.shiftKey ? 32 : 16
  resize(
    event.key === "Home"
      ? minWidth.value
      : event.key === "End"
        ? maxWidth.value
        : width.value + (event.key === "ArrowLeft" ? step : -step),
  )
}

onMounted(() => {
  const container = panel.value?.parentElement
  if (!container) return
  containerWidth.value = container.getBoundingClientRect().width
  observer = new ResizeObserver(() => {
    containerWidth.value = container.getBoundingClientRect().width
    drag.value = null
  })
  observer.observe(container)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <aside
    id="kanban-details"
    ref="panel"
    class="kanban-details relative flex min-h-0 min-w-0 shrink-0 flex-col border-l bg-background"
    :class="{ 'select-none': drag }"
    :style="{ '--kanban-details-width': containerWidth ? `${width}px` : '33.333333%' }"
    :aria-label="t('kanban.detailsTitle')"
  >
    <div
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      aria-controls="kanban-details"
      :aria-label="t('kanban.resizeDetails')"
      :title="t('kanban.resizeDetails')"
      :aria-valuemin="Math.round(minWidth)"
      :aria-valuemax="Math.round(maxWidth)"
      :aria-valuenow="Math.round(width)"
      class="kanban-details-resize"
      :class="{ 'is-dragging': drag }"
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="stopDrag"
      @pointercancel="stopDrag"
      @lostpointercapture="stopDrag"
      @keydown="resizeWithKeyboard"
    />
    <slot />
  </aside>
</template>

<style scoped>
.kanban-details {
  width: var(--kanban-details-width);
}
.kanban-details-enter-active,
.kanban-details-leave-active {
  overflow: hidden;
  transition:
    width 240ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease,
    transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.kanban-details-leave-active {
  pointer-events: none;
}
.kanban-details-enter-from,
.kanban-details-leave-to {
  width: 0;
  opacity: 0;
  transform: translateX(16px);
}
.kanban-details-resize {
  position: absolute;
  z-index: 30;
  inset: 0 auto 0 -4px;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
.kanban-details-resize::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 3px;
  width: 2px;
  background: transparent;
  transition: background 120ms;
}
.kanban-details-resize:hover::after,
.kanban-details-resize:focus-visible::after,
.kanban-details-resize.is-dragging::after {
  background: var(--primary);
}
@media (max-width: 640px) {
  .kanban-details {
    position: absolute;
    inset: 0;
    z-index: 20;
    width: 100%;
    border-left: 0;
  }
  .kanban-details-resize {
    display: none;
  }
  .kanban-details-enter-active,
  .kanban-details-leave-active {
    transition-property: opacity, transform;
  }
  .kanban-details-enter-from,
  .kanban-details-leave-to {
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .kanban-details-enter-active,
  .kanban-details-leave-active {
    transition: none;
  }
}
</style>
