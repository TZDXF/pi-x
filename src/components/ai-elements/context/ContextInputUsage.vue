<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { getUsage } from 'tokenlens'
import { computed } from 'vue'
import { useContextValue } from './context'
import TokensWithCost from './TokensWithCost.vue'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const { usage, modelId, maxTokens } = useContextValue()

const inputTokens = computed(() => usage.value?.inputTokens ?? 0)

const inputTokensPercent = computed(() => {
  if (!maxTokens.value || !inputTokens.value)
    return undefined
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(inputTokens.value / maxTokens.value)
})
const inputCostText = computed(() => {
  if (!modelId.value || !inputTokens.value)
    return undefined

  const inputCost = getUsage({
    modelId: modelId.value,
    usage: { input: inputTokens.value, output: 0 },
  }).costUSD?.totalUSD

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(inputCost ?? 0)
})
</script>

<template>
  <slot v-if="$slots.default" />

  <div
    v-else-if="inputTokens > 0"
    :class="
      cn('flex items-center justify-between text-xs', props.class)
    "
    v-bind="$attrs"
  >
    <span class="text-muted-foreground">Input</span>
    <span>
      <TokensWithCost :cost-text="inputCostText" :tokens="inputTokens" />
      <span v-if="inputTokensPercent" class="ml-2 text-muted-foreground">· {{ inputTokensPercent }}</span>
    </span>
  </div>
</template>
