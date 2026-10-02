<script setup lang="ts">
import { computed } from "vue"
import { parseSubagentWidget } from "@/lib/subagents"
import SubagentsStatus from "@/components/chat/SubagentsStatus.vue"

/**
 * Generic renderer for extension widgets (setWidget). Plugin-specific widget
 * payloads (e.g. npm:pi-subagents run snapshots) are detected and delegated
 * here — this component itself stays plugin-agnostic.
 */
const props = defineProps<{ lines: string[] }>()

const content = computed(() => parseSubagentWidget(props.lines))
</script>

<template>
  <div class="border-border bg-muted/40 text-xs">
    <!-- Plugin run status (currently npm:pi-subagents) -->
    <SubagentsStatus v-if="content.snapshot" :snapshot="content.snapshot" />
    <!-- Plain widget lines keep their previous rendering -->
    <div
      v-if="content.plainLines.length"
      class="font-mono whitespace-pre-wrap"
      :class="content.snapshot ? 'text-muted-foreground px-4 pb-2' : 'px-4 py-2'"
    >
      {{ content.plainLines.join("\n") }}
    </div>
  </div>
</template>
