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

const outputTokens = computed(() => usage.value?.outputTokens ?? 0)

const outputTokensPercent = computed(() => {
  if (!maxTokens.value || !outputTokens.value)
    return undefined
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(outputTokens.value / maxTokens.value)
})
const outputCostText = computed(() => {
  if (!modelId.value || !outputTokens.value)
    return undefined

  const outputCost = getUsage({
    modelId: modelId.value,
    usage: { input: 0, output: outputTokens.value },
  }).costUSD?.totalUSD

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(outputCost ?? 0)
})
</script>

<template>
  <slot v-if="$slots.default" />
  <div
    v-else-if="outputTokens > 0"
    :class="
      cn('flex items-center justify-between text-xs', props.class)
    "
    v-bind="$attrs"
  >
    <span class="text-muted-foreground">Output</span>
    <span>
      <TokensWithCost :cost-text="outputCostText" :tokens="outputTokens" />
      <span v-if="outputTokensPercent" class="ml-2 text-muted-foreground">· {{ outputTokensPercent }}</span>
    </span>
  </div>
</template>
