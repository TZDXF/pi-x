<script setup lang="ts">
import type { SplitterPanelProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { ref } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SplitterPanel } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<
  SplitterPanelProps & { class?: HTMLAttributes['class'] }
>()

const delegatedProps = reactiveOmit(props, 'class')

const panel = ref()

// reka 未提供跨组件的受控尺寸，转发命令式 API 供折叠与键盘调整使用。
defineExpose({
  collapse: () => panel.value?.collapse(),
  expand: () => panel.value?.expand(),
  getSize: (): number | null => panel.value?.getSize() ?? null,
  resize: (size: number) => panel.value?.resize(size),
})
</script>

<template>
  <SplitterPanel
    ref="panel"
    data-slot="resizable-panel"
    v-bind="delegatedProps"
    :class="cn('min-w-0 overflow-hidden', props.class)"
  >
    <slot />
  </SplitterPanel>
</template>
