<script setup lang="ts">
import type { ScrollAreaRootProps } from 'reka-ui'
import { computed, ref, type HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import {
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaViewport,
} from 'reka-ui'
import { cn } from '@/lib/utils'
import ScrollBar from './ScrollBar.vue'

const props = withDefaults(defineProps<ScrollAreaRootProps & { class?: HTMLAttributes['class']; viewportClass?: HTMLAttributes['class']; orientation?: 'vertical' | 'horizontal' | 'both' }>(), { orientation: 'vertical' })

const root = ref<InstanceType<typeof ScrollAreaRoot> | null>(null)
const emit = defineEmits<{ viewportScroll: [event: Event] }>()
defineExpose({ viewport: computed(() => root.value?.viewport ?? null) })

const delegatedProps = reactiveOmit(props, 'class', 'viewportClass', 'orientation')
</script>

<template>
  <ScrollAreaRoot
    ref="root"
    data-slot="scroll-area"
    v-bind="delegatedProps"
    :class="cn('relative min-h-0 min-w-0 overflow-hidden', props.class)"
  >
    <ScrollAreaViewport
      data-slot="scroll-area-viewport"
      @scroll="emit('viewportScroll', $event)"
      :class="cn('size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1 [&>div]:!block [&>div]:min-w-0', props.viewportClass)"
    >
      <slot />
    </ScrollAreaViewport>
    <ScrollBar v-if="orientation !== 'horizontal'" />
    <ScrollBar v-if="orientation !== 'vertical'" orientation="horizontal" />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
