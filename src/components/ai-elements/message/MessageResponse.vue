<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { computed, useSlots } from 'vue'
import { Markdown } from 'vue-stream-markdown'
import { markdownLinkOptions } from '@/lib/linkOptions'
import 'vue-stream-markdown/index.css'

interface Props {
  content?: string
  class?: HTMLAttributes['class']
  /** 代码块是否默认自动换行（vue-stream-markdown 无内置配置，通过样式实现） */
  wrapCode?: boolean
}

const props = withDefaults(defineProps<Props>(), { wrapCode: true })

const slots = useSlots()
const slotContent = computed<string | undefined>(() => {
  const nodes = slots.default?.()
  if (!Array.isArray(nodes)) {
    return undefined
  }
  let text = ''
  for (const node of nodes) {
    if (typeof node.children === 'string')
      text += node.children
  }
  return text || undefined
})

const md = computed(() => (slotContent.value ?? props.content ?? '') as string)
</script>

<template>
  <Markdown
    :content="md"
    :link-options="markdownLinkOptions"
    :class="
      cn(
        'size-full [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!',
        props.wrapCode && '[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]',
        props.class,
      )
    "
    v-bind="$attrs"
  />
</template>
