<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ContextBreakdownPart } from "@/lib/contextBreakdown"
import { cn } from "@/lib/utils"
import { computed } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{
  parts: ContextBreakdownPart[]
  class?: HTMLAttributes["class"]
}>()

const { t } = useI18n()

const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 })
const tokenFormatter = new Intl.NumberFormat("en-US", { notation: "compact" })

const rows = computed(() => props.parts.map(part => ({
  ...part,
  label: t(`chat.contextParts.${part.key}`),
  percentText: percentFormatter.format(part.percent),
  tokensText: tokenFormatter.format(part.tokens),
})))
</script>

<template>
  <div :class="cn('w-full', props.class)">
    <div class="space-y-1">
      <div
        v-for="row in rows"
        :key="row.key"
        class="flex items-center justify-between gap-3 text-xs"
      >
        <span class="text-muted-foreground">{{ row.label }}</span>
        <span class="font-mono">
          {{ row.percentText }}
          <span class="text-muted-foreground">· {{ row.tokensText }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
