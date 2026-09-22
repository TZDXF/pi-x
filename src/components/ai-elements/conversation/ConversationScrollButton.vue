<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { ArrowDownIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { computed, inject } from 'vue'
import { conversationKey } from './context'

interface Props {
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()
const { isAtBottom, scrollToBottom } = inject(conversationKey)!
const showScrollButton = computed(() => !isAtBottom.value)

function handleClick() {
  scrollToBottom()
}
</script>

<template>
  <Button
    v-if="showScrollButton"
    :class="cn(
      'absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted',
      props.class,
    )"
    aria-label="Scroll to bottom"
    size="icon"
    type="button"
    variant="outline"
    v-bind="$attrs"
    @click="handleClick"
  >
    <ArrowDownIcon class="size-4" />
  </Button>
</template>
