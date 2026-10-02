<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Bot, ChevronDown } from "@lucide/vue"
import { Loader } from "@/components/ai-elements/loader"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  subagentStateLabel,
  subagentStateView,
  subagentStateVisual,
  type SubagentRunStatus,
  type SubagentSnapshot,
} from "@/lib/subagents"

/**
 * Status panel for npm:pi-subagents async runs, rendered from a snapshot the
 * plugin pushes through its widget line. Presentation only — parsing and
 * plugin detection live in lib/subagents.
 */
const props = defineProps<{ snapshot: SubagentSnapshot }>()

const { t } = useI18n()

const runs = computed(() => props.snapshot.runs)

// ---- elapsed time: ticks only while at least one run is still going ----
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
const anyRunning = computed(() => runs.value.some(run => subagentStateView(run.state) === "running"))
watch(
  anyRunning,
  running => {
    if (running && clock === undefined)
      clock = setInterval(() => {
        now.value = Date.now()
      }, 1000)
    if (!running && clock !== undefined) {
      clearInterval(clock)
      clock = undefined
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  if (clock !== undefined) clearInterval(clock)
})

function elapsedText(run: SubagentRunStatus): string {
  if (subagentStateView(run.state) !== "running") return ""
  const ms = Math.max(0, now.value - run.startedAt)
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

// ---- collapsible: open while running, auto-collapse once all runs settle ----
const open = ref(true)
watch(anyRunning, running => {
  open.value = running
})
// A snapshot that arrives already finished (the final update) starts collapsed.
watch(
  () => runs.value.length > 0,
  hasRuns => {
    if (hasRuns && !anyRunning.value) open.value = false
  },
  { once: true },
)

/** Header summary, e.g. "运行中 2 · 已完成 1". */
const summaryText = computed(() => {
  const counts = new Map<string, number>()
  for (const run of runs.value) {
    const state = subagentStateView(run.state)
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  return [...counts.entries()].map(([state, count]) => `${subagentStateLabel(state, t)} ${count}`).join(" · ")
})
</script>

<template>
  <Collapsible v-model:open="open" class="mb-0 rounded-none border-0 text-xs">
    <div class="px-4 py-2">
      <CollapsibleTrigger
        class="flex w-full items-center gap-2 rounded text-left transition-colors hover:text-foreground"
        :aria-label="open ? t('piSubagents.collapse') : t('piSubagents.expand')"
      >
        <Bot class="size-3.5 shrink-0" :class="anyRunning ? 'text-primary' : 'text-muted-foreground'" />
        <span class="shrink-0 font-medium">{{ t("piSubagents.runs", { count: runs.length }) }}</span>
        <Loader v-if="anyRunning" :size="12" class="text-primary shrink-0" />
        <span class="text-muted-foreground min-w-0 flex-1 truncate" :title="summaryText">{{ summaryText }}</span>
        <ChevronDown
          class="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul class="mt-1.5 space-y-1">
          <li v-for="run in runs" :key="run.id" class="flex min-w-0 items-center gap-2">
            <span class="grid size-4 shrink-0 place-items-center" :class="subagentStateVisual(run.state).class">
              <Loader v-if="subagentStateView(run.state) === 'running'" :size="12" />
              <component :is="subagentStateVisual(run.state).icon" v-else class="size-3.5" />
            </span>
            <span class="min-w-0 flex-1 truncate font-medium">{{ run.label }}</span>
            <span class="text-muted-foreground shrink-0">{{ subagentStateLabel(run.state, t) }}</span>
            <span v-if="elapsedText(run)" class="w-10 shrink-0 text-right tabular-nums">{{ elapsedText(run) }}</span>
            <span v-if="run.children.length" class="text-muted-foreground/70 shrink-0">
              {{ t("piSubagents.steps", { count: run.children.length }) }}
            </span>
          </li>
        </ul>
      </CollapsibleContent>
    </div>
  </Collapsible>
</template>
