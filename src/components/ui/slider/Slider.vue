<script setup lang="ts">
import type { SliderRootEmits, SliderRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * `marks` turns the slider into a stepped slider: one clickable node per stop
 * (min 0, max marks.length - 1), overlapping the track ends. Only rendered
 * with more than one mark.
 */
const props = withDefaults(defineProps<SliderRootProps & { class?: HTMLAttributes['class'], marks?: string[] }>(), {
  marks: () => [],
})
const emits = defineEmits<SliderRootEmits>()

const delegatedProps = reactiveOmit(props, 'class', 'marks')
const forwarded = useForwardPropsEmits(delegatedProps, emits)

const currentIndex = computed(() => Math.round(props.modelValue?.[0] ?? 0))

/** Center of stop i, matching reka-ui's 16px thumb placement: +8px → -8px. */
function markLeft(i: number, count: number) {
  const fraction = count > 1 ? i / (count - 1) : 0
  return `calc(${fraction * 100}% + ${8 * (1 - 2 * fraction)}px)`
}

/** Stop i's shade: one hue (primary), fading in from 30% up to full strength. */
function markShade(i: number, count: number) {
  const pct = count > 1 ? Math.round(30 + (70 * i) / (count - 1)) : 100
  return `color-mix(in oklab, var(--primary) ${pct}%, var(--background))`
}

/** Stepped fill: gradient from the first stop's shade to the current one. */
const rangeStyle = computed(() =>
  props.marks.length > 1
    ? {
        background: `linear-gradient(to right, ${markShade(0, props.marks.length)}, ${markShade(
          Math.min(currentIndex.value, props.marks.length - 1),
          props.marks.length,
        )})`,
      }
    : undefined,
)

function onMarkClick(i: number) {
  emits('update:modelValue', [i])
}
</script>

<template>
  <SliderRoot
    data-slot="slider"
    v-bind="forwarded"
    :class="cn('relative flex w-full touch-none items-center select-none data-disabled:opacity-50', props.class)"
  >
    <SliderTrack
      data-slot="slider-track"
      class="bg-muted relative mx-2 h-3.5 grow overflow-hidden rounded-full"
    >
      <SliderRange data-slot="slider-range" class="bg-primary absolute h-full" :style="rangeStyle" />
    </SliderTrack>
    <template v-if="marks.length > 1">
      <button
        v-for="(mark, i) in marks"
        :key="mark + '-' + i"
        type="button"
        tabindex="-1"
        :title="mark"
        :aria-label="mark"
        :class="i <= currentIndex ? '' : 'bg-muted-foreground/40'"
        :style="{
          left: markLeft(i, marks.length),
          backgroundColor: i <= currentIndex ? markShade(i, marks.length) : undefined,
        }"
        class="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background shadow-sm transition-[width,height,background-color] hover:size-4.5"
        @pointerdown.stop
        @click="onMarkClick(i)"
      />
    </template>
    <SliderThumb
      v-for="(_, index) in modelValue"
      :key="index"
      data-slot="slider-thumb"
      class="border-primary bg-background ring-ring/50 block size-4 shrink-0 rounded-full border shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
    />
  </SliderRoot>
</template>
