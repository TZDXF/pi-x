<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { computed, useSlots } from 'vue'
import { Markdown } from 'vue-stream-markdown'
import { markdownLinkOptions } from '@/lib/linkOptions'
import { markdownParserOptions } from '@/lib/markdownAutoLink'
import { markdownCodeWrapClass, markdownCodeWrapControls } from '@/lib/markdownCodeWrap'
import 'vue-stream-markdown/index.css'

interface Props {
  content?: string
  streaming?: boolean
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), { streaming: false })

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
    :mode="props.streaming ? 'streaming' : 'static'"
    :link-options="markdownLinkOptions"
    :parser-options="markdownParserOptions"
    :controls="markdownCodeWrapControls"
    :class="
      cn(
        'size-full [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!',
        markdownCodeWrapClass,
        props.class,
      )
    "
    v-bind="$attrs"
  />
</template>
