<script setup lang="ts">
import type { SplitterPanelProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SplitterPanel } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<
  SplitterPanelProps & { class?: HTMLAttributes['class'] }
>()

const delegatedProps = reactiveOmit(props, 'class')
</script>

<template>
  <SplitterPanel
    data-slot="resizable-panel"
    v-bind="delegatedProps"
    :class="cn('min-w-0 overflow-hidden', props.class)"
  >
    <slot />
  </SplitterPanel>
</template>
