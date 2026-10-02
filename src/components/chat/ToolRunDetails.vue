<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { ScrollArea } from "@/components/ui/scroll-area"

defineProps<{ input?: string; output?: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="space-y-2 text-xs">
    <div v-if="input">
      <div class="text-muted-foreground mb-1 font-medium">{{ t("blocks.input") }}</div>
      <ScrollArea class="bg-muted rounded-md" viewport-class="max-h-40">
        <pre class="p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{{ input }}</pre>
      </ScrollArea>
    </div>
    <div v-if="output">
      <div class="text-muted-foreground mb-1 font-medium">{{ t("blocks.output") }}</div>
      <ScrollArea class="bg-muted rounded-md" viewport-class="max-h-60">
        <pre class="p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{{ output }}</pre>
      </ScrollArea>
    </div>
  </div>
</template>
