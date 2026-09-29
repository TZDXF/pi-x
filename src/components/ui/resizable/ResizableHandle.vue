<script setup lang="ts">
import type { SplitterResizeHandleProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SplitterResizeHandle } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<
  SplitterResizeHandleProps & { class?: HTMLAttributes['class'] }
>()

const delegatedProps = reactiveOmit(props, 'class')
</script>

<template>
  <SplitterResizeHandle
    data-slot="resizable-handle"
    v-bind="delegatedProps"
    :class="
      cn(
                'relative shrink-0 bg-border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-primary data-[panel-group-direction=horizontal]:h-full data-[panel-group-direction=horizontal]:w-px data-[panel-group-direction=horizontal]:cursor-col-resize data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:cursor-row-resize',
        props.class,
      )
    "
  >
    <slot />
  </SplitterResizeHandle>
</template>
