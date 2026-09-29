<script setup lang="ts">
import type { SplitterGroupProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SplitterGroup } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<
  SplitterGroupProps & { class?: HTMLAttributes['class'] }
>()

const delegatedProps = reactiveOmit(props, 'class')

const emit = defineEmits<{ layout: [sizes: number[]] }>()
</script>

<template>
  <SplitterGroup
    data-slot="resizable-panel-group"
    v-bind="delegatedProps"
    @layout="sizes => emit('layout', sizes)"
    :class="cn('flex h-full w-full', props.class)"
  >
    <slot />
  </SplitterGroup>
</template>
