<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ContextBreakdownPart } from "@/lib/contextBreakdown"
import { cn } from "@/lib/utils"
import { compactNumber, formatPercent } from "@/lib/format"
import { computed } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{
  parts: ContextBreakdownPart[]
  class?: HTMLAttributes["class"]
}>()

const { t } = useI18n()

const rows = computed(() =>
  props.parts.map(part => ({
    ...part,
    label: t(`chat.contextParts.${part.key}`),
    percentText: formatPercent(part.percent),
    tokensText: compactNumber(part.tokens),
  })),
)
</script>

<template>
  <div :class="cn('w-full', props.class)">
    <div class="space-y-1">
      <div v-for="row in rows" :key="row.key" class="flex items-center justify-between gap-3 text-xs">
        <span class="text-muted-foreground">{{ row.label }}</span>
        <span class="font-mono">
          {{ row.percentText }}
          <span class="text-muted-foreground">· {{ row.tokensText }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
