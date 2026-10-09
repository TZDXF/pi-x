<script setup lang="ts">
import { computed, ref } from "vue"
import { ChevronRight, CircleAlert, LoaderCircle, Wrench } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { toolGroupStatus } from "@/lib/toolCallGroups"
import type { ToolCallBlock, ToolRun } from "@/stores/conversations"

const props = defineProps<{
  blocks: ToolCallBlock[]
  runs: Record<string, ToolRun>
}>()
const { t } = useI18n()
const expanded = ref(false)
const status = computed(() => toolGroupStatus(props.blocks, props.runs))
</script>

<template>
  <div class="not-prose min-w-0">
    <button
      type="button"
      class="flex max-w-full items-center gap-2 rounded-md py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <LoaderCircle v-if="status.running" class="size-3.5 shrink-0 animate-spin" />
      <Wrench v-else class="size-3.5 shrink-0" />
      <Shimmer v-if="status.running" :duration="1">{{ t("blocks.toolsRunning", { count: blocks.length }) }}</Shimmer>
      <span v-else>{{ t("blocks.toolsCompleted", { count: blocks.length }) }}</span>
      <span v-if="status.errors" class="inline-flex items-center gap-1 text-xs text-destructive">
        <CircleAlert class="size-3.5 shrink-0" />
        {{ t("blocks.toolsFailed", { count: status.errors }) }}
      </span>
      <ChevronRight class="size-3.5 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''" />
    </button>
    <div v-if="expanded" class="mt-2 border-l border-border pl-3">
      <slot />
    </div>
  </div>
</template>
