<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { Bot, ChevronDown } from "@lucide/vue"
import { Loader } from "@/components/ai-elements/loader"
import ToolRunDetails from "./ToolRunDetails.vue"
import { useToolRunClock, formatToolElapsed } from "@/composables/useToolRunClock"
import { subagentStateLabel, subagentStateView, subagentStateVisual, subagentToolTitle } from "@/lib/subagents"
import type { ToolCallBlock, ToolRun } from "@/stores/conversations"

/**
 * Queue-style display for a run of consecutive npm:pi-subagents delegation
 * tool calls. Presentation only — plugin knowledge lives in lib/subagents.
 */
const props = defineProps<{
  blocks: ToolCallBlock[]
  runs: Record<string, ToolRun>
}>()

const { t } = useI18n()

function runFor(block: ToolCallBlock): ToolRun | undefined {
  return props.runs[block.callId]
}

function titleFor(block: ToolCallBlock): string {
  return subagentToolTitle(block.argsText || runFor(block)?.argsText, t("piSubagents.workflowTool")) || block.name
}

function stateOf(block: ToolCallBlock): string {
  return runFor(block)?.state ?? "input-streaming"
}

// ---- elapsed time: ticks only while at least one run is still going ----
const now = useToolRunClock(() => props.blocks.some(block => subagentStateView(stateOf(block)) === "running"))

function elapsedText(block: ToolCallBlock): string {
  if (subagentStateView(stateOf(block)) !== "running") return ""
  const startedAt = runFor(block)?.startedAt
  if (!startedAt) return ""
  return formatToolElapsed(now.value - startedAt, false)
}

// Rows expand individually; collapsed by default like the tool cards they replace.
const expanded = ref<Set<string>>(new Set())
function toggle(callId: string) {
  const next = new Set(expanded.value)
  if (!next.delete(callId)) next.add(callId)
  expanded.value = next
}
</script>

<template>
  <section class="not-prose w-full overflow-hidden rounded-xl border border-border bg-card/80 px-3 py-2">
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <Bot class="size-3.5 shrink-0" />
      {{ t("piSubagents.runs", { count: blocks.length }) }}
    </div>
    <ul class="mt-1">
      <li v-for="block in blocks" :key="block.callId">
        <button
          type="button"
          class="flex min-w-0 w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-sm transition-colors hover:bg-muted"
          :aria-expanded="expanded.has(block.callId)"
          @click="toggle(block.callId)"
        >
          <span class="shrink-0" :class="subagentStateVisual(stateOf(block)).class">
            <Loader v-if="subagentStateView(stateOf(block)) === 'running'" :size="13" />
            <component :is="subagentStateVisual(stateOf(block)).icon" v-else class="size-3.5" />
          </span>
          <span class="min-w-0 flex-1 truncate" :title="titleFor(block)">{{ titleFor(block) }}</span>
          <span class="text-muted-foreground shrink-0 text-xs">{{ subagentStateLabel(stateOf(block), t) }}</span>
          <span v-if="elapsedText(block)" class="w-10 shrink-0 text-right text-xs tabular-nums">{{
            elapsedText(block)
          }}</span>
          <ChevronDown
            class="text-muted-foreground size-3.5 shrink-0 transition-transform"
            :class="expanded.has(block.callId) ? 'rotate-180' : ''"
          />
        </button>
        <ToolRunDetails
          v-if="expanded.has(block.callId)"
          class="px-1 pb-2"
          :input="block.argsText"
          :output="runFor(block)?.outputText"
        />
      </li>
    </ul>
  </section>
</template>
